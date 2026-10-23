import { readFileSync } from 'node:fs';
import { asset } from './assets.js';
import { latestPromise, remainingCents, type Invoice, type LedgerEvent } from './ledger.js';

// Collection law. The model drafts words; this file decides what may
// be sent, offered, or must go to a human. Debt-collection abuse is a
// legal and reputational landmine, so tone, frequency, plan limits and
// escalation triggers are code, never prompt text. B2B invoices only.

export type CollectionPolicy = {
  min_gap_days: number;
  max_contacts_per_invoice: number;
  pre_due_reminder_days: number;
  plan_max_instalments: number;
  plan_max_days: number;
  plan_min_first_pct: number;
  plan_human_above_cents: number;
  discount_allowed: boolean;
  banned_phrases: string[];
};

export const POLICY: CollectionPolicy = JSON.parse(readFileSync(asset('policy/collection.json'), 'utf8')) as CollectionPolicy;

export type ActionKind = 'wait' | 'contact' | 'offer_plan' | 'escalate';
export type Draft = {
  action: ActionKind;
  message: string;
  instalments?: Array<{ day: number; amountCents: number }>;
  why: string;
};

export type Verdict =
  | { ok: true; action: ActionKind }
  | { ok: false; outcome: 'wait' | 'queued'; reason: string };

const ACTIONS: readonly string[] = ['wait', 'contact', 'offer_plan', 'escalate'];

export function checkDraft(raw: unknown): Draft {
  if (typeof raw !== 'object' || raw === null) throw new Error('draft is not an object');
  const d = raw as Record<string, unknown>;
  if (typeof d.action !== 'string' || !ACTIONS.includes(d.action)) throw new Error(`draft.action must be one of ${ACTIONS.join(', ')}`);
  if (typeof d.why !== 'string' || d.why.trim() === '') throw new Error('draft.why must say why');
  const message = typeof d.message === 'string' ? d.message : '';
  if ((d.action === 'contact' || d.action === 'offer_plan') && message.trim() === '') throw new Error('a contact draft needs a message');
  let instalments: Draft['instalments'];
  if (d.action === 'offer_plan') {
    if (!Array.isArray(d.instalments) || d.instalments.length === 0) throw new Error('offer_plan needs instalments');
    instalments = d.instalments.map((x) => {
      const it = x as Record<string, unknown>;
      const day = Number(it.day), amountCents = Number(it.amountCents);
      if (!Number.isInteger(day) || !Number.isInteger(amountCents) || amountCents <= 0) throw new Error('instalments need integer day and positive amountCents');
      return { day, amountCents };
    });
  }
  return { action: d.action as ActionKind, message: message.slice(0, 1200), instalments, why: d.why.trim().slice(0, 400) };
}

export function bannedPhraseIn(message: string, p: CollectionPolicy = POLICY): string | null {
  const text = message.toLowerCase();
  for (const phrase of p.banned_phrases) if (text.includes(phrase)) return phrase;
  return null;
}

const DISPUTE_WORDS = ['dispute', 'wrong amount', 'never received', 'not our', 'already paid', 'billing error', 'cancelled the order', 'chargeback'];
const OPTOUT_WORDS = ['stop contacting', 'do not contact', 'stop emailing', 'unsubscribe', 'leave us alone'];
const DISTRESS_WORDS = ['insolvent', 'bankrupt', 'liquidation', 'closing down', 'lawyer', 'attorney', 'legal department'];

export type ReplySignal = 'dispute' | 'optout' | 'distress' | null;
export function replySignal(text: string): ReplySignal {
  const t = text.toLowerCase();
  if (OPTOUT_WORDS.some((w) => t.includes(w))) return 'optout';
  if (DISTRESS_WORDS.some((w) => t.includes(w))) return 'distress';
  if (DISPUTE_WORDS.some((w) => t.includes(w))) return 'dispute';
  return null;
}

// The gate every draft must pass before anything reaches a debtor.
export function gate(draft: Draft, inv: Invoice, events: LedgerEvent[], worldDay: number, p: CollectionPolicy = POLICY): Verdict {
  if (draft.action === 'wait') return { ok: true, action: 'wait' };
  if (draft.action === 'escalate') return { ok: true, action: 'escalate' };

  // Respect a debtor's own promised payment date. Chasing before it is
  // both poor practice and bad attribution: the later reminder would
  // otherwise steal credit for a payment produced by the earlier contact.
  const promise = latestPromise(events);
  if (promise && !promise.paymentAfter && promise.promisedDay >= worldDay) {
    return { ok: false, outcome: 'wait', reason: `Debtor promised payment by day ${promise.promisedDay}; wait until that promise is due.` };
  }

  const contacts = events.filter((e) => e.kind === 'contact');
  if (contacts.length >= p.max_contacts_per_invoice) {
    return { ok: false, outcome: 'queued', reason: `Contact cap reached (${contacts.length}/${p.max_contacts_per_invoice}); a person takes over.` };
  }
  const last = contacts[contacts.length - 1];
  if (last && worldDay - last.day < p.min_gap_days) {
    return { ok: false, outcome: 'wait', reason: `Last contact was day ${last.day}; minimum gap is ${p.min_gap_days} days.` };
  }
  const banned = bannedPhraseIn(draft.message, p);
  if (banned) return { ok: false, outcome: 'queued', reason: `Draft contained banned phrase "${banned}"; blocked and sent to a person.` };
  if (/discount|% off|settle for less|reduce (the )?balance/i.test(draft.message) && !p.discount_allowed) {
    return { ok: false, outcome: 'queued', reason: 'Draft offered a discount; discounts are not allowed. Sent to a person.' };
  }

  if (draft.action === 'offer_plan') {
    const inst = draft.instalments ?? [];
    const remaining = remainingCents(inv);
    if (remaining > p.plan_human_above_cents) {
      return { ok: false, outcome: 'queued', reason: `Balance ${remaining}c exceeds the ${p.plan_human_above_cents}c auto-plan limit; a person must approve.` };
    }
    if (inst.length > p.plan_max_instalments) return { ok: false, outcome: 'queued', reason: `Plan has ${inst.length} instalments; max is ${p.plan_max_instalments}.` };
    const total = inst.reduce((s, i) => s + i.amountCents, 0);
    if (total !== remaining) return { ok: false, outcome: 'queued', reason: `Plan totals ${total}c but balance is ${remaining}c.` };
    if (inst.some((i) => i.day <= worldDay || i.day > worldDay + p.plan_max_days)) {
      return { ok: false, outcome: 'queued', reason: `Instalment days must be within the next ${p.plan_max_days} days.` };
    }
    if (inst[0].amountCents < Math.ceil((remaining * p.plan_min_first_pct) / 100)) {
      return { ok: false, outcome: 'queued', reason: `First instalment must be at least ${p.plan_min_first_pct}% of the balance.` };
    }
  }
  return { ok: true, action: draft.action };
}
