import * as db from './db.js';
import { runDay, type DayStats } from './engine.js';
import { Ledger } from './ledger.js';
import { loadSettings, scheduleStatus } from './settings.js';

// The scheduled worker. In this stand-in deployment each executed sweep
// is one business day in the ledger world: work the day, then advance
// the world clock so debtor reactions and payments land before the next
// sweep. Dashboard schedule settings can make a scheduled invocation a
// recorded no-op outside the operator's sending window; a dashboard
// "run now" may force only the time window, never the pause switch.
// Against a production ERP the same agent code runs on calendar dates
// and the simulated advance step does not exist.

export type SweepResult = DayStats & {
  costUsd: number;
  draftModel: string;
  budgetUsd: number;
  skipped?: string;
  busy?: boolean;
  worldDayAfter?: number;
};

export type SweepOptions = {
  ledgerUrl: string;
  draftModelOverride?: string;
  budgetOverrideUsd?: number;
  forceSchedule?: boolean;
  source?: string;
};

const zeroStats = (day = 0): DayStats => ({
  day,
  considered: 0,
  contacted: 0,
  plansOffered: 0,
  escalated: 0,
  waited: 0,
  queued: 0,
  rewardsCredited: 0,
  costUsd: 0,
});

export async function sweep(o: SweepOptions): Promise<SweepResult> {
  await db.migrate();
  const settings = await loadSettings('live');
  const draftModel = o.draftModelOverride?.trim() || settings.draftModel;
  const budgetUsd = o.budgetOverrideUsd ?? settings.budgetUsd;
  const ledger = new Ledger(o.ledgerUrl, process.env.LEDGER_TOKEN);

  const releaseLock = await db.acquireSweepLock();
  if (!releaseLock) {
    let day = 0;
    try { day = (await ledger.stats()).worldDay; } catch { /* busy result can stand without it */ }
    return { ...zeroStats(day), costUsd: 0, draftModel, budgetUsd, busy: true, skipped: 'Another sweep is already running' };
  }

  const runId = await db.createRun('sweep', draftModel, 'live');
  db.setRun(runId);
  try {
    const before = await ledger.stats();
    const schedule = scheduleStatus(settings);
    if (!settings.enabled || (!schedule.allowed && !o.forceSchedule)) {
      const skipped = !settings.enabled ? 'Agent is paused in the dashboard' : schedule.reason;
      const stats = zeroStats(before.worldDay);
      await db.finishRun(runId, {
        ...stats,
        costUsd: 0,
        skipped,
        source: o.source ?? 'cli',
        schedule,
        collectedCents: before.collectedCents,
        invoicedCents: before.invoicedCents,
        openCount: before.openCount,
      });
      return { ...stats, costUsd: 0, draftModel, budgetUsd, skipped, worldDayAfter: before.worldDay };
    }

    const stats = await runDay({
      ledger,
      draftModel,
      scope: 'live',
      strategy: 'remit',
      budgetUsd,
      spentUsd: () => 0,
      settings,
    });
    const costUsd = await db.runCostUsd(runId);
    await ledger.advanceDay(1);
    const after = await ledger.stats();
    await db.finishRun(runId, {
      ...stats,
      costUsd,
      source: o.source ?? 'cli',
      schedule,
      budgetUsd,
      collectedCents: after.collectedCents,
      invoicedCents: after.invoicedCents,
      openCount: after.openCount,
    });
    return { ...stats, costUsd, draftModel, budgetUsd, worldDayAfter: after.worldDay };
  } finally {
    db.setRun(null);
    await releaseLock();
  }
}
