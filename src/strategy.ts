import { latestPromise, type Invoice, type LedgerEvent } from './ledger.js';

// Remit's edge over template dunning: it segments debtors by OBSERVED
// behaviour (never by peeking at simulator labels, which production
// does not have) and runs a small epsilon-greedy experiment over lawful
// contact playbooks per segment. Payments within 7 days of a contact
// reward that playbook. Over time each segment converges on what
// actually gets it paid — inside the same policy rails for everyone.

export const PLAYBOOKS = ['friendly-plan-early', 'formal-firm', 'friendly-remind-only'] as const;
export type Playbook = (typeof PLAYBOOKS)[number];

export const PLAYBOOK_TONE: Record<Playbook, string> = {
  'friendly-plan-early': 'warm and helpful; offer a payment plan in the first contact',
  'formal-firm': 'formal and factual; state amount, due date and consequences for the business relationship, no threats',
  'friendly-remind-only': 'warm and brief; assume an oversight, ask for payment or a promise date, no plan yet',
};

export type Segment = 'new' | 'usually-pays' | 'slow-payer' | 'promised-before' | 'promise-broken' | 'silent';

export function segmentOf(debtorInvoices: Invoice[], events: LedgerEvent[], worldDay: number): Segment {
  const hasPromise = events.some((e) => e.kind === 'promise');
  const promise = latestPromise(events);
  const hasReply = events.some((e) => e.kind === 'reply');
  const contacts = events.filter((e) => e.kind === 'contact').length;
  const paid = debtorInvoices.filter((i) => i.status === 'paid');
  if (promise && !promise.paymentAfter && promise.promisedDay < worldDay) return 'promise-broken';
  if (hasPromise) return 'promised-before';
  if (paid.length > 0) {
    const lateDays = paid.map((i) => (i.paidDay ?? i.dueDay) - i.dueDay);
    return lateDays.some((d) => d > 10) ? 'slow-payer' : 'usually-pays';
  }
  if (contacts >= 2 && !hasReply) return 'silent';
  if (contacts === 0 && worldDay <= Math.min(...debtorInvoices.map((i) => i.dueDay))) return 'new';
  return hasReply ? 'slow-payer' : 'new';
}

export type PlaybookStat = { playbook: Playbook; contacts: number; rewards: number };

let seedState = 1234567;
export function setBanditSeed(n: number): void { seedState = n || 1; }
function rnd(): number {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
}

// Epsilon-greedy with an optimism bonus for untried playbooks.
export function choosePlaybook(stats: PlaybookStat[], epsilon = 0.15): Playbook {
  const byName = new Map(stats.map((s) => [s.playbook, s]));
  const untried = PLAYBOOKS.filter((p) => !(byName.get(p)?.contacts));
  if (untried.length) return untried[0];
  if (rnd() < epsilon) return PLAYBOOKS[Math.floor(rnd() * PLAYBOOKS.length)];
  let best: Playbook = PLAYBOOKS[0];
  let bestRate = -1;
  for (const p of PLAYBOOKS) {
    const s = byName.get(p);
    const rate = s && s.contacts ? s.rewards / s.contacts : 0;
    if (rate > bestRate) { bestRate = rate; best = p; }
  }
  return best;
}

export type ContactTrial = {
  contactEventId: number;
  invoiceId: string;
  worldDay: number;
  segment: Segment;
  playbook: Playbook;
  rewardedPaymentEventId: number | null;
};

// A payment is attributed to the latest contact inside the window. The
// caller must still enforce the binary-trial rule: if that contact has
// already been rewarded, later partial/instalment payments do not fall
// through and reward an older contact instead.
export function attributionTarget(
  trials: ContactTrial[],
  payment: LedgerEvent,
  windowDays = 7,
): ContactTrial | null {
  return trials
    .filter((trial) =>
      trial.invoiceId === payment.invoiceId &&
      trial.worldDay <= payment.day &&
      payment.day - trial.worldDay <= windowDays)
    .sort((a, b) => b.worldDay - a.worldDay || b.contactEventId - a.contactEventId)[0] ?? null;
}

// Retained for interpreting pre-trial ledger histories. New contacts use
// remit.contact_trials, which freezes segment/playbook at contact time.
export function rewardTarget(events: LedgerEvent[], payment: LedgerEvent, windowDays = 7): { playbook: Playbook; contactId: number } | null {
  let found: { playbook: Playbook; contactId: number } | null = null;
  for (const e of events) {
    if (e.kind !== 'contact' || e.invoiceId !== payment.invoiceId) continue;
    if (e.day <= payment.day && payment.day - e.day <= windowDays) {
      try {
        const parsed = JSON.parse(e.detail) as { playbook?: string };
        if (parsed.playbook && (PLAYBOOKS as readonly string[]).includes(parsed.playbook)) {
          found = { playbook: parsed.playbook as Playbook, contactId: e.id };
        }
      } catch { /* older/plain detail */ }
    }
  }
  return found;
}
