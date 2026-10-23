import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEpisode } from '../src/score.js';
import type { Invoice } from '../src/ledger.js';

function inv(p: Partial<Invoice>): Invoice {
  return { id: 'i', debtorId: 'd', debtorName: 'T', amountCents: 100000, paidCents: 0, issuedDay: 0, dueDay: 30, status: 'open', paidDay: null, ...p };
}

test('scoreEpisode counts collection windows and DSO(sim)', () => {
  const s = scoreEpisode([
    inv({ id: 'a', status: 'paid', paidDay: 20, paidCents: 100000 }),
    inv({ id: 'b', status: 'paid', paidDay: 50, paidCents: 100000 }),
    inv({ id: 'c', status: 'open', paidCents: 25000 }),
  ], 60, 9, 0.5);
  assert.equal(s.invoicedCents, 300000);
  assert.equal(s.collectedBy30, 100000);
  assert.equal(s.collectedBy60, 225000);
  assert.ok(Math.abs(s.dsoSim - (20 + 50 + 60) / 3) < 0.01);
});
