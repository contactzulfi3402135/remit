import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as db from './db.js';
import { Ledger, remainingCents } from './ledger.js';
import { recordContactTrial } from './engine.js';
import { checkDraft, gate, POLICY } from './policy.js';
import { PLAYBOOKS, type Playbook, type Segment } from './strategy.js';
import { money } from './score.js';

// Human desk for remit: escalations, disputes, over-limit plans and
// policy blocks — plus run history and what the playbook bandit has
// learned. Humans here can resolve disputes and pause/resume contact;
// nobody here can write off a balance (the agent has no such tool and
// neither does this page).

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export type QueueAction = 'resolve_dispute' | 'approve_plan' | 'resume' | 'keep_paused';

// Human authority is deliberately narrower than the buttons a generic
// queue might offer: an opt-out can never be "resumed" from this desk,
// only a dispute item can invoke dispute resolution, and only a stored
// offer_plan draft can be approved/sent.
export function allowedQueueActions(kind: string, detail?: unknown): QueueAction[] {
  if (kind === 'optout') return ['keep_paused'];
  if (kind === 'dispute') return ['resolve_dispute', 'keep_paused'];
  const draft = (detail as { draft?: { action?: unknown } } | null | undefined)?.draft;
  if (kind === 'policy' && draft?.action === 'offer_plan') return ['approve_plan', 'resume', 'keep_paused'];
  return ['resume', 'keep_paused'];
}

const QUEUE_ACTION_LABELS: Record<QueueAction, string> = {
  resolve_dispute: 'Dispute resolved',
  approve_plan: 'Approve & send plan',
  resume: 'Resume contact',
  keep_paused: 'Keep paused',
};

