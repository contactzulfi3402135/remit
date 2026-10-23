import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedQueueActions, esc } from '../src/server.js';

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
