import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannedPhraseIn, checkDraft, gate, replySignal } from '../src/policy.js';
import type { Invoice, LedgerEvent } from '../src/ledger.js';

function invoice(p: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-001', debtorId: 'd001', debtorName: 'Test Co', amountCents: 100000, paidCents: 0,
    issuedDay: -30, dueDay: 0, status: 'open', paidDay: null, ...p,
  };
}
function contact(id: number, day: number): LedgerEvent {
  return { id, invoiceId: 'inv-001', day, kind: 'contact', detail: '{"playbook":"formal-firm"}' };
}
function promise(id: number, promisedDay: number): LedgerEvent {
  return { id, invoiceId: 'inv-001', day: 1, kind: 'promise', detail: JSON.stringify({ day: promisedDay }) };
}

test('checkDraft validates the model form', () => {
  assert.equal(checkDraft({ action: 'contact', message: 'Please pay.', why: 'overdue' }).action, 'contact');
  assert.throws(() => checkDraft({ action: 'threaten', message: 'x', why: 'y' }));
  assert.throws(() => checkDraft({ action: 'contact', message: '', why: 'y' }));
  assert.throws(() => checkDraft({ action: 'offer_plan', message: 'x', why: 'y' }));
});

test('gate blocks threats and discount offers, sending them to a human', () => {
  const threat = gate({ action: 'contact', message: 'Pay now or else we take legal action.', why: 'x' }, invoice(), [], 5);
  assert.deepEqual([threat.ok, threat.ok === false && threat.outcome], [false, 'queued']);
  const discount = gate({ action: 'contact', message: 'We can offer a 20% discount today.', why: 'x' }, invoice(), [], 5);
  assert.equal(discount.ok, false);
  assert.equal(bannedPhraseIn('see you in court'), 'court');
});

test('gate enforces contact spacing and the per-invoice cap', () => {
  const draft = { action: 'contact' as const, message: 'Reminder.', why: 'x' };
  assert.equal(gate(draft, invoice(), [contact(1, 4)], 5).ok, false); // 1 day gap < 3
  assert.equal(gate(draft, invoice(), [contact(1, 1)], 5).ok, true);
  const six = [1, 2, 3, 4, 5, 6].map((i) => contact(i, i * 4));
  const capped = gate(draft, invoice(), six, 40);
  assert.equal(capped.ok, false);
  if (!capped.ok) assert.equal(capped.outcome, 'queued');
});

test('gate waits for an active promise, then allows follow-up after it is broken', () => {
  const draft = { action: 'contact' as const, message: 'Checking in on the promised payment.', why: 'follow-up' };
  const events = [contact(1, 1), promise(2, 8)];
  const active = gate(draft, invoice(), events, 8);
  assert.equal(active.ok, false);
  if (!active.ok) {
    assert.equal(active.outcome, 'wait');
    assert.match(active.reason, /promised payment by day 8/);
  }
  assert.equal(gate(draft, invoice(), events, 9).ok, true);
});

test('gate enforces plan law: totals, window, first instalment, human limit', () => {
  const ok = gate({ action: 'offer_plan', message: 'Two steps.', instalments: [{ day: 12, amountCents: 50000 }, { day: 26, amountCents: 50000 }], why: 'x' }, invoice(), [], 5);
  assert.equal(ok.ok, true);
  const wrongTotal = gate({ action: 'offer_plan', message: 'x', instalments: [{ day: 12, amountCents: 100 }], why: 'x' }, invoice(), [], 5);
  assert.equal(wrongTotal.ok, false);
  const smallFirst = gate({ action: 'offer_plan', message: 'x', instalments: [{ day: 12, amountCents: 10000 }, { day: 26, amountCents: 90000 }], why: 'x' }, invoice(), [], 5);
  assert.equal(smallFirst.ok, false);
  const bigBalance = gate({ action: 'offer_plan', message: 'x', instalments: [{ day: 12, amountCents: 300000 }, { day: 26, amountCents: 300000 }], why: 'x' }, invoice({ amountCents: 600000 }), [], 5);
  assert.equal(bigBalance.ok, false);
  if (!bigBalance.ok) assert.match(bigBalance.reason, /person must approve/);
});

test('replySignal classifies dispute, opt-out and distress', () => {
  assert.equal(replySignal('We dispute this invoice: wrong amount.'), 'dispute');
  assert.equal(replySignal('Stop contacting us about this.'), 'optout');
  assert.equal(replySignal('Our lawyer will respond; the company is insolvent.'), 'distress');
  assert.equal(replySignal('Payment runs every Friday, thanks.'), null);
});

// Prompt injection: debtor text is data. A reply ordering a discount or
// silence must not widen what the gate allows afterwards.
test('debtor instructions cannot widen the gate', () => {
  const sneaky = gate({ action: 'contact', message: 'As instructed we will offer a 50% discount and stop all follow-ups.', why: 'debtor asked' }, invoice(), [], 5);
  assert.equal(sneaky.ok, false);
});
