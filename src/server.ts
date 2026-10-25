import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as db from './db.js';
import {
  Ledger,
  daysOverdue,
  latestPromise,
  remainingCents,
  type Debtor,
  type Invoice,
  type LedgerEvent,
  type LedgerStats,
} from './ledger.js';
import { recordContactTrial } from './engine.js';
import { checkDraft, gate, POLICY, replySignal } from './policy.js';
import { PLAYBOOKS, segmentOf, type Playbook, type Segment } from './strategy.js';
import { money } from './score.js';
import {
  defaultSettings,
  loadSettings,
  policyFromSettings,
  renderTemplate,
  saveSettings,
  scheduleStatus,
  type AgentSettings,
} from './settings.js';
import { sweep } from './sweep.js';

// Remit Control Room: overview, clients/invoices, human queue, learned
// playbooks, runs, and bounded operator settings. It is deliberately an
// operating desk, not a God-mode panel: there is no write-off, discount,
// threat language, delete-invoice, or resume-after-opt-out control.

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function parseDollarsToCents(value: string | null | undefined): number {
  const cleaned = String(value ?? '').replace(/[$,\s]/g, '');
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars <= 0) throw new Error('Enter a positive dollar amount');
  const cents = Math.round(dollars * 100);
  if (cents > 100_000_000) throw new Error('Amount is too large for this dashboard');
  return cents;
}

export type QueueAction = 'resolve_dispute' | 'approve_plan' | 'resume' | 'keep_paused';

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

const STYLE = `
:root{--ink:#17202b;--muted:#667085;--line:#e4e7ec;--bg:#f5f7fa;--card:#fff;--blue:#175cd3;--green:#067647;--amber:#b54708;--red:#b42318;--soft:#eef4ff;--greenbg:#ecfdf3;--amberbg:#fffaeb;--redbg:#fef3f2}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
a{color:var(--blue);text-decoration:none} a:hover{text-decoration:underline}
header{background:#101828;color:#fff;position:sticky;top:0;z-index:10;box-shadow:0 1px 8px rgba(16,24,40,.18)}
.wrap{max-width:1240px;margin:0 auto;padding:0 20px}.top{display:flex;align-items:center;gap:16px;min-height:58px}.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;color:#fff}.mark{width:32px;height:32px;border-radius:9px;background:#2e90fa;display:grid;place-items:center;font-size:19px}.top nav{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}.top nav a{color:#d0d5dd;padding:7px 10px;border-radius:8px}.top nav a.active,.top nav a:hover{background:#1d2939;color:#fff;text-decoration:none}
main{padding:24px 0 44px} h1{font-size:28px;line-height:1.15;margin:0 0 6px} h2{font-size:18px;margin:0 0 8px} h3{font-size:15px;margin:0 0 8px}.sub{color:var(--muted);margin:0 0 18px}.muted{color:var(--muted)} .small{font-size:12px}.right{text-align:right}.nowrap{white-space:nowrap}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}.span3{grid-column:span 3}.span4{grid-column:span 4}.span6{grid-column:span 6}.span8{grid-column:span 8}.span12{grid-column:span 12}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(16,24,40,.04);margin-bottom:16px}.kpi .label{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.kpi .value{font-size:28px;font-weight:800;line-height:1.15;margin-top:4px}.kpi .note{color:var(--muted);font-size:12px}
.progress{height:12px;background:#eaecf0;border-radius:99px;overflow:hidden}.progress div{height:100%;background:#12b76a;border-radius:99px}
.banner{border-radius:12px;padding:12px 14px;margin:0 0 16px;border:1px solid}.banner.ok{background:var(--greenbg);border-color:#a6f4c5;color:#05603a}.banner.err{background:var(--redbg);border-color:#fecdca;color:#7a271a}.banner.warn{background:var(--amberbg);border-color:#fedf89;color:#93370d}
.tablewrap{overflow:auto;border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;min-width:760px}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#f9fafb;color:#475467;font-size:12px;text-transform:uppercase;letter-spacing:.03em}tr:last-child td{border-bottom:0}tr:hover td{background:#fcfcfd}
.badge{display:inline-flex;align-items:center;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:700;border:1px solid var(--line);background:#f9fafb;color:#344054}.badge.green{background:var(--greenbg);border-color:#a6f4c5;color:var(--green)}.badge.blue{background:var(--soft);border-color:#b2ccff;color:var(--blue)}.badge.amber{background:var(--amberbg);border-color:#fedf89;color:var(--amber)}.badge.red{background:var(--redbg);border-color:#fecdca;color:var(--red)}.badge.dark{background:#1d2939;border-color:#1d2939;color:#fff}
button,.button{font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #d0d5dd;background:#fff;color:#1d2939;border-radius:9px;padding:8px 12px;cursor:pointer;font-weight:650}button:hover,.button:hover{background:#f9fafb;text-decoration:none}button.primary,.button.primary{background:var(--blue);border-color:var(--blue);color:#fff}button.go{background:var(--green);border-color:var(--green);color:#fff}button.warnbtn{background:#fffaeb;border-color:#fedf89;color:#93370d}button.danger{background:#fff;border-color:#fecdca;color:var(--red)}button.smallbtn{padding:4px 8px;font-size:12px}button:disabled{opacity:.45;cursor:not-allowed}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.inline-form{display:inline}
label{display:block;font-weight:650;margin:12px 0 5px}input,select,textarea{font:inherit;width:100%;border:1px solid #d0d5dd;border-radius:9px;padding:9px 10px;background:#fff;color:var(--ink)}textarea{min-height:96px;resize:vertical}input[type=checkbox]{width:auto}.check{display:flex;gap:8px;align-items:center;font-weight:500;margin:8px 0}.formgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px}.formgrid .wide{grid-column:1/-1}.help{color:var(--muted);font-size:12px;margin-top:4px}.search{max-width:520px;margin:0 0 14px}.divider{height:1px;background:var(--line);margin:18px 0}.timeline{display:grid;gap:10px}.event{border-left:3px solid #d0d5dd;padding:2px 0 2px 12px}.event.payment{border-color:#12b76a}.event.reply{border-color:#2e90fa}.event.contact{border-color:#f79009}.event.promise{border-color:#7a5af8}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.chips{display:flex;gap:6px;flex-wrap:wrap}.empty{color:var(--muted);padding:18px;text-align:center}
@media(max-width:820px){.span3,.span4,.span6,.span8{grid-column:span 12}.formgrid{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column;padding:12px 0}.top nav{margin-left:0}main{padding-top:16px}h1{font-size:24px}}
`;

const NAV = [
  ['Overview', '/'],
  ['Clients', '/clients'],
  ['Human queue', '/queue'],
  ['Learned', '/learned'],
  ['Runs', '/runs'],
  ['Settings', '/settings'],
] as const;

function banner(url: URL): string {
  const msg = url.searchParams.get('msg');
  const err = url.searchParams.get('err');
  return `${msg ? `<div class="banner ok">${esc(msg)}</div>` : ''}${err ? `<div class="banner err">${esc(err)}</div>` : ''}`;
}

