import * as db from './db.js';
import { runDay, type DayStats } from './engine.js';
import { Ledger } from './ledger.js';

// The scheduled worker. In this stand-in deployment each sweep is one
// business day in the ledger world (documented in the README): work the
// day, then advance the world clock so debtor reactions and payments
// land before the next sweep. Against a production ERP the same code
// runs on calendar dates and the advance step does not exist.

export async function sweep(o: { ledgerUrl: string; draftModel: string; budgetUsd: number }): Promise<DayStats & { costUsd: number }> {
  await db.migrate();
  const ledger = new Ledger(o.ledgerUrl, process.env.LEDGER_TOKEN);
  const runId = await db.createRun('sweep', o.draftModel, 'live');
  db.setRun(runId);
  try {
    const stats = await runDay({
      ledger, draftModel: o.draftModel, scope: 'live', strategy: 'remit',
      budgetUsd: o.budgetUsd, spentUsd: () => 0,
    });
    const costUsd = await db.runCostUsd(runId);
    await ledger.advanceDay(1);
    const after = await ledger.stats();
    await db.finishRun(runId, { ...stats, costUsd, collectedCents: after.collectedCents, invoicedCents: after.invoicedCents, openCount: after.openCount });
    return { ...stats, costUsd };
  } finally {
    db.setRun(null);
  }
}
