import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributionTarget, choosePlaybook, rewardTarget, segmentOf, setBanditSeed, type ContactTrial } from '../src/strategy.js';
import type { Invoice, LedgerEvent } from '../src/ledger.js';

function inv(p: Partial<Invoice>): Invoice {
  return { id: 'inv-1', debtorId: 'd1', debtorName: 'T', amountCents: 1000, paidCents: 0, issuedDay: -30, dueDay: 0, status: 'open', paidDay: null, ...p };
}
function ev(p: Partial<LedgerEvent>): LedgerEvent {
  return { id: 1, invoiceId: 'inv-1', day: 1, kind: 'contact', detail: '{"playbook":"formal-firm"}', ...p };
}

test('segmentOf infers from observed behaviour only', () => {
  assert.equal(segmentOf([inv({})], [], 0), 'new');
  assert.equal(segmentOf([inv({ status: 'paid', paidDay: 28, dueDay: 30 })], [], 40), 'usually-pays');
  assert.equal(segmentOf([inv({ status: 'paid', paidDay: 45, dueDay: 30 })], [], 50), 'slow-payer');
  assert.equal(segmentOf([inv({})], [ev({}), ev({ id: 2, day: 5 })], 10), 'silent');
  assert.equal(segmentOf([inv({})], [ev({ kind: 'promise', detail: '{"day":12}' })], 10), 'promised-before');
  assert.equal(segmentOf([inv({})], [ev({ kind: 'promise', detail: '{"day":8}' })], 10), 'promise-broken');
});

test('bandit tries untried playbooks first, then exploits the winner', () => {
  setBanditSeed(99);
  assert.equal(choosePlaybook([]), 'friendly-plan-early');
  const stats = [
    { playbook: 'friendly-plan-early' as const, contacts: 10, rewards: 1 },
    { playbook: 'formal-firm' as const, contacts: 10, rewards: 8 },
    { playbook: 'friendly-remind-only' as const, contacts: 10, rewards: 2 },
  ];
  let formal = 0;
  for (let i = 0; i < 100; i++) if (choosePlaybook(stats) === 'formal-firm') formal++;
  assert.ok(formal >= 70, `expected exploitation >=70%, got ${formal}`);
});

test('attribution uses the segment/playbook frozen at contact time', () => {
  const trials: ContactTrial[] = [
    { contactEventId: 10, invoiceId: 'inv-1', worldDay: 1, segment: 'new', playbook: 'friendly-plan-early', rewardedPaymentEventId: null },
    { contactEventId: 20, invoiceId: 'inv-1', worldDay: 8, segment: 'slow-payer', playbook: 'formal-firm', rewardedPaymentEventId: 99 },
  ];
  const secondInstalment = ev({ id: 30, day: 12, kind: 'payment', detail: 'plan instalment' });
  const target = attributionTarget(trials, secondInstalment);
  assert.equal(target?.contactEventId, 20);
  assert.equal(target?.segment, 'slow-payer');
  // The engine sees rewardedPaymentEventId and therefore does not credit
  // this payment again—or fall through to the older contact. That keeps
  // every playbook reward count <= its contact count.
  assert.notEqual(target?.rewardedPaymentEventId, null);
});

test('rewardTarget credits the last contact inside the window', () => {
  const events = [
    ev({ id: 1, day: 1, detail: '{"playbook":"friendly-remind-only"}' }),
    ev({ id: 2, day: 8, detail: '{"playbook":"formal-firm"}' }),
  ];
  const payment = ev({ id: 3, day: 12, kind: 'payment', detail: 'paid' });
  assert.equal(rewardTarget(events, payment)?.playbook, 'formal-firm');
  const late = ev({ id: 4, day: 30, kind: 'payment', detail: 'paid' });
  assert.equal(rewardTarget(events, late), null);
});