function page(title: string, active: string, body: string, url: URL): string {
  const nav = NAV.map(([label, href]) => `<a href="${href}"${active === label ? ' class="active"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body><header><div class="wrap top"><a class="logo" href="/"><span class="mark">↩</span>Remit Control Room</a><nav>${nav}</nav></div></header>
<main><div class="wrap">${banner(url)}${body}</div></main>
<script>
document.querySelectorAll('[data-filter-input]').forEach(function(input){
  input.addEventListener('input',function(){
    var q=input.value.toLowerCase();
    document.querySelectorAll('[data-search]').forEach(function(row){ row.style.display = row.getAttribute('data-search').toLowerCase().includes(q) ? '' : 'none'; });
  });
});
</script></body></html>`;
}

function authorized(req: IncomingMessage): boolean {
  const password = process.env.REVIEW_PASSWORD;
  if (!password) return process.env.NODE_ENV !== 'production';
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  return Buffer.from(header.slice(6), 'base64').toString('utf8') === `remit:${password}`;
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Form is too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function redirect(res: ServerResponse, path: string, msg?: string, err?: string): void {
  const target = new URL(path.startsWith('/') && !path.startsWith('//') ? path : '/', 'http://localhost');
  if (msg) target.searchParams.set('msg', msg);
  if (err) target.searchParams.set('err', err);
  res.writeHead(303, { location: `${target.pathname}${target.search}` });
  res.end();
}

function moneyFull(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function overdueLabel(inv: Invoice, worldDay: number): string {
  const d = daysOverdue(inv, worldDay);
  if (inv.status === 'paid') return inv.paidDay === null ? 'Paid' : `Paid day ${inv.paidDay}`;
  if (d < 0) return `Due in ${-d}d`;
  if (d === 0) return 'Due today';
  return `${d}d overdue`;
}
function statusBadge(status: string): string {
  const kind = status === 'paid' ? 'green' : status === 'open' ? 'blue' : status === 'disputed' ? 'red' : status === 'escalated' ? 'amber' : '';
  return `<span class="badge ${kind}">${esc(status)}</span>`;
}
function eventDetail(e: LedgerEvent): string {
  try {
    const parsed = JSON.parse(e.detail) as Record<string, unknown>;
    if (e.kind === 'contact' && typeof parsed.message === 'string') return `${String(parsed.playbook ?? 'contact')}: ${parsed.message}`;
    if (e.kind === 'promise' && parsed.day !== undefined) return `Promise to pay by day ${String(parsed.day)}`;
  } catch { /* plain text event */ }
  return e.detail;
}

type EnrichedInvoice = {
  inv: Invoice;
  events: LedgerEvent[];
  segment: Segment | '—';
  overdue: number;
  remaining: number;
  contacts: number;
  nextEligibleDay: number | null;
  suppressionReason: string | null;
  queue: Array<Record<string, unknown>>;
};

type DashboardData = {
  stats: LedgerStats | null;
  worldDay: number;
  invoices: Invoice[];
  debtors: Debtor[];
  debtorsById: Map<string, Debtor>;
  events: LedgerEvent[];
  eventsByInvoice: Map<string, LedgerEvent[]>;
  queue: Array<Record<string, unknown>>;
  settings: AgentSettings;
  suppressions: Map<string, string>;
  enriched: EnrichedInvoice[];
  byInvoiceId: Map<string, EnrichedInvoice>;
};

function nextEligible(inv: Invoice, events: LedgerEvent[], worldDay: number, settings: AgentSettings, suppressed: boolean): number | null {
  if (inv.status !== 'open' || remainingCents(inv) <= 0 || suppressed) return null;
  const contacts = events.filter((e) => e.kind === 'contact');
  if (contacts.length >= settings.maxContactsPerInvoice) return null;
  if (daysOverdue(inv, worldDay) > settings.maxOverdueDays) return null;
  let next = inv.dueDay - settings.preDueReminderDays;
  const last = contacts[contacts.length - 1];
  if (last) next = Math.max(next, last.day + settings.minGapDays);
  const promise = latestPromise(events);
  if (promise && !promise.paymentAfter) next = Math.max(next, promise.promisedDay + 1);
  return next;
}

async function loadDashboard(ledger: Ledger): Promise<DashboardData> {
  const [stats, invoices, queriedDebtors, events, queue, settings, suppressions] = await Promise.all([
    ledger.stats().catch(() => null),
    ledger.allInvoices(1000).catch(() => [] as Invoice[]),
    ledger.debtors().catch(() => [] as Debtor[]),
    ledger.allEvents().catch(() => [] as LedgerEvent[]),
    db.openQueue('live'),
    loadSettings('live'),
    db.suppressionDetails('live'),
  ]);
  const worldDay = stats?.worldDay ?? 0;
  const debtorsById = new Map<string, Debtor>();
  for (const d of queriedDebtors) debtorsById.set(d.id, d);
  for (const inv of invoices) {
    if (!debtorsById.has(inv.debtorId)) debtorsById.set(inv.debtorId, { id: inv.debtorId, name: inv.debtorName, email: '' });
  }
  const debtors = [...debtorsById.values()].sort((a, b) => a.name.localeCompare(b.name));
  const eventsByInvoice = new Map<string, LedgerEvent[]>();
  for (const e of events) {
    const list = eventsByInvoice.get(e.invoiceId) ?? [];
    list.push(e);
    eventsByInvoice.set(e.invoiceId, list);
  }
  const queueByInvoice = new Map<string, Array<Record<string, unknown>>>();
  for (const q of queue) {
    const id = String(q.invoice_id);
    const list = queueByInvoice.get(id) ?? [];
    list.push(q);
    queueByInvoice.set(id, list);
  }
  const enriched = invoices.map((inv) => {
    const invEvents = eventsByInvoice.get(inv.id) ?? [];
    const siblings = invoices.filter((i) => i.debtorId === inv.debtorId);
    const suppressionReason = suppressions.get(inv.id) ?? null;
    return {
      inv,
      events: invEvents,
      segment: siblings.length ? segmentOf(siblings, invEvents, worldDay) : '—',
      overdue: daysOverdue(inv, worldDay),
      remaining: remainingCents(inv),
      contacts: invEvents.filter((e) => e.kind === 'contact').length,
      nextEligibleDay: nextEligible(inv, invEvents, worldDay, settings, suppressionReason !== null),
      suppressionReason,
      queue: queueByInvoice.get(inv.id) ?? [],
    } satisfies EnrichedInvoice;
  });
  return {
    stats,
    worldDay,
    invoices,
    debtors,
    debtorsById,
    events,
    eventsByInvoice,
    queue,
    settings,
    suppressions,
    enriched,
    byInvoiceId: new Map(enriched.map((x) => [x.inv.id, x])),
  };
}

function invoiceLink(x: EnrichedInvoice): string {
  return `<a href="/invoice?id=${encodeURIComponent(x.inv.id)}"><b>${esc(x.inv.id)}</b></a><br>${esc(x.inv.debtorName)}`;
}

function invoiceRows(data: DashboardData, rows: EnrichedInvoice[]): string {
  if (!rows.length) return '<div class="empty">No invoices match.</div>';
  const body = rows.map((x) => {
    const next = x.nextEligibleDay === null ? '—' : x.nextEligibleDay <= data.worldDay ? 'Now' : `Day ${x.nextEligibleDay}`;
    const search = esc(`${x.inv.id} ${x.inv.debtorName} ${data.debtorsById.get(x.inv.debtorId)?.email ?? ''} ${x.inv.status} ${x.segment}`);
    return `<tr data-search="${search}">
      <td>${invoiceLink(x)}</td>
      <td>${statusBadge(x.inv.status)}${x.suppressionReason ? '<br><span class="badge amber">paused</span>' : ''}${x.queue.length ? `<br><span class="badge red">${x.queue.length} human task${x.queue.length === 1 ? '' : 's'}</span>` : ''}</td>
      <td><b>${moneyFull(x.remaining)}</b><br><span class="muted">of ${moneyFull(x.inv.amountCents)}</span></td>
      <td>Day ${x.inv.dueDay}<br><span class="muted">${esc(overdueLabel(x.inv, data.worldDay))}</span></td>
      <td><span class="badge blue">${esc(x.segment)}</span></td>
      <td>${x.contacts}</td>
      <td>${esc(next)}</td>
      <td><a class="button smallbtn" href="/invoice?id=${encodeURIComponent(x.inv.id)}">Open</a></td>
    </tr>`;
  }).join('');
  return `<div class="tablewrap"><table><thead><tr><th>Invoice / client</th><th>Status</th><th>Balance</th><th>Due</th><th>Segment</th><th>Contacts</th><th>Next allowed</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function queueRows(data: DashboardData, returnTo: string, limit?: number): string {
  const queue = limit ? data.queue.slice(0, limit) : data.queue;
  if (!queue.length) return '<div class="empty">No invoices need a person right now. 🎉</div>';
  const body = queue.map((q) => {
    const x = data.byInvoiceId.get(String(q.invoice_id));
    const detail = (q.detail ?? {}) as Record<string, unknown>;
    const storedDraft = (detail.draft && typeof detail.draft === 'object')
      ? detail.draft as { message?: unknown; instalments?: Array<{ day?: unknown; amountCents?: unknown }> }
      : null;
    const draftMessage = typeof detail.draft === 'string' ? detail.draft : storedDraft?.message;
    const instalmentText = storedDraft?.instalments?.length
      ? `<br><i>Proposed plan: ${storedDraft.instalments.map((i) => `day ${esc(i.day)}: ${moneyFull(Number(i.amountCents ?? 0))}`).join('; ')}</i>`
      : '';
    return `<tr data-search="${esc(`${q.invoice_id} ${x?.inv.debtorName ?? ''} ${q.kind} ${q.why}`)}">
      <td>${x ? invoiceLink(x) : `<b>${esc(q.invoice_id)}</b>`}${x ? `<br>${moneyFull(x.remaining)} open` : ''}</td>
      <td><span class="badge ${q.kind === 'optout' || q.kind === 'dispute' ? 'red' : 'amber'}">${esc(q.kind)}</span></td>
      <td>${esc(q.why)}${detail.reply ? `<br><i>Debtor: ${esc(detail.reply)}</i>` : ''}${draftMessage ? `<br><i>Blocked draft: ${esc(draftMessage)}</i>` : ''}${instalmentText}</td>
      <td><div class="actions">${allowedQueueActions(String(q.kind), q.detail).map((action) => `
        <form class="inline-form" method="post" action="/act"><input type="hidden" name="qid" value="${esc(q.id)}"><input type="hidden" name="returnTo" value="${esc(returnTo)}"><button class="smallbtn ${action === 'keep_paused' ? '' : 'go'}" name="action" value="${action}">${QUEUE_ACTION_LABELS[action]}</button></form>`).join('')}</div></td>
    </tr>`;
  }).join('');
  return `<div class="tablewrap"><table><thead><tr><th>Invoice</th><th>Kind</th><th>Why it is here</th><th>Decide</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function isOptOut(x: EnrichedInvoice | undefined, events: LedgerEvent[], reason?: string | null): boolean {
  if (reason === 'debtor asked us to stop') return true;
  if (x?.queue.some((q) => q.kind === 'optout')) return true;
  return events.some((e) => e.kind === 'reply' && replySignal(e.detail) === 'optout');
}

function settingsSummary(s: AgentSettings): string {
  const st = scheduleStatus(s);
  return `<div class="chips">
    <span class="badge ${s.enabled ? 'green' : 'red'}">${s.enabled ? 'Agent running' : 'Agent paused'}</span>
    <span class="badge ${st.allowed ? 'blue' : 'amber'}">${esc(st.reason)}</span>
    <span class="badge">Model ${esc(s.draftModel)}</span>
    <span class="badge">Budget $${s.budgetUsd.toFixed(2)}/sweep</span>
    <span class="badge">Gap ${s.minGapDays}d · max ${s.maxContactsPerInvoice} contacts</span>
  </div>`;
}

function runStatText(raw: unknown): string {
  const s = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const bits: string[] = [];
  const add = (label: string, key: string) => { if (s[key] !== undefined) bits.push(`${label} ${String(s[key])}`); };
  add('day', 'day'); add('considered', 'considered'); add('contacted', 'contacted'); add('plans', 'plansOffered');
  add('queued', 'queued'); add('waited', 'waited'); add('rewards', 'rewardsCredited');
  if (s.costUsd !== undefined) bits.push(`cost $${Number(s.costUsd).toFixed(4)}`);
  if (s.collectedCents !== undefined) bits.push(`collected ${moneyFull(Number(s.collectedCents))}`);
  if (s.skipped) bits.push(`skipped: ${String(s.skipped)}`);
  return bits.join(' · ') || '—';
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
      if (req.method === 'POST' && !sameOrigin(req)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('cross-site form submission blocked\n');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        const [data, runs, decisions] = await Promise.all([loadDashboard(ledger), db.recentRuns(5), db.recentDecisions(8)]);
        const invoiced = data.stats?.invoicedCents ?? data.invoices.reduce((s, i) => s + i.amountCents, 0);
        const collected = data.stats?.collectedCents ?? data.invoices.reduce((s, i) => s + i.paidCents, 0);
        const pct = invoiced ? Math.round((collected / invoiced) * 1000) / 10 : 0;
        const overdue = data.enriched.filter((x) => x.inv.status === 'open' && x.overdue > 0 && x.remaining > 0);
        const overdueCents = overdue.reduce((s, x) => s + x.remaining, 0);
        const segmentCounts = new Map<string, number>();
        for (const x of data.enriched) segmentCounts.set(x.segment, (segmentCounts.get(x.segment) ?? 0) + 1);
        const schedule = scheduleStatus(data.settings);
        const latestRun = runs[0];
        const decisionRows = decisions.map((d) => `<tr><td>Day ${esc(d.world_day)}</td><td><a href="/invoice?id=${encodeURIComponent(String(d.invoice_id))}">${esc(d.invoice_id)}</a></td><td>${esc(d.segment)}</td><td>${esc(d.outcome)}</td><td>${esc(d.why)}</td></tr>`).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit Control Room', 'Overview', `
          <h1>Collections overview</h1>
          <p class="sub">Run the agent, see cash moving, and jump to the clients or cases that need attention.</p>
          ${data.stats ? '' : '<div class="banner warn">Ledger is unreachable right now. Agent and client data may be stale. Check the remit-ledger service.</div>'}
          <div class="grid">
            <section class="card kpi span3"><div class="label">Collected</div><div class="value">${moneyFull(collected)}</div><div class="note">${pct}% of invoiced</div><div class="progress" style="margin-top:12px"><div style="width:${Math.max(0, Math.min(100, pct))}%"></div></div></section>
            <section class="card kpi span3"><div class="label">Open balance</div><div class="value">${moneyFull(Math.max(0, invoiced - collected))}</div><div class="note">${data.stats?.openCount ?? data.invoices.filter((i) => i.status === 'open').length} open invoices · world day ${data.worldDay}</div></section>
            <section class="card kpi span3"><div class="label">Overdue now</div><div class="value">${moneyFull(overdueCents)}</div><div class="note">${overdue.length} overdue invoices</div></section>
            <section class="card kpi span3"><div class="label">Needs a person</div><div class="value">${data.queue.length}</div><div class="note"><a href="/queue">Open human queue →</a></div></section>
            <section class="card span8">
              <h2>Agent controls</h2>
              ${settingsSummary(data.settings)}
              <p class="muted">Operator time now: <b>${esc(schedule.localTime)}</b> in ${esc(data.settings.timezone)}. Scheduled GitHub sweeps only work inside your selected days/window.</p>
              <div class="actions">
                <form class="inline-form" method="post" action="/control" onsubmit="return confirm('Run one collection day now? This sends allowed contacts and advances the simulated world by one day.')"><input type="hidden" name="action" value="run_now"><button class="primary" ${data.settings.enabled ? '' : 'disabled'}>▶ Run one day now</button></form>
                ${data.settings.enabled
                  ? '<form class="inline-form" method="post" action="/control" onsubmit="return confirm(\'Pause the agent? Scheduled sweeps will become no-ops until you resume.\')"><input type="hidden" name="action" value="pause"><button class="warnbtn">Pause agent</button></form>'
                  : '<form class="inline-form" method="post" action="/control"><input type="hidden" name="action" value="resume"><button class="go">Resume agent</button></form>'}
                <a class="button" href="/settings">Open settings</a>
                <a class="button" href="/clients">Clients & invoices</a>
              </div>
              <p class="help">“Run one day now” ignores only the clock window. It does not ignore the pause switch, opt-outs, disputes, contact spacing, caps, or plan rules.</p>
            </section>
            <section class="card span4">
              <h2>Latest run</h2>
              ${latestRun ? `<p><b>#${esc(latestRun.id)} · ${esc(latestRun.kind)}</b><br><span class="muted">${esc(latestRun.started_at)}</span></p><p>${esc(runStatText(latestRun.stats))}</p><a class="button smallbtn" href="/runs">All runs</a>` : '<p class="muted">No runs yet.</p>'}
              <div class="divider"></div><h3>Segments</h3>
              <div class="chips">${[...segmentCounts.entries()].map(([k, v]) => `<span class="badge blue">${esc(k)}: ${v}</span>`).join('') || '<span class="muted">No invoices</span>'}</div>
            </section>
            <section class="card span12">
              <div class="actions" style="justify-content:space-between"><h2 style="margin:0">Needs a person</h2><a class="button smallbtn" href="/queue">Open full queue</a></div>
              ${queueRows(data, '/', 5)}
            </section>
            <section class="card span12">
              <h2>Recent decisions</h2>
              ${decisionRows ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Invoice</th><th>Segment</th><th>Outcome</th><th>Why</th></tr></thead><tbody>${decisionRows}</tbody></table></div>` : '<p class="muted">No decisions recorded yet.</p>'}
            </section>
          </div>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/queue') {
        const data = await loadDashboard(ledger);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit human queue', 'Human queue', `
          <h1>Human queue</h1><p class="sub">Disputes, opt-outs, distress, blocked drafts, escalations, and plans that need a person.</p>
          <input class="search" data-filter-input placeholder="Search invoice, client, kind, or reason…">
          <section class="card">${queueRows(data, '/queue')}</section>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/clients') {
        const data = await loadDashboard(ledger);
        const clientRows = data.debtors.map((debtor) => {
          const rows = data.enriched.filter((x) => x.inv.debtorId === debtor.id);
          const open = rows.reduce((s, x) => s + (x.inv.status === 'paid' ? 0 : x.remaining), 0);
          const overdueAmt = rows.filter((x) => x.overdue > 0 && x.inv.status === 'open').reduce((s, x) => s + x.remaining, 0);
          const paid = rows.reduce((s, x) => s + x.inv.paidCents, 0);
          const segs = [...new Set(rows.map((x) => x.segment))];
          return `<tr data-search="${esc(`${debtor.id} ${debtor.name} ${debtor.email}`)}">
            <td><a href="/client?id=${encodeURIComponent(debtor.id)}"><b>${esc(debtor.name)}</b></a><br><span class="muted">${esc(debtor.email || 'No email')} · ${esc(debtor.id)}</span></td>
            <td>${rows.length}</td><td><b>${moneyFull(open)}</b></td><td>${moneyFull(overdueAmt)}</td><td>${moneyFull(paid)}</td>
            <td>${segs.map((s) => `<span class="badge blue">${esc(s)}</span>`).join(' ')}</td>
            <td><a class="button smallbtn" href="/client?id=${encodeURIComponent(debtor.id)}">Manage</a></td></tr>`;
        }).join('');
        const invoicesSorted = [...data.enriched].sort((a, b) => (a.inv.status === 'open' ? 0 : 1) - (b.inv.status === 'open' ? 0 : 1) || b.overdue - a.overdue || b.remaining - a.remaining);
        const debtorOptions = data.debtors.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} (${esc(d.id)})</option>`).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit clients', 'Clients', `
          <h1>Clients & invoices</h1><p class="sub">Search clients, add an invoice, open a case, record payments/promises, or pause contact.</p>
          <input class="search" data-filter-input placeholder="Search client, email, invoice, status, or segment…">
          <div class="grid">
            <section class="card span4">
              <h2>Add invoice</h2>
              <form method="post" action="/clients/add-invoice">
                <label>Existing client</label>
                <select name="debtorId"><option value="">— New client below —</option>${debtorOptions}</select>
                <div class="help">Choose an existing client, or leave this as “New client” and fill the next two fields.</div>
                <label>New client name</label><input name="debtorName" placeholder="Example Trading Ltd">
                <label>New client accounts email</label><input name="debtorEmail" placeholder="ap@example.com">
                <label>Invoice amount (USD)</label><input name="amount" required inputmode="decimal" placeholder="1250.00">
                <label>Due in days from world day ${data.worldDay}</label><input name="dueInDays" type="number" value="14" min="-365" max="3650" required>
                <div class="help">Use a negative number for an already-overdue invoice. Example: -5 = due 5 days ago.</div>
                <p><button class="primary">Add invoice</button></p>
              </form>
            </section>
            <section class="card span8">
              <h2>Clients</h2>
              <div class="tablewrap"><table style="min-width:680px"><thead><tr><th>Client</th><th>Invoices</th><th>Open</th><th>Overdue</th><th>Collected</th><th>Segments</th><th></th></tr></thead><tbody>${clientRows}</tbody></table></div>
            </section>
            <section class="card span12"><h2>All invoices</h2>${invoiceRows(data, invoicesSorted)}</section>
          </div>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/client') {
        const data = await loadDashboard(ledger);
        const debtor = data.debtorsById.get(url.searchParams.get('id') ?? '');
        if (!debtor) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('client not found\n'); return; }
        const rows = data.enriched.filter((x) => x.inv.debtorId === debtor.id);
        const open = rows.reduce((s, x) => s + (x.inv.status === 'paid' ? 0 : x.remaining), 0);
        const paid = rows.reduce((s, x) => s + x.inv.paidCents, 0);
        const overdue = rows.filter((x) => x.overdue > 0 && x.inv.status === 'open');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(`Remit client ${debtor.name}`, 'Clients', `
          <p><a href="/clients">← All clients</a></p>
          <h1>${esc(debtor.name)}</h1><p class="sub">${esc(debtor.email || 'No email')} · client ID ${esc(debtor.id)}</p>
          <div class="grid">
            <section class="card kpi span4"><div class="label">Open balance</div><div class="value">${moneyFull(open)}</div><div class="note">${rows.length} invoices</div></section>
            <section class="card kpi span4"><div class="label">Overdue invoices</div><div class="value">${overdue.length}</div><div class="note">${moneyFull(overdue.reduce((s, x) => s + x.remaining, 0))} overdue</div></section>
            <section class="card kpi span4"><div class="label">Collected</div><div class="value">${moneyFull(paid)}</div><div class="note">Payments recorded in ledger</div></section>
            <section class="card span6">
              <h2>Edit client</h2>
              <form method="post" action="/clients/update">
                <input type="hidden" name="debtorId" value="${esc(debtor.id)}"><input type="hidden" name="returnTo" value="/client?id=${encodeURIComponent(debtor.id)}">
                <label>Client/business name</label><input name="name" value="${esc(debtor.name)}" required>
                <label>Accounts email</label><input name="email" value="${esc(debtor.email)}" required>
                <p><button class="primary">Save client</button></p>
              </form>
            </section>
            <section class="card span6">
              <h2>Add invoice for this client</h2>
              <form method="post" action="/clients/add-invoice">
                <input type="hidden" name="debtorId" value="${esc(debtor.id)}">
                <label>Invoice amount (USD)</label><input name="amount" required inputmode="decimal" placeholder="1250.00">
                <label>Due in days from world day ${data.worldDay}</label><input name="dueInDays" type="number" value="14" min="-365" max="3650" required>
                <p><button class="primary">Add invoice</button></p>
              </form>
            </section>
            <section class="card span12"><h2>Invoices</h2>${invoiceRows(data, rows)}</section>
          </div>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/invoice') {
        const data = await loadDashboard(ledger);
        const x = data.byInvoiceId.get(url.searchParams.get('id') ?? '');
        if (!x) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('invoice not found\n'); return; }
        const [decisions, trials] = await Promise.all([db.invoiceDecisions('live', x.inv.id), db.contactTrials('live', x.inv.id)]);
        const debtor = data.debtorsById.get(x.inv.debtorId);
        const optOut = isOptOut(x, x.events, x.suppressionReason);
        const defaultPlanCount = Math.min(2, data.settings.planMaxInstalments);
        const defaultFirstDay = data.worldDay + Math.min(7, data.settings.planMaxDays);
        const defaultLastDay = defaultPlanCount <= 1 ? defaultFirstDay : Math.max(defaultFirstDay, data.worldDay + Math.min(21, data.settings.planMaxDays));
        const templateValues = { debtor: x.inv.debtorName, invoice: x.inv.id, amount: moneyFull(x.remaining), remaining: moneyFull(x.remaining), dueDay: x.inv.dueDay, worldDay: data.worldDay, daysOverdue: x.overdue, overdue: x.overdue, planCount: defaultPlanCount, firstDay: defaultFirstDay, lastDay: defaultLastDay, firstPayment: moneyFull(defaultPlanCount ? Math.ceil(x.remaining / defaultPlanCount) : 0) };
        const reminder = renderTemplate(data.settings.templates['friendly-remind-only'], templateValues);
        const planMessage = renderTemplate(data.settings.templates['friendly-plan-early'], templateValues);
        const playbookOptions = data.settings.enabledPlaybooks.map((p) => `<option value="${p}">${p}</option>`).join('');
        const next = x.nextEligibleDay === null ? 'Not eligible' : x.nextEligibleDay <= data.worldDay ? 'Now' : `World day ${x.nextEligibleDay}`;
        const timeline = [...x.events].reverse().map((e) => `<div class="event ${esc(e.kind)}"><b>Day ${e.day} · ${esc(e.kind)}</b><br>${esc(eventDetail(e))}</div>`).join('') || '<p class="muted">No ledger events yet.</p>';
        const decisionRows = decisions.map((d) => `<tr><td>Day ${esc(d.world_day)}</td><td>${esc(d.playbook)}</td><td>${esc(d.action)} → ${esc(d.outcome)}</td><td>${esc(d.why)}</td></tr>`).join('');
        const trialRows = trials.map((t) => `<tr><td>${t.contactEventId}</td><td>Day ${t.worldDay}</td><td>${esc(t.segment)}</td><td>${esc(t.playbook)}</td><td>${t.rewardedPaymentEventId ? `Payment event ${t.rewardedPaymentEventId}` : '—'}</td></tr>`).join('');
        const canAct = x.inv.status === 'open' && x.remaining > 0 && !x.suppressionReason && !optOut;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(`Remit invoice ${x.inv.id}`, 'Clients', `
          <p><a href="/client?id=${encodeURIComponent(x.inv.debtorId)}">← ${esc(x.inv.debtorName)}</a></p>
          <div class="actions" style="justify-content:space-between"><div><h1>${esc(x.inv.id)}</h1><p class="sub">${esc(x.inv.debtorName)} · ${esc(debtor?.email || '')}</p></div><div>${statusBadge(x.inv.status)} <span class="badge blue">${esc(x.segment)}</span>${x.suppressionReason ? ' <span class="badge amber">paused</span>' : ''}${optOut ? ' <span class="badge red">opt-out locked</span>' : ''}</div></div>
          <div class="grid">
            <section class="card kpi span3"><div class="label">Balance</div><div class="value">${moneyFull(x.remaining)}</div><div class="note">Invoice total ${moneyFull(x.inv.amountCents)} · paid ${moneyFull(x.inv.paidCents)}</div></section>
            <section class="card kpi span3"><div class="label">Due</div><div class="value">Day ${x.inv.dueDay}</div><div class="note">${esc(overdueLabel(x.inv, data.worldDay))} · issued day ${x.inv.issuedDay}</div></section>
            <section class="card kpi span3"><div class="label">Contacts</div><div class="value">${x.contacts}/${data.settings.maxContactsPerInvoice}</div><div class="note">Next allowed: ${esc(next)}</div></section>
            <section class="card kpi span3"><div class="label">Human tasks</div><div class="value">${x.queue.length}</div><div class="note">${x.suppressionReason ? esc(x.suppressionReason) : 'Contact not paused'}</div></section>

            <section class="card span6">
              <h2>Contact control</h2>
              ${optOut ? '<div class="banner err">This debtor opted out. Resume/send controls are locked. A person owns any further handling outside automated contact.</div>' : ''}
              <div class="actions">
                ${x.suppressionReason && !optOut ? `<form class="inline-form" method="post" action="/invoice/action"><input type="hidden" name="invoiceId" value="${esc(x.inv.id)}"><button class="go" name="action" value="resume">Resume contact</button></form>` : ''}
                ${!x.suppressionReason && x.inv.status === 'open' ? `<form class="inline-form" method="post" action="/invoice/action"><input type="hidden" name="invoiceId" value="${esc(x.inv.id)}"><button class="warnbtn" name="action" value="pause">Pause contact</button></form>` : ''}
                ${x.inv.status === 'open' ? `<form class="inline-form" method="post" action="/invoice/action" onsubmit="return confirm('Escalate this invoice to a person?')"><input type="hidden" name="invoiceId" value="${esc(x.inv.id)}"><input type="hidden" name="reason" value="Escalated from invoice dashboard."><button class="danger" name="action" value="escalate">Escalate</button></form>` : ''}
                ${x.inv.status === 'escalated' && !optOut ? `<form class="inline-form" method="post" action="/invoice/action"><input type="hidden" name="invoiceId" value="${esc(x.inv.id)}"><button class="go" name="action" value="reopen">Return to agent</button></form>` : ''}
                ${x.inv.status === 'disputed' ? `<form class="inline-form" method="post" action="/invoice/action" onsubmit="return confirm('Mark this dispute resolved and allow contact again?')"><input type="hidden" name="invoiceId" value="${esc(x.inv.id)}"><button class="go" name="action" value="resolve_dispute">Dispute resolved</button></form>` : ''}
              </div>
              <div class="divider"></div>
              <h3>Send a reminder now</h3>
              <form method="post" action="/invoice/action">
                <input type="hidden" name="invoiceId" value="${esc(x.inv.id)}">
                <label>Playbook</label><select name="playbook">${playbookOptions}</select>
                <label>Message</label><textarea name="message" required>${esc(reminder)}</textarea>
                <div class="help">The code gate still checks spacing, caps, promises, banned phrases, and discounts before sending.</div>
                <p><button class="primary" name="action" value="send_message" ${canAct ? '' : 'disabled'}>Send reminder</button></p>
              </form>
            </section>

            <section class="card span6">
              <h2>Record money or promise</h2>
              <form method="post" action="/invoice/action">
                <input type="hidden" name="invoiceId" value="${esc(x.inv.id)}">
                <div class="formgrid">
                  <div><label>Payment received (USD)</label><input name="paymentAmount" inputmode="decimal" placeholder="250.00"></div>
                  <div><label>Payment note</label><input name="paymentNote" placeholder="Bank transfer received"></div>
                </div>
                <p><button class="go" name="action" value="record_payment" ${x.inv.status === 'paid' || x.inv.status === 'disputed' ? 'disabled' : ''}>Record payment</button></p>
              </form>
              <div class="divider"></div>
              <form method="post" action="/invoice/action">
                <input type="hidden" name="invoiceId" value="${esc(x.inv.id)}">
                <label>Debtor promised to pay in how many days?</label><input name="promiseInDays" type="number" min="0" max="90" value="7" required>
                <div class="help">Remit will wait until after that promised date before chasing again.</div>
                <p><button name="action" value="record_promise" ${x.inv.status === 'paid' || x.inv.status === 'disputed' ? 'disabled' : ''}>Record promise</button></p>
              </form>
              <div class="divider"></div>
              <h3>Create an equal-split payment plan</h3>
              <form method="post" action="/invoice/action">
                <input type="hidden" name="invoiceId" value="${esc(x.inv.id)}">
                <div class="formgrid">
                  <div><label>Playbook</label><select name="playbook">${playbookOptions}</select></div>
                  <div><label>Instalments</label><input name="planCount" type="number" min="1" max="${data.settings.planMaxInstalments}" value="${defaultPlanCount}" required></div>
                  <div><label>First payment in days</label><input name="planFirstInDays" type="number" min="1" max="${data.settings.planMaxDays}" value="${defaultFirstDay - data.worldDay}" required></div>
                  <div><label>Then every days (0 = same day)</label><input name="planEveryDays" type="number" min="0" max="45" value="${defaultPlanCount <= 1 ? 0 : defaultLastDay - defaultFirstDay}" required></div>
                  <div class="wide"><label>Message</label><textarea name="message" required>${esc(planMessage)}</textarea></div>
                </div>
                <div class="help">As the human operator, you may approve over the automatic dollar threshold. Exact total, dates, first-payment size, spacing, caps, and safe wording are still re-checked.</div>
                <p><button class="primary" name="action" value="create_plan" ${canAct ? '' : 'disabled'}>Create & send plan</button></p>
              </form>
            </section>

            <section class="card span6"><h2>Timeline</h2><div class="timeline">${timeline}</div></section>
            <section class="card span6">
              <h2>Agent decisions</h2>
              ${decisionRows ? `<div class="tablewrap"><table style="min-width:560px"><thead><tr><th>When</th><th>Playbook</th><th>Result</th><th>Why</th></tr></thead><tbody>${decisionRows}</tbody></table></div>` : '<p class="muted">No agent decisions yet.</p>'}
              <div class="divider"></div><h2>Learning trials</h2>
              ${trialRows ? `<div class="tablewrap"><table style="min-width:560px"><thead><tr><th>Contact event</th><th>Day</th><th>Segment frozen</th><th>Playbook</th><th>Reward</th></tr></thead><tbody>${trialRows}</tbody></table></div>` : '<p class="muted">No contact trials yet.</p>'}
            </section>
          </div>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/settings') {
        const [settings, history] = await Promise.all([loadSettings('live'), db.settingsHistory('live', 10)]);
        const dayBoxes = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']]
          .map(([n, label]) => `<label class="check"><input type="checkbox" name="sendDays" value="${n}"${settings.sendDays.includes(Number(n)) ? ' checked' : ''}> ${label}</label>`).join('');
        const playbookBoxes = PLAYBOOKS.map((p) => `<label class="check"><input type="checkbox" name="enabledPlaybooks" value="${p}"${settings.enabledPlaybooks.includes(p) ? ' checked' : ''}> ${p}</label>`).join('');
        const historyRows = history.map((h) => {
          const s = h.settings && typeof h.settings === 'object' ? h.settings as Record<string, unknown> : {};
          return `<tr><td>${esc(h.changed_at)}</td><td>${esc(h.changed_by)}</td><td>${s.enabled ? 'Running' : 'Paused'}</td><td>${esc(s.draftModel)}</td><td>${esc(s.timezone)} ${esc(s.sendStart)}–${esc(s.sendEnd)}</td></tr>`;
        }).join('');
        const schedule = scheduleStatus(settings);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit settings', 'Settings', `
          <h1>Agent settings</h1><p class="sub">These controls apply to the live agent. Evaluation scopes keep their own default settings so the exam stays reproducible.</p>
          ${settingsSummary(settings)}
          <form method="post" action="/settings/save">
            <div class="grid" style="margin-top:16px">
              <section class="card span6">
                <h2>Run & schedule</h2>
                <label class="check"><input type="checkbox" name="enabled" value="1"${settings.enabled ? ' checked' : ''}> Agent is running</label>
                <div class="help">When off, scheduled sweeps become recorded no-ops and the simulated day does not advance.</div>
                <label>Timezone</label>
                <input name="timezone" list="timezones" value="${esc(settings.timezone)}" required>
                <datalist id="timezones"><option value="Asia/Karachi"></option><option value="UTC"></option><option value="Europe/London"></option><option value="Europe/Berlin"></option><option value="America/New_York"></option><option value="America/Chicago"></option><option value="America/Denver"></option><option value="America/Los_Angeles"></option><option value="Asia/Dubai"></option><option value="Asia/Singapore"></option></datalist>
                <label>Sending days</label><div class="actions">${dayBoxes}</div>
                <div class="formgrid">
                  <div><label>Start time</label><input type="time" name="sendStart" value="${esc(settings.sendStart)}" required></div>
                  <div><label>End time</label><input type="time" name="sendEnd" value="${esc(settings.sendEnd)}" required></div>
                </div>
                <p class="help">GitHub checks hourly. Outside this window, a sweep is a recorded no-op. Current operator time: ${esc(schedule.localTime)} — ${esc(schedule.reason)}.</p>
              </section>

              <section class="card span6">
                <h2>Model & budget</h2>
                <label>Draft model (provider:model)</label>
                <input name="draftModel" list="models" value="${esc(settings.draftModel)}" required>
                <datalist id="models"><option value="baseline:rules"></option><option value="oss:openai/gpt-oss-20b"></option><option value="grok:grok-4.3"></option><option value="grok:grok-4.7"></option><option value="Claude:claude-haiku-4-5"></option><option value="Claude:claude-sonnet-4-5"></option><option value="openai:gpt-5-mini"></option><option value="openai:gpt-5"></option></datalist>
                <div class="help">API keys are never entered here. They belong only in Render/GitHub secret stores. If a selected provider has no key, drafting fails safe to human escalation.</div>
                <label>Maximum model budget per sweep (USD)</label>
                <input name="budgetUsd" type="number" min="0" max="100" step="0.01" value="${settings.budgetUsd}" required>
                <div class="divider"></div>
                <h3>Learning</h3>
                <div class="formgrid">
                  <div><label>Exploration %</label><input name="explorationPct" type="number" min="0" max="50" step="1" value="${settings.explorationPct}" required></div>
                  <div><label>Reward window (days)</label><input name="rewardWindowDays" type="number" min="1" max="14" step="1" value="${settings.rewardWindowDays}" required></div>
                </div>
                <label>Enabled playbooks</label>${playbookBoxes}
              </section>

              <section class="card span6">
                <h2>Reminder timing & cadence</h2>
                <div class="formgrid">
                  <div><label>Start reminding before due (days)</label><input name="preDueReminderDays" type="number" min="0" max="14" value="${settings.preDueReminderDays}" required></div>
                  <div><label>Minimum gap between contacts (days)</label><input name="minGapDays" type="number" min="3" max="30" value="${settings.minGapDays}" required></div>
                  <div><label>Maximum contacts per invoice</label><input name="maxContactsPerInvoice" type="number" min="1" max="6" value="${settings.maxContactsPerInvoice}" required></div>
                  <div><label>Stop automation after overdue (days)</label><input name="maxOverdueDays" type="number" min="7" max="365" value="${settings.maxOverdueDays}" required></div>
                </div>
                <p class="help">Hard safety bounds: gap cannot go below 3 days, and automated contacts cannot exceed 6 per invoice from this dashboard.</p>
              </section>

              <section class="card span6">
                <h2>Payment plans</h2>
                <div class="formgrid">
                  <div><label>Max instalments</label><input name="planMaxInstalments" type="number" min="1" max="3" value="${settings.planMaxInstalments}" required></div>
                  <div><label>All payments within (days)</label><input name="planMaxDays" type="number" min="7" max="45" value="${settings.planMaxDays}" required></div>
                  <div><label>Minimum first payment (%)</label><input name="planMinFirstPct" type="number" min="25" max="100" value="${settings.planMinFirstPct}" required></div>
                  <div><label>Human approval above (USD)</label><input name="planHumanAboveDollars" inputmode="decimal" value="${(settings.planHumanAboveCents / 100).toFixed(2)}" required></div>
                </div>
                <p class="help">Plans must still total the exact remaining balance. No discount switch exists.</p>
              </section>

              <section class="card span12">
                <h2>Playbook tones & baseline messages</h2>
                <p class="muted">Tone text guides an LLM. Message templates are used by the deterministic baseline. Placeholders: <span class="mono">{debtor} {invoice} {amount} {remaining} {dueDay} {worldDay} {daysOverdue} {planCount} {firstDay} {lastDay} {firstPayment}</span>. The policy gate checks the final message again.</p>
                ${PLAYBOOKS.map((p) => `
                  <h3 style="margin-top:20px">${p}</h3>
                  <div class="formgrid">
                    <div><label>Tone instruction</label><textarea name="tone_${p}" style="min-height:74px" required>${esc(settings.tones[p])}</textarea></div>
                    <div><label>Baseline message template</label><textarea name="template_${p}" required>${esc(settings.templates[p])}</textarea></div>
                  </div>`).join('')}
              </section>

              <section class="card span12">
                <div class="actions">
                  <button class="primary" type="submit">Save settings</button>
                  <button type="submit" form="reset-settings" class="warnbtn">Reset recommended defaults</button>
                </div>
                <p class="help">Saved settings apply to the next live sweep. A full audit copy is stored below. Secrets are not stored in settings.</p>
              </section>
            </div>
          </form>
          <form id="reset-settings" method="post" action="/settings/reset" onsubmit="return confirm('Reset all dashboard settings to recommended defaults?')"></form>

          <section class="card">
            <h2>Locked safety rules</h2>
            <div class="chips">
              <span class="badge red">No threats</span><span class="badge red">No discounts</span><span class="badge red">Opt-out cannot be resumed here</span><span class="badge red">Disputes pause contact</span><span class="badge amber">Promise dates are respected</span><span class="badge amber">No write-off/delete tool</span>
            </div>
            <details style="margin-top:14px"><summary>View locked banned phrases</summary><p class="mono">${POLICY.banned_phrases.map(esc).join(', ')}</p></details>
          </section>

          <section class="card">
            <h2>Recent setting changes</h2>
            ${historyRows ? `<div class="tablewrap"><table><thead><tr><th>Changed</th><th>By</th><th>State</th><th>Model</th><th>Window</th></tr></thead><tbody>${historyRows}</tbody></table></div>` : '<p class="muted">No dashboard setting changes yet.</p>'}
          </section>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/learned') {
        const [rows, settings] = await Promise.all([db.allPlaybookStats('live'), loadSettings('live')]);
        const bySegment = new Map<string, Array<Record<string, unknown>>>();
        for (const r of rows) {
          const list = bySegment.get(String(r.segment)) ?? [];
          list.push(r);
          bySegment.set(String(r.segment), list);
        }
        const winnerRows = [...bySegment.entries()].map(([segment, list]) => {
          const tried = list.filter((r) => Number(r.contacts) > 0).sort((a, b) => (Number(b.rewards) / Number(b.contacts)) - (Number(a.rewards) / Number(a.contacts)) || Number(b.contacts) - Number(a.contacts));
          const w = tried[0];
          return `<tr><td>${esc(segment)}</td><td>${w ? esc(w.playbook) : 'Still learning'}</td><td>${w ? `${w.rewards}/${w.contacts} (${Math.round((Number(w.rewards) / Number(w.contacts)) * 100)}%)` : '—'}</td></tr>`;
        }).join('');
        const items = rows.map((r) => {
          const contacts = Number(r.contacts), rewards = Number(r.rewards);
          const rate = contacts ? `${Math.round((rewards / contacts) * 100)}%` : '—';
          return `<tr><td>${esc(r.segment)}</td><td>${esc(r.playbook)}</td><td>${contacts}</td><td>${rewards}</td><td><b>${rate}</b></td></tr>`;
        }).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit learned playbooks', 'Learned', `
          <h1>What Remit learned</h1>
          <p class="sub">A reward means a payment arrived within ${settings.rewardWindowDays} days after that contact. Remit explores ${settings.explorationPct}% of eligible choices and otherwise plays the current winner. Small samples can mislead, so contacts stay visible beside every rate.</p>
          <section class="card"><h2>Current winner by segment</h2>${winnerRows ? `<div class="tablewrap"><table><thead><tr><th>Segment</th><th>Playbook</th><th>Paid after / contacts</th></tr></thead><tbody>${winnerRows}</tbody></table></div>` : '<p class="muted">No learning data yet.</p>'}</section>
          <section class="card"><h2>All playbook trials</h2>${items ? `<div class="tablewrap"><table><thead><tr><th>Segment</th><th>Playbook</th><th>Contacts</th><th>Paid after</th><th>Rate</th></tr></thead><tbody>${items}</tbody></table></div>` : '<p class="muted">No learning data yet.</p>'}</section>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/runs') {
        const [runs, decisions] = await Promise.all([db.recentRuns(25), db.recentDecisions(60)]);
        const runRows = runs.map((r) => `<tr><td>#${esc(r.id)}</td><td>${esc(r.kind)}<br><span class="muted">${esc(r.scope)}</span></td><td>${esc(r.draft_model)}</td><td>${esc(r.started_at)}${r.finished_at ? `<br><span class="muted">finished ${esc(r.finished_at)}</span>` : '<br><span class="badge amber">not finished</span>'}</td><td>${esc(runStatText(r.stats))}<details><summary class="small">Raw stats</summary><span class="mono">${esc(JSON.stringify(r.stats))}</span></details></td></tr>`).join('');
        const decRows = decisions.map((d) => `<tr><td>Day ${esc(d.world_day)}</td><td><a href="/invoice?id=${encodeURIComponent(String(d.invoice_id))}">${esc(d.invoice_id)}</a></td><td>${esc(d.segment)}</td><td>${esc(d.playbook)}</td><td>${esc(d.outcome)}</td><td>${esc(d.why)}</td></tr>`).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit runs', 'Runs', `
          <h1>Runs & decisions</h1><p class="sub">Every sweep/evaluation and the most recent invoice-level choices.</p>
          <section class="card"><h2>Runs</h2>${runRows ? `<div class="tablewrap"><table><thead><tr><th>Run</th><th>Kind</th><th>Model</th><th>Started</th><th>Summary</th></tr></thead><tbody>${runRows}</tbody></table></div>` : '<p class="muted">No runs yet.</p>'}</section>
          <section class="card"><h2>Recent decisions</h2>${decRows ? `<div class="tablewrap"><table><thead><tr><th>Day</th><th>Invoice</th><th>Segment</th><th>Playbook</th><th>Outcome</th><th>Why</th></tr></thead><tbody>${decRows}</tbody></table></div>` : '<p class="muted">No decisions yet.</p>'}</section>`, url));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/act') {
        const form = await readForm(req);
        const returnTo = form.get('returnTo') || '/queue';
        try {
          const qid = Number(form.get('qid'));
          const action = String(form.get('action') ?? '');
          if (!Number.isInteger(qid) || qid <= 0) throw new Error('Invalid queue item');
          const queue = await db.openQueue('live');
          const item = queue.find((q) => Number(q.id) === qid);
          if (!item) throw new Error('Queue item is no longer open');
          if (!allowedQueueActions(String(item.kind), item.detail).includes(action as QueueAction)) {
            throw new Error(`Action '${action}' is not allowed for a ${String(item.kind)} item`);
          }
          const invoiceId = String(item.invoice_id);
          const [inv, events, settings, suppressions] = await Promise.all([
            ledger.invoice(invoiceId), ledger.invoiceEvents(invoiceId), loadSettings('live'), db.suppressionDetails('live'),
          ]);
          if (!inv) throw new Error(`Invoice ${invoiceId} not found`);
          const optOutPresent = queue.some((q) => String(q.invoice_id) === invoiceId && String(q.kind) === 'optout')
            || suppressions.get(invoiceId) === 'debtor asked us to stop'
            || events.some((e) => e.kind === 'reply' && replySignal(e.detail) === 'optout');

          if (action === 'resolve_dispute') {
            await ledger.resolveDispute(invoiceId);
            if (!optOutPresent) await db.unsuppress('live', invoiceId);
          } else if (action === 'resume') {
            if (optOutPresent) throw new Error('Contact cannot be resumed: this debtor opted out');
            if (inv.status === 'escalated') await ledger.reopen(invoiceId);
            else if (inv.status === 'disputed') throw new Error('Resolve the dispute before resuming contact');
            await db.unsuppress('live', invoiceId);
          } else if (action === 'approve_plan') {
            if (inv.status !== 'open') throw new Error(`Plan cannot be sent: invoice is ${inv.status}, not open`);
            if (optOutPresent) throw new Error('Plan cannot be sent: this debtor opted out');
            if (suppressions.has(invoiceId)) throw new Error('Plan cannot be sent while contact is paused');
            const detail = (item.detail ?? {}) as { draft?: unknown };
            const draft = checkDraft(detail.draft);
            if (!draft || draft.action !== 'offer_plan' || !draft.instalments?.length) throw new Error('Stored plan draft is missing or invalid');
            const playbookRaw = String((item.detail as { playbook?: unknown } | undefined)?.playbook ?? '');
            if (!PLAYBOOKS.includes(playbookRaw as Playbook)) throw new Error('Stored plan is missing its playbook');
            const playbook = playbookRaw as Playbook;
            if (!settings.enabledPlaybooks.includes(playbook)) throw new Error(`Playbook ${playbook} is disabled. Keep paused or enable it in Settings first`);
            const stats = await ledger.stats();
            const verdict = gate(draft, inv, events, stats.worldDay, { ...policyFromSettings(settings), plan_human_above_cents: Number.MAX_SAFE_INTEGER });
            if (!verdict.ok) throw new Error(`Stored plan no longer passes policy: ${verdict.reason}`);
            const all = await ledger.allInvoices(1000);
            const segment = segmentOf(all.filter((i) => i.debtorId === inv.debtorId), events, stats.worldDay);
            await ledger.createPlan(invoiceId, draft.instalments);
            await ledger.logContact(invoiceId, playbook, settings.tones[playbook], draft.message);
            await recordContactTrial(ledger, 'live', inv.id, stats.worldDay, segment, playbook);
            await db.recordDecision({ scope: 'live', invoiceId, worldDay: stats.worldDay, segment, playbook, action: draft.action, outcome: 'human-approved-plan', why: 'Human approved the stored plan after fresh policy checks.' });
          }
          await db.resolveQueue(qid, action);
          redirect(res, returnTo, `${invoiceId}: ${QUEUE_ACTION_LABELS[action as QueueAction]}`);
        } catch (e) {
          redirect(res, returnTo, undefined, e instanceof Error ? e.message : String(e));
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/control') {
        const form = await readForm(req);
        const action = form.get('action');
        try {
          if (action === 'pause' || action === 'resume') {
            const settings = await loadSettings('live');
            await saveSettings('live', { ...settings, enabled: action === 'resume' }, 'dashboard');
            redirect(res, '/', action === 'pause' ? 'Agent paused. Scheduled sweeps will now be no-ops.' : 'Agent resumed.');
            return;
          }
          if (action === 'run_now') {
            const settings = await loadSettings('live');
            if (!settings.enabled) throw new Error('Agent is paused. Resume it before running.');
            const result = await sweep({ ledgerUrl, forceSchedule: true, source: 'dashboard' });
            if (result.busy) redirect(res, '/', 'Another sweep is already running. Nothing was started.');
            else if (result.skipped) redirect(res, '/', `Sweep skipped: ${result.skipped}`);
            else redirect(res, '/', `Sweep complete: ${result.contacted} contacts, ${result.plansOffered} plans, ${result.queued} queued, ${result.waited} waiting, cost $${result.costUsd.toFixed(4)}. World day is now ${result.worldDayAfter}.`);
            return;
          }
          throw new Error('Unknown control action');
        } catch (e) { redirect(res, '/', undefined, e instanceof Error ? e.message : String(e)); return; }
      }

      if (req.method === 'POST' && url.pathname === '/settings/save') {
        const form = await readForm(req);
        try {
          const tones = Object.fromEntries(PLAYBOOKS.map((p) => [p, form.get(`tone_${p}`) ?? '']));
          const templates = Object.fromEntries(PLAYBOOKS.map((p) => [p, form.get(`template_${p}`) ?? '']));
          const humanDollars = Number(String(form.get('planHumanAboveDollars') ?? '').replace(/[$,\s]/g, ''));
          await saveSettings('live', {
            enabled: form.has('enabled'),
            draftModel: form.get('draftModel'),
            budgetUsd: form.get('budgetUsd'),
            timezone: form.get('timezone'),
            sendDays: form.getAll('sendDays'),
            sendStart: form.get('sendStart'),
            sendEnd: form.get('sendEnd'),
            preDueReminderDays: form.get('preDueReminderDays'),
            minGapDays: form.get('minGapDays'),
            maxContactsPerInvoice: form.get('maxContactsPerInvoice'),
            maxOverdueDays: form.get('maxOverdueDays'),
            planMaxInstalments: form.get('planMaxInstalments'),
            planMaxDays: form.get('planMaxDays'),
            planMinFirstPct: form.get('planMinFirstPct'),
            planHumanAboveCents: Math.round(humanDollars * 100),
            explorationPct: form.get('explorationPct'),
            rewardWindowDays: form.get('rewardWindowDays'),
            enabledPlaybooks: form.getAll('enabledPlaybooks'),
            tones,
            templates,
          }, 'dashboard');
          redirect(res, '/settings', 'Settings saved. They apply to the next live sweep.');
        } catch (e) { redirect(res, '/settings', undefined, e instanceof Error ? e.message : String(e)); }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/settings/reset') {
        await readForm(req);
        try {
          await saveSettings('live', defaultSettings(), 'dashboard reset');
          redirect(res, '/settings', 'Settings reset to recommended defaults.');
        } catch (e) { redirect(res, '/settings', undefined, e instanceof Error ? e.message : String(e)); }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/clients/add-invoice') {
        const form = await readForm(req);
        const debtorId = form.get('debtorId')?.trim() || undefined;
        try {
          const stats = await ledger.stats();
          const dueInDays = Number(form.get('dueInDays'));
          if (!Number.isInteger(dueInDays) || dueInDays < -365 || dueInDays > 3650) throw new Error('Due-in-days must be a whole number from -365 to 3650');
          const invoiceId = await ledger.createInvoice({
            debtorId,
            debtorName: form.get('debtorName')?.trim() || undefined,
            debtorEmail: form.get('debtorEmail')?.trim() || undefined,
            amountCents: parseDollarsToCents(form.get('amount')),
            dueDay: stats.worldDay + dueInDays,
          });
          redirect(res, `/invoice?id=${encodeURIComponent(invoiceId)}`, `Invoice ${invoiceId} added.`);
        } catch (e) { redirect(res, debtorId ? `/client?id=${encodeURIComponent(debtorId)}` : '/clients', undefined, e instanceof Error ? e.message : String(e)); }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/clients/update') {
        const form = await readForm(req);
        const returnTo = form.get('returnTo') || '/clients';
        try {
          const debtorId = form.get('debtorId')?.trim();
          if (!debtorId) throw new Error('Missing client ID');
          await ledger.updateDebtor(debtorId, form.get('name')?.trim() ?? '', form.get('email')?.trim() ?? '');
          redirect(res, returnTo, 'Client saved.');
        } catch (e) { redirect(res, returnTo, undefined, e instanceof Error ? e.message : String(e)); }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/invoice/action') {
        const form = await readForm(req);
        const invoiceId = form.get('invoiceId')?.trim() ?? '';
        const back = invoiceId ? `/invoice?id=${encodeURIComponent(invoiceId)}` : '/clients';
        try {
          if (!invoiceId) throw new Error('Missing invoice ID');
          const action = form.get('action');
          const [inv, events, stats, settings, suppressions, queue] = await Promise.all([
            ledger.invoice(invoiceId), ledger.invoiceEvents(invoiceId), ledger.stats(), loadSettings('live'), db.suppressionDetails('live'), db.openQueue('live'),
          ]);
          if (!inv) throw new Error(`Invoice ${invoiceId} not found`);
          const policy = policyFromSettings(settings);
          const suppressionReason = suppressions.get(invoiceId) ?? null;
          const optOutPresent = queue.some((q) => String(q.invoice_id) === invoiceId && String(q.kind) === 'optout')
            || suppressionReason === 'debtor asked us to stop'
            || events.some((e) => e.kind === 'reply' && replySignal(e.detail) === 'optout');
          const segmentFor = async () => {
            const all = await ledger.allInvoices(1000);
            return segmentOf(all.filter((i) => i.debtorId === inv.debtorId), events, stats.worldDay);
          };
          const requireContactAllowed = () => {
            if (inv.status !== 'open') throw new Error(`Invoice is ${inv.status}, not open`);
            if (remainingCents(inv) <= 0) throw new Error('Invoice has no remaining balance');
            if (optOutPresent) throw new Error('Contact is locked: this debtor opted out');
            if (suppressionReason) throw new Error(`Contact is paused: ${suppressionReason}`);
          };
          const validPlaybook = (): Playbook => {
            const p = form.get('playbook');
            if (!p || !PLAYBOOKS.includes(p as Playbook)) throw new Error('Choose a valid playbook');
            if (!settings.enabledPlaybooks.includes(p as Playbook)) throw new Error(`Playbook ${p} is disabled in Settings`);
            return p as Playbook;
          };

          let message = 'Done.';
          if (action === 'pause') {
            await db.suppress('live', invoiceId, 'Paused from dashboard');
            message = 'Contact paused for this invoice.';
          } else if (action === 'resume') {
            if (optOutPresent) throw new Error('Cannot resume: this debtor opted out');
            if (inv.status === 'disputed') throw new Error('Resolve the dispute before resuming contact');
            if (inv.status === 'escalated') await ledger.reopen(invoiceId);
            await db.unsuppress('live', invoiceId);
            message = 'Contact resumed.';
          } else if (action === 'escalate') {
            if (inv.status === 'open') await ledger.escalate(invoiceId, form.get('reason')?.trim() || 'Escalated from invoice dashboard.');
            await db.suppress('live', invoiceId, 'Escalated from dashboard');
            await db.enqueue('live', invoiceId, 'escalated', 'Operator escalated this invoice from the dashboard.', {});
            message = 'Invoice escalated to a person.';
          } else if (action === 'reopen') {
            if (optOutPresent) throw new Error('Cannot return an opted-out debtor to automated contact');
            await ledger.reopen(invoiceId);
            await db.unsuppress('live', invoiceId);
            message = 'Invoice returned to the agent.';
          } else if (action === 'resolve_dispute') {
            await ledger.resolveDispute(invoiceId);
            if (!optOutPresent) await db.unsuppress('live', invoiceId);
            message = 'Dispute marked resolved.';
          } else if (action === 'record_payment') {
            await ledger.recordPayment(invoiceId, parseDollarsToCents(form.get('paymentAmount')), form.get('paymentNote')?.trim() ?? '');
            message = 'Payment recorded.';
          } else if (action === 'record_promise') {
            if (inv.status === 'paid') throw new Error('Invoice is already paid');
            if (inv.status === 'disputed') throw new Error('Resolve the dispute before recording a payment promise');
            const inDays = Number(form.get('promiseInDays'));
            if (!Number.isInteger(inDays) || inDays < 0 || inDays > 90) throw new Error('Promise must be 0–90 days from today');
            await ledger.recordPromise(invoiceId, stats.worldDay + inDays);
            message = `Promise recorded for world day ${stats.worldDay + inDays}.`;
          } else if (action === 'send_message') {
            requireContactAllowed();
            const playbook = validPlaybook();
            const draft = checkDraft({ action: 'contact', message: form.get('message') ?? '', why: 'Manual dashboard reminder.' });
            if (!draft) throw new Error('Message failed the draft check (empty/overlong, discount-like wording, or malformed)');
            const verdict = gate(draft, inv, events, stats.worldDay, policy);
            if (!verdict.ok) throw new Error(`Blocked by policy: ${verdict.reason}`);
            const segment = await segmentFor();
            await ledger.logContact(invoiceId, playbook, settings.tones[playbook], draft.message);
            await recordContactTrial(ledger, 'live', inv.id, stats.worldDay, segment, playbook);
            await db.recordDecision({ scope: 'live', invoiceId, worldDay: stats.worldDay, segment, playbook, action: draft.action, outcome: 'manual-contact', why: 'Operator sent this reminder from the dashboard.' });
            message = 'Reminder sent through the policy gate.';
          } else if (action === 'create_plan') {
            requireContactAllowed();
            const playbook = validPlaybook();
            const count = Number(form.get('planCount'));
            const firstIn = Number(form.get('planFirstInDays'));
            const every = Number(form.get('planEveryDays'));
            if (!Number.isInteger(count) || count < 1 || count > settings.planMaxInstalments) throw new Error(`Instalments must be 1–${settings.planMaxInstalments}`);
            if (!Number.isInteger(firstIn) || firstIn < 1) throw new Error('First payment must be at least 1 day ahead');
            if (!Number.isInteger(every) || every < 0) throw new Error('Instalment spacing cannot be negative');
            const remaining = remainingCents(inv);
            const base = Math.floor(remaining / count);
            const remainder = remaining - base * count;
            const instalments = Array.from({ length: count }, (_, i) => ({
              day: stats.worldDay + firstIn + i * every,
              amountCents: base + (i < remainder ? 1 : 0),
            }));
            const draft = checkDraft({ action: 'offer_plan', message: form.get('message') ?? '', instalments, why: 'Manual dashboard payment plan.' });
            if (!draft) throw new Error('Plan draft failed validation');
            const verdict = gate(draft, inv, events, stats.worldDay, { ...policy, plan_human_above_cents: Number.MAX_SAFE_INTEGER });
            if (!verdict.ok) throw new Error(`Blocked by policy: ${verdict.reason}`);
            const segment = await segmentFor();
            await ledger.createPlan(invoiceId, instalments);
            await ledger.logContact(invoiceId, playbook, settings.tones[playbook], draft.message);
            await recordContactTrial(ledger, 'live', inv.id, stats.worldDay, segment, playbook);
            await db.recordDecision({ scope: 'live', invoiceId, worldDay: stats.worldDay, segment, playbook, action: draft.action, outcome: 'manual-plan', why: 'Operator created this plan from the dashboard.' });
            message = 'Payment plan created and sent through the policy gate.';
          } else {
            throw new Error('Unknown invoice action');
          }
          redirect(res, back, message);
        } catch (e) { redirect(res, back, undefined, e instanceof Error ? e.message : String(e)); }
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  console.log(`remit control room on :${port} (ledger ${ledgerUrl})`);
}
