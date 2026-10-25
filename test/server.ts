import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedQueueActions, esc, initials, nextStepInfo, parseDollarsToCents, plainReason, playbookLabel, queueKindMeta, segmentLabel } from '../src/server.js';
import { defaultSettings } from '../src/settings.js';

test('review desk never offers to resume an opt-out', () => {
  assert.deepEqual(allowedQueueActions('optout'), ['keep_paused']);
});

test('review desk exposes only kind-appropriate human actions', () => {
  assert.deepEqual(allowedQueueActions('dispute'), ['resolve_dispute', 'keep_paused']);
  assert.deepEqual(allowedQueueActions('distress'), ['resume', 'keep_paused']);
  assert.deepEqual(allowedQueueActions('escalation'), ['resume', 'keep_paused']);
  assert.deepEqual(
    allowedQueueActions('policy', { draft: { action: 'offer_plan' } }),
    ['approve_plan', 'resume', 'keep_paused'],
  );
  assert.deepEqual(
    allowedQueueActions('policy', { draft: { action: 'contact' } }),
    ['resume', 'keep_paused'],
  );
});

test('review desk escapes debtor-controlled text', () => {
  assert.equal(esc('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});

test('control room translates internal labels into plain operator language', () => {
  assert.equal(segmentLabel('usually-pays'), 'Usually pays');
  assert.equal(segmentLabel('promise-broken'), 'Promise missed');
  assert.equal(playbookLabel('friendly-plan-early'), 'Friendly + payment plan');
  assert.equal(initials('Blue Peak Logistics'), 'BP');
  assert.equal(queueKindMeta('optout').label, 'Stop-contact request');
});

test('next-step explainer prioritizes paid, ready, and opt-out states', () => {
  const baseInvoice = {
    id: 'inv-1', debtorId: 'd1', debtorName: 'Test Co', amountCents: 10000, paidCents: 0,
    issuedDay: -30, dueDay: 0, status: 'open', paidDay: null,
  };
  const base = {
    inv: baseInvoice, events: [], segment: 'new', overdue: 2, remaining: 10000,
    contacts: 0, nextEligibleDay: 2, suppressionReason: null, queue: [],
  };
  const data = { worldDay: 2, settings: defaultSettings() } as never;
  assert.equal(nextStepInfo(base as never, data).kind, 'ready');
  assert.equal(nextStepInfo({ ...base, remaining: 0 } as never, data).kind, 'done');
  assert.equal(nextStepInfo({ ...base, suppressionReason: 'debtor asked us to stop' } as never, data).kind, 'locked');
  assert.equal(nextStepInfo({ ...base, events: [{ id: 1, invoiceId: 'inv-1', day: 1, kind: 'promise', detail: '{"day":6}' }] } as never, data).kind, 'wait');
});

test('dashboard explains system money reasons in dollars', () => {
  assert.equal(
    plainReason('gate: Balance 1178636c exceeds the 500000c auto-plan limit; a person must approve.'),
    'Safety check: The remaining balance is $11,786.36, above the $5,000.00 automatic-plan limit; a person must approve.',
  );
});

test('dashboard parses operator dollar amounts into cents', () => {
  assert.equal(parseDollarsToCents('1,250.50'), 125050);
  assert.equal(parseDollarsToCents('$9'), 900);
  assert.throws(() => parseDollarsToCents('0'), /positive/);
  assert.throws(() => parseDollarsToCents('not money'), /positive/);
});
