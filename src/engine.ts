import * as db from './db.js';
import { Ledger, daysOverdue, remainingCents, type Invoice } from './ledger.js';
import { gate, replySignal } from './policy.js';
import { draftStep, baselineDraft } from './draft.js';
import { checkDraft } from './policy.js';
import { attributionTarget, choosePlaybook, segmentOf, type Playbook, type Segment } from './strategy.js';

// One business day of collection work. Order matters:
//  1) read new ledger events (replies/payments) — disputes, opt-outs and
//     distress go to humans before any new contact is drafted;
//  2) credit playbooks for payments that followed their contacts;
//  3) for each actionable invoice, pick a playbook (bandit), draft,
//     gate through policy, and only then touch the ledger.

export type DayStats = {
  day: number; considered: number; contacted: number; plansOffered: number;
  escalated: number; waited: number; queued: number; rewardsCredited: number; costUsd: number;
};

export type EngineOptions = {
  ledger: Ledger;
  draftModel: string;
  scope: string;
  strategy: 'remit' | 'template';
  budgetUsd: number;
  spentUsd: () => number;
};

const TEMPLATE_DAYS = new Set([1, 7, 14, 21, 28, 35, 42, 49, 56]);

// Contact counting and reward attribution share one immutable trial row.
// The ledger event id is fetched immediately after the contact is logged;
// this freezes the segment/playbook that were true at contact time.
export async function recordContactTrial(
  ledger: Ledger,
  scope: string,
  invoiceId: string,
  worldDay: number,
  segment: Segment,
  playbook: Playbook,
): Promise<void> {
  const afterEvents = await ledger.invoiceEvents(invoiceId);
  const contactEvent = [...afterEvents].reverse().find((e) => e.kind === 'contact');
  if (!contactEvent) throw new Error(`Ledger accepted contact for ${invoiceId} but returned no contact event`);
  await db.recordContactTrial(scope, {
    contactEventId: contactEvent.id,
    invoiceId,
    worldDay,
    segment,
    playbook,
  });
  await db.bumpPlaybook(scope, segment, playbook, 1, 0);
}

