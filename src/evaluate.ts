import { mkdirSync, writeFileSync } from 'node:fs';
import { asset } from './assets.js';
import * as db from './db.js';
import { runDay } from './engine.js';
import { Ledger } from './ledger.js';
import { scoreEpisode, table, money } from './score.js';
import { setBanditSeed } from './strategy.js';

// The exam: three 60-day episodes against the same seeded debtor world.
//   none     — send invoices, never chase (the do-nothing cost)
//   template — fixed day 1/7/14/21... dunning, one tone, no plans
//              until late (the industry-default software behaviour)
//   remit    — segmented playbooks + bandit learning + policy rails
// The world resets per episode (simulator harness on the stand-in
// ledger; run it against an in-memory ledger so live data is untouched).

const EPISODE_DAYS = 60;

async function episode(ledger: Ledger, o: { name: string; strategy: 'remit' | 'template' | 'none'; draftModel: string; seed: number; budgetUsd: number }) {
  await ledger.resetWorld(o.seed);
  setBanditSeed(o.seed);
  const scope = `eval-${o.name}-${o.seed}`;
  // Disposable eval scopes must start empty; reusing bandit memory,
  // queues, suppressions or an event cursor would contaminate the run.
  await db.resetScope(scope);
  let contacts = 0;
  let cost = 0;
  let collectedBy30: number | null = null;
  for (let day = 0; day < EPISODE_DAYS; day++) {
    if (o.strategy !== 'none') {
      const s = await runDay({
        ledger, draftModel: o.draftModel, scope, strategy: o.strategy,
        budgetUsd: o.budgetUsd, spentUsd: () => cost,
      });
      contacts += s.contacted;
      cost += s.costUsd;
    }
    await ledger.advanceDay(1);
    if (day === 29) {
      // At this instant the world is on day 30, so paidCents includes
      // full and partial/instalment collections actually received by then.
      collectedBy30 = (await ledger.allInvoices()).reduce((sum, invoice) => sum + invoice.paidCents, 0);
    }
  }
  const finalInvoices = await ledger.allInvoices();
  const score = scoreEpisode(finalInvoices, EPISODE_DAYS, contacts, cost);
  if (collectedBy30 !== null) {
    score.collectedBy30 = collectedBy30;
    score.pctBy30 = score.invoicedCents === 0 ? 0 : collectedBy30 / score.invoicedCents;
  }
  return { name: o.name, score };
}

export async function evaluate(o: { ledgerUrl: string; draftModel: string; seed: number; budgetUsd: number }): Promise<void> {
  await db.migrate();
  const ledger = new Ledger(o.ledgerUrl, process.env.LEDGER_TOKEN);
  const runId = await db.createRun('eval', o.draftModel, 'eval');
  db.setRun(runId);
  const t0 = Date.now();
  try {
    const results = [];
    for (const spec of [
      { name: 'none', strategy: 'none' as const },
      { name: 'template', strategy: 'template' as const },
      { name: 'remit', strategy: 'remit' as const },
    ]) {
      results.push(await episode(ledger, { ...spec, draftModel: o.draftModel, seed: o.seed, budgetUsd: o.budgetUsd }));
    }
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const remit = results.find((r) => r.name === 'remit')!;
    const template = results.find((r) => r.name === 'template')!;
    const extra = remit.score.collectedBy60 - template.score.collectedBy60;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const playbooks = await db.allPlaybookStats(`eval-remit-${o.seed}`);
    const report = {
      at: new Date().toISOString(), draftModel: o.draftModel, seed: o.seed, seconds: Number(seconds),
      scores: Object.fromEntries(results.map((r) => [r.name, r.score])),
      extraCollectedVsTemplateCents: extra,
      playbookStats: playbooks,
      note: 'Seeded simulator debtors with disclosed behaviour rules; the agent never sees persona labels. Proves strategy/policy wiring and relative uplift, not real-world collection rates.',
    };
    mkdirSync(asset('results'), { recursive: true });
    writeFileSync(asset(`results/eval-${stamp}.json`), JSON.stringify(report, null, 2) + '\n');
    const md = [
      `# Remit evaluation ${report.at}`,
      '',
      `Draft model: ${o.draftModel} · seed ${o.seed} · three ${EPISODE_DAYS}-day episodes in ${seconds}s · invoiced ${money(remit.score.invoicedCents)}`,
      '',
      '```', table(results), '```',
      '',
      `Remit collected ${money(extra)} more than fixed-template dunning by day 60 on the same seeded world.`,
      '',
      '## What the bandit learned (contacts → payments within 7 days)',
      ...(playbooks.length ? playbooks.map((p) => `- ${p.segment} / ${p.playbook}: ${p.rewards}/${p.contacts}`) : ['- no playbook data recorded']),
      '',
      report.note,
    ].join('\n');
    writeFileSync(asset(`results/eval-${stamp}.md`), md + '\n');
    console.log(table(results));
    console.log(`\n3 episodes x ${EPISODE_DAYS} days in ${seconds}s. Remit vs template by day 60: ${money(extra)}. Wrote results/eval-${stamp}.json and .md`);
    await db.finishRun(runId, { extraCollectedVsTemplateCents: extra, remitPct60: remit.score.pctBy60, templatePct60: template.score.pctBy60 });
  } finally {
    db.setRun(null);
  }
}