const STYLE = `body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;color:#16181d;background:#fff}
h1{font-size:20px;margin:0 0 4px} .sub{color:#5b6472;margin-bottom:16px} a{color:#0b5cad}
table{border-collapse:collapse;width:100%} th,td{border-bottom:1px solid #e3e6eb;padding:8px;text-align:left;vertical-align:top}
th{color:#5b6472;font-weight:600} form{display:inline}
button{font:inherit;padding:3px 10px;margin-right:6px;border:1px solid #b9c2cf;background:#f4f6f8;border-radius:4px;cursor:pointer}
button.go{background:#067647;border-color:#067647;color:#fff} .why{color:#3d4654;max-width:460px} .kpi{display:flex;gap:24px;margin:12px 0 20px}
.kpi div b{font-size:20px;display:block}`;

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style>${body}`;
}

function authorized(req: IncomingMessage): boolean {
  const password = process.env.REVIEW_PASSWORD;
  // Local development may run password-free; a production deployment
  // fails closed instead of exposing debtor/escalation controls.
  if (!password) return process.env.NODE_ENV !== 'production';
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  return Buffer.from(header.slice(6), 'base64').toString('utf8') === `remit:${password}`;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export async function serve(port: number, ledgerUrl: string): Promise<void> {
  await db.migrate();
  const ledger = new Ledger(ledgerUrl, process.env.LEDGER_TOKEN);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok\n'); return; }
      if (!authorized(req)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="remit"', 'content-type': 'text/plain' });
        res.end('authentication required\n');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        const [queue, stats] = await Promise.all([db.openQueue('live'), ledger.stats().catch(() => null)]);
        const invoices = await ledger.allInvoices().catch(() => []);
        const byId = new Map(invoices.map((i) => [i.id, i]));
        const items = queue.map((q) => {
          const inv = byId.get(String(q.invoice_id));
          const detail = (q.detail ?? {}) as Record<string, unknown>;
          const storedDraft = (detail.draft && typeof detail.draft === 'object')
            ? detail.draft as { message?: unknown; instalments?: Array<{ day?: unknown; amountCents?: unknown }> }
            : null;
          const draftMessage = typeof detail.draft === 'string' ? detail.draft : storedDraft?.message;
          const instalmentText = storedDraft?.instalments?.length
            ? `<br><i>Proposed plan: ${storedDraft.instalments.map((i) => `day ${esc(i.day)}: ${money(Number(i.amountCents ?? 0))}`).join('; ')}</i>`
            : '';
          return `<tr>
            <td><b>${esc(q.invoice_id)}</b><br>${esc(inv?.debtorName ?? '')}<br>${inv ? money(remainingCents(inv)) + ' open' : ''}</td>
            <td>${esc(q.kind)}</td>
            <td class="why">${esc(q.why)}${detail.reply ? `<br><i>Debtor: ${esc(detail.reply)}</i>` : ''}${draftMessage ? `<br><i>Blocked draft: ${esc(draftMessage)}</i>` : ''}${instalmentText}</td>
            <td>${allowedQueueActions(String(q.kind), q.detail).map((action) => `
              <form method="post" action="/act"><input type="hidden" name="qid" value="${esc(q.id)}"><button${action === 'keep_paused' ? '' : ' class="go"'} name="action" value="${action}">${QUEUE_ACTION_LABELS[action]}</button></form>`).join('')}
            </td></tr>`;
        }).join('');
        const kpi = stats ? `<div class="kpi">
          <div>World day<b>${stats.worldDay}</b></div>
          <div>Invoiced<b>${money(stats.invoicedCents)}</b></div>
          <div>Collected<b>${money(stats.collectedCents)}</b></div>
          <div>Open invoices<b>${stats.openCount}</b></div></div>` : '<div class="sub">Ledger unreachable.</div>';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('remit - escalations', `
          <h1>Remit — human desk</h1>
          <div class="sub">Disputes, opt-outs, over-limit plans and policy blocks land here. The agent never writes off a balance. <a href="/runs">Runs</a> · <a href="/learned">What the bandit learned</a></div>
          ${kpi}
          <table><tr><th>Invoice</th><th>Kind</th><th>Why it is here</th><th>Decide</th></tr>${items}</table>`));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/learned') {
        const rows = await db.allPlaybookStats('live');
        const items = rows.map((r) => {
          const contacts = Number(r.contacts), rewards = Number(r.rewards);
          const rate = contacts ? `${Math.round((rewards / contacts) * 100)}%` : '—';
          return `<tr><td>${esc(r.segment)}</td><td>${esc(r.playbook)}</td><td>${contacts}</td><td>${rewards}</td><td>${rate}</td></tr>`;
        }).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('remit - learned playbooks', `
          <h1>What the bandit learned</h1>
          <div class="sub">Payments within 7 days of a contact, per debtor segment and playbook. Remit explores 15% of the time and otherwise plays the winner. <a href="/">Desk</a> · <a href="/runs">Runs</a></div>
          <table><tr><th>Segment</th><th>Playbook</th><th>Contacts</th><th>Paid after</th><th>Rate</th></tr>${items}</table>`));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/runs') {
        const [runs, decisions] = await Promise.all([db.recentRuns(), db.recentDecisions(30)]);
        const runRows = runs.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.kind)}</td><td>${esc(r.scope)}</td><td>${esc(JSON.stringify(r.stats))}</td></tr>`).join('');
        const decRows = decisions.map((d) => `<tr><td>${esc(d.world_day)}</td><td>${esc(d.invoice_id)}</td><td>${esc(d.segment)}</td><td>${esc(d.playbook)}</td><td>${esc(d.outcome)}</td><td class="why">${esc(d.why)}</td></tr>`).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('remit - runs', `
          <h1>Runs</h1><div class="sub"><a href="/">Desk</a> · <a href="/learned">Learned</a></div>
          <table><tr><th>#</th><th>Kind</th><th>Scope</th><th>Stats</th></tr>${runRows}</table>
          <h1 style="margin-top:28px">Recent decisions</h1>
          <table><tr><th>Day</th><th>Invoice</th><th>Segment</th><th>Playbook</th><th>Outcome</th><th>Why</th></tr>${decRows}</table>`));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/act') {
        const form = await readForm(req);
        const qid = Number(form.get('qid'));
        const action = String(form.get('action') ?? '');
        const item = await db.queueItem(qid);
        if (item && !allowedQueueActions(String(item.kind), item.detail).includes(action as QueueAction)) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(`action ${action} is not allowed for queue kind ${String(item.kind)}\n`);
          return;
        }
        if (item) {
          const invoiceId = String(item.invoice_id);
          if (action === 'approve_plan') {
            const detail = (item.detail ?? {}) as Record<string, unknown>;
            const draft = checkDraft(detail.draft);
            if (draft.action !== 'offer_plan') throw new Error('stored queue draft is not a payment plan');
            const playbook = String(detail.playbook ?? '');
            if (!(PLAYBOOKS as readonly string[]).includes(playbook)) throw new Error('stored queue draft has no valid playbook');
            const segment = String(detail.segment ?? 'new') as Segment;
            const [inv, events, ledgerStats] = await Promise.all([
              ledger.invoice(invoiceId),
              ledger.invoiceEvents(invoiceId),
              ledger.stats(),
            ]);
            if (!inv || inv.status !== 'open') throw new Error('invoice is no longer open; plan was not sent');
            // Human approval waives only the balance threshold. Every
            // other rule is re-checked against today's balance/history.
            const verdict = gate(draft, inv, events, ledgerStats.worldDay, {
              ...POLICY,
              plan_human_above_cents: Number.MAX_SAFE_INTEGER,
            });
            if (!verdict.ok) throw new Error(`plan no longer passes policy: ${verdict.reason}`);
            await ledger.createPlan(invoiceId, draft.instalments ?? []);
            await ledger.logContact(invoiceId, playbook, playbook, draft.message);
            await recordContactTrial(ledger, 'live', invoiceId, ledgerStats.worldDay, segment, playbook as Playbook);
            await db.resolveQueue(qid, 'payment plan approved and sent by human');
          } else if (action === 'resolve_dispute') {
            await ledger.resolveDispute(invoiceId);
            await db.unsuppress('live', invoiceId);
            await db.resolveQueue(qid, 'dispute resolved by human; contact resumed');
          } else if (action === 'resume') {
            const inv = await ledger.invoice(invoiceId);
            if (inv?.status === 'escalated') await ledger.reopen(invoiceId);
            await db.unsuppress('live', invoiceId);
            await db.resolveQueue(qid, 'human resumed contact');
          } else if (action === 'keep_paused') {
            await db.resolveQueue(qid, 'human kept contact paused');
          }
        }
        res.writeHead(303, { location: '/' });
        res.end();
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`error: ${(err as Error).message}\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  console.log(`remit review page on :${port}`);
}
