import type { Invoice } from './ledger.js';

// Episode scoring for the simulator exam. Money and time, nothing else:
// how much was collected by day 30/60, and the average days each dollar
// of invoice sat unpaid (a DSO-style number, capped at horizon).

export type EpisodeScore = {
  invoicedCents: number;
  collectedBy30: number;
  collectedBy60: number;
  pctBy30: number;
  pctBy60: number;
  dsoSim: number;
  paidCount: number;
  totalCount: number;
  contacts: number;
  costUsd: number;
  costPer1000Collected: number;
};

export function scoreEpisode(invoices: Invoice[], horizonDays = 60, contacts = 0, costUsd = 0): EpisodeScore {
  let invoiced = 0, by30 = 0, by60 = 0, paidCount = 0, weightedDays = 0;
  for (const inv of invoices) {
    invoiced += inv.amountCents;
    // paidCents is final; attribute full collection timing by paidDay
    // when fully paid, otherwise count partials at the horizon.
    if (inv.status === 'paid' && inv.paidDay !== null) {
      paidCount++;
      if (inv.paidDay <= 30) by30 += inv.amountCents;
      if (inv.paidDay <= horizonDays) by60 += inv.amountCents;
      weightedDays += inv.amountCents * Math.min(Math.max(inv.paidDay - inv.issuedDay, 0), horizonDays);
    } else {
      by60 += inv.paidCents; // partial plan payments collected in-window
      weightedDays += inv.amountCents * horizonDays;
    }
  }
  return {
    invoicedCents: invoiced,
    collectedBy30: by30,
    collectedBy60: by60,
    pctBy30: invoiced ? by30 / invoiced : 0,
    pctBy60: invoiced ? by60 / invoiced : 0,
    dsoSim: invoiced ? weightedDays / invoiced : 0,
    paidCount,
    totalCount: invoices.length,
    contacts,
    costUsd,
    costPer1000Collected: by60 ? (costUsd / (by60 / 100)) * 1000 : 0,
  };
}

export function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function table(rows: Array<{ name: string; score: EpisodeScore }>): string {
  const head = ['Strategy', 'Collected by day 30', 'By day 60', 'DSO(sim)', 'Contacts', 'Model cost'];
  const body = rows.map((r) => [
    r.name,
    `${money(r.score.collectedBy30)} (${(r.score.pctBy30 * 100).toFixed(0)}%)`,
    `${money(r.score.collectedBy60)} (${(r.score.pctBy60 * 100).toFixed(0)}%)`,
    r.score.dsoSim.toFixed(1),
    String(r.score.contacts),
    `$${r.score.costUsd.toFixed(4)}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(head), ...body.map(line)].join('\n');
}