export async function runDay(o: EngineOptions): Promise<DayStats> {
  const stats: DayStats = { day: 0, considered: 0, contacted: 0, plansOffered: 0, escalated: 0, waited: 0, queued: 0, rewardsCredited: 0, costUsd: 0 };
  const ledgerStats = await o.ledger.stats();
  const worldDay = ledgerStats.worldDay;
  stats.day = worldDay;
  const scope = o.scope;

  // 1) New events since our cursor.
  const cursorKey = `${scope}:last_event_id`;
  const lastEventId = Number((await db.getState(cursorKey)) ?? 0);
  const fresh = await o.ledger.eventsAfter(lastEventId);
  const suppressedNow = await db.suppressed(scope);
  let maxEventId = lastEventId;
  const allInvoices = await o.ledger.allInvoices();

  for (const e of fresh) {
    maxEventId = Math.max(maxEventId, e.id);
    if (e.kind === 'reply') {
      const signal = replySignal(e.detail);
      if (signal === 'optout') {
        await db.suppress(scope, e.invoiceId, 'debtor asked us to stop');
        suppressedNow.add(e.invoiceId);
        await db.enqueue(scope, e.invoiceId, 'optout', 'Debtor asked for no further contact. Suppressed; a person owns next steps.', { reply: e.detail });
        stats.queued++;
      } else if (signal === 'dispute' || signal === 'distress') {
        await db.suppress(scope, e.invoiceId, signal);
        suppressedNow.add(e.invoiceId);
        await db.enqueue(scope, e.invoiceId, signal, `Debtor reply signals ${signal}; contacting paused for a person.`, { reply: e.detail });
        stats.queued++;
      }
    }
    if (e.kind === 'payment') {
      // 2) Reward only the latest in-window contact trial, under the
      // segment frozen when that contact was sent. A second partial or
      // instalment payment cannot reward the same contact—or an older
      // contact—again.
      const trials = await db.contactTrials(scope, e.invoiceId);
      const target = attributionTarget(trials, e);
      if (target && target.rewardedPaymentEventId === null) {
        const credited = await db.markContactTrialRewarded(scope, target.contactEventId, e.id);
        if (credited) {
          await db.bumpPlaybook(scope, target.segment, target.playbook, 0, 1);
          stats.rewardsCredited++;
        }
      }
    }
  }
  if (maxEventId !== lastEventId) await db.setState(cursorKey, String(maxEventId));

  // 3) Actionable invoices: open, not suppressed, due soon or overdue.
  const open = allInvoices.filter((i) => i.status === 'open' && remainingCents(i) > 0);
  for (const inv of open) {
    const overdue = daysOverdue(inv, worldDay);
    if (overdue < -2) continue; // not yet within the friendly pre-due window
    if (suppressedNow.has(inv.id)) continue;
    stats.considered++;
    if (o.spentUsd() + stats.costUsd > o.budgetUsd) { stats.waited++; continue; }

    const events = await o.ledger.invoiceEvents(inv.id);
    const siblings = allInvoices.filter((i) => i.debtorId === inv.debtorId);
    const segment = segmentOf(siblings, events, worldDay);

    let playbook: Playbook;
    let draft;
    let cost = 0;
    if (o.strategy === 'template') {
      // Fixed dunning calendar: the industry-default comparator.
      if (!TEMPLATE_DAYS.has(overdue)) { stats.waited++; continue; }
      playbook = 'formal-firm';
      draft = checkDraft(baselineDraft({ inv, events, worldDay, segment, playbook }));
    } else {
      const statsForSegment = await db.playbookStats(scope, segment);
      playbook = choosePlaybook(statsForSegment);
      const out = await draftStep({ inv, events, worldDay, segment, playbook }, o.draftModel);
      draft = out.draft;
      cost = out.costUsd;
    }
    stats.costUsd += cost;

    const verdict = gate(draft, inv, events, worldDay);
    if (!verdict.ok) {
      if (verdict.outcome === 'queued') {
        await db.enqueue(scope, inv.id, 'policy', verdict.reason, { draft, segment, playbook });
        stats.queued++;
      } else stats.waited++;
      await db.recordDecision({ scope, invoiceId: inv.id, worldDay, segment, playbook, action: draft.action, outcome: verdict.outcome, why: `${draft.why} | gate: ${verdict.reason}` });
      continue;
    }

    if (verdict.action === 'wait') {
      stats.waited++;
      await db.recordDecision({ scope, invoiceId: inv.id, worldDay, segment, playbook, action: 'wait', outcome: 'waited', why: draft.why });
    } else if (verdict.action === 'escalate') {
      await o.ledger.escalate(inv.id, draft.why);
      await db.suppress(scope, inv.id, 'escalated');
      suppressedNow.add(inv.id);
      await db.enqueue(scope, inv.id, 'escalation', draft.why);
      stats.escalated++;
      await db.recordDecision({ scope, invoiceId: inv.id, worldDay, segment, playbook, action: 'escalate', outcome: 'escalated', why: draft.why });
    } else if (verdict.action === 'contact') {
      await o.ledger.logContact(inv.id, playbook, playbook, draft.message);
      await recordContactTrial(o.ledger, scope, inv.id, worldDay, segment, playbook);
      stats.contacted++;
      await db.recordDecision({ scope, invoiceId: inv.id, worldDay, segment, playbook, action: 'contact', outcome: 'contacted', why: draft.why });
    } else if (verdict.action === 'offer_plan') {
      await o.ledger.createPlan(inv.id, draft.instalments ?? []);
      await o.ledger.logContact(inv.id, playbook, playbook, draft.message);
      await recordContactTrial(o.ledger, scope, inv.id, worldDay, segment, playbook);
      stats.contacted++;
      stats.plansOffered++;
      await db.recordDecision({ scope, invoiceId: inv.id, worldDay, segment, playbook, action: 'offer_plan', outcome: 'plan_offered', why: draft.why });
    }
  }
  return stats;
}

export type { Invoice };
