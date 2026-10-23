import { readFileSync } from 'node:fs';
import { asset } from './assets.js';
import pg from 'pg';
import type { ContactTrial, Playbook, PlaybookStat, Segment } from './strategy.js';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://remit:remit@localhost:5432/remit',
});

export async function migrate(): Promise<void> {
  await pool.query(readFileSync(asset('db/migrations/001_init.sql'), 'utf8'));
}

let currentRun: number | null = null;
export function setRun(id: number | null): void { currentRun = id; }

export async function createRun(kind: string, draftModel: string, scope: string): Promise<number> {
  const r = await pool.query('insert into remit.runs (kind, draft_model, scope) values ($1,$2,$3) returning id', [kind, draftModel, scope]);
  return Number(r.rows[0].id);
}
export async function finishRun(id: number, stats: Record<string, unknown>): Promise<void> {
  await pool.query('update remit.runs set finished_at = now(), stats = $2 where id = $1', [id, JSON.stringify(stats)]);
}

export async function recordCall(c: {
  stage: string; model: string; invoiceIds: string[];
  inputTokens?: number; outputTokens?: number; costUsd?: number; ms?: number; error?: string;
}): Promise<void> {
  await pool.query(
    `insert into remit.calls (run_id, stage, model, invoice_ids, input_tokens, output_tokens, cost_usd, ms, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [currentRun, c.stage, c.model, c.invoiceIds, c.inputTokens ?? 0, c.outputTokens ?? 0, c.costUsd ?? 0, Math.round(c.ms ?? 0), c.error ?? null],
  );
}
export async function runCostUsd(runId: number): Promise<number> {
  const r = await pool.query('select coalesce(sum(cost_usd),0)::float as total from remit.calls where run_id = $1', [runId]);
  return Number(r.rows[0].total);
}

export async function recordDecision(d: {
  scope: string; invoiceId: string; worldDay: number; segment: string; playbook: string; action: string; outcome: string; why: string;
}): Promise<void> {
  await pool.query(
    `insert into remit.decisions (run_id, scope, invoice_id, world_day, segment, playbook, action, outcome, why)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [currentRun, d.scope, d.invoiceId, d.worldDay, d.segment, d.playbook, d.action, d.outcome, d.why],
  );
}

export async function enqueue(scope: string, invoiceId: string, kind: string, why: string, detail: Record<string, unknown> = {}): Promise<void> {
  const exists = await pool.query(
    'select 1 from remit.queue where scope = $1 and invoice_id = $2 and kind = $3 and resolved_at is null', [scope, invoiceId, kind]);
  if (exists.rowCount) return;
  await pool.query('insert into remit.queue (scope, invoice_id, kind, why, detail) values ($1,$2,$3,$4,$5)',
    [scope, invoiceId, kind, why, JSON.stringify(detail)]);
}
export async function openQueue(scope = 'live'): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query(
    'select id, invoice_id, kind, why, detail, created_at from remit.queue where scope = $1 and resolved_at is null order by created_at limit 100', [scope]);
  return r.rows;
}
export async function resolveQueue(id: number, resolution: string): Promise<void> {
  await pool.query('update remit.queue set resolved_at = now(), resolution = $2 where id = $1', [id, resolution]);
}
export async function queueItem(id: number): Promise<Record<string, unknown> | null> {
  const r = await pool.query('select id, invoice_id, kind, why, detail from remit.queue where id = $1', [id]);
  return r.rows[0] ?? null;
}

export async function getState(key: string): Promise<string | null> {
  const r = await pool.query('select value from remit.state where key = $1', [key]);
  return r.rows.length ? String(r.rows[0].value) : null;
}
export async function setState(key: string, value: string): Promise<void> {
  await pool.query('insert into remit.state (key, value) values ($1,$2) on conflict (key) do update set value = excluded.value', [key, value]);
}

export async function playbookStats(scope: string, segment: string): Promise<PlaybookStat[]> {
  const r = await pool.query('select playbook, contacts, rewards from remit.playbook_stats where scope = $1 and segment = $2', [scope, segment]);
  return r.rows.map((x) => ({ playbook: x.playbook as Playbook, contacts: Number(x.contacts), rewards: Number(x.rewards) }));
}
export async function bumpPlaybook(scope: string, segment: string, playbook: Playbook, contactsDelta: number, rewardsDelta: number): Promise<void> {
  await pool.query(
    `insert into remit.playbook_stats (scope, segment, playbook, contacts, rewards) values ($1,$2,$3,$4,$5)
     on conflict (scope, segment, playbook) do update set contacts = remit.playbook_stats.contacts + $4, rewards = remit.playbook_stats.rewards + $5`,
    [scope, segment, playbook, contactsDelta, rewardsDelta]);
}
export async function allPlaybookStats(scope: string): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query('select segment, playbook, contacts, rewards from remit.playbook_stats where scope = $1 order by segment, playbook', [scope]);
  return r.rows;
}

export async function recordContactTrial(
  scope: string,
  trial: Omit<ContactTrial, 'rewardedPaymentEventId'>,
): Promise<void> {
  await pool.query(
    `insert into remit.contact_trials
       (scope, contact_event_id, invoice_id, world_day, segment, playbook)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (scope, contact_event_id) do nothing`,
    [scope, trial.contactEventId, trial.invoiceId, trial.worldDay, trial.segment, trial.playbook]);
}

export async function contactTrials(scope: string, invoiceId: string): Promise<ContactTrial[]> {
  const r = await pool.query(
    `select contact_event_id, invoice_id, world_day, segment, playbook, rewarded_payment_event_id
       from remit.contact_trials
      where scope = $1 and invoice_id = $2
      order by world_day, contact_event_id`,
    [scope, invoiceId]);
  return r.rows.map((x) => ({
    contactEventId: Number(x.contact_event_id),
    invoiceId: String(x.invoice_id),
    worldDay: Number(x.world_day),
    segment: x.segment as Segment,
    playbook: x.playbook as Playbook,
    rewardedPaymentEventId: x.rewarded_payment_event_id === null ? null : Number(x.rewarded_payment_event_id),
  }));
}

export async function markContactTrialRewarded(
  scope: string,
  contactEventId: number,
  paymentEventId: number,
): Promise<boolean> {
  const r = await pool.query(
    `update remit.contact_trials
        set rewarded_payment_event_id = $3, rewarded_at = now()
      where scope = $1
        and contact_event_id = $2
        and rewarded_payment_event_id is null`,
    [scope, contactEventId, paymentEventId]);
  return (r.rowCount ?? 0) === 1;
}

// Evaluation scopes are disposable. Clearing every scoped table makes a
// repeated seeded episode reproducible instead of mixing today's run
// into scores or bandit memory from an earlier run. Never call with
// the production/live scope.
export async function resetScope(scope: string): Promise<void> {
  if (scope === 'live') throw new Error('resetScope refuses to clear the live scope');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from remit.contact_trials where scope = $1', [scope]);
    await client.query('delete from remit.playbook_stats where scope = $1', [scope]);
    await client.query('delete from remit.decisions where scope = $1', [scope]);
    await client.query('delete from remit.queue where scope = $1', [scope]);
    await client.query('delete from remit.suppressions where scope = $1', [scope]);
    await client.query('delete from remit.state where key = $1', [`${scope}:last_event_id`]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function suppress(scope: string, invoiceId: string, reason: string): Promise<void> {
  await pool.query('insert into remit.suppressions (scope, invoice_id, reason) values ($1,$2,$3) on conflict do nothing', [scope, invoiceId, reason]);
}
export async function suppressed(scope: string): Promise<Set<string>> {
  const r = await pool.query('select invoice_id from remit.suppressions where scope = $1', [scope]);
  return new Set(r.rows.map((x) => x.invoice_id as string));
}
export async function unsuppress(scope: string, invoiceId: string): Promise<void> {
  await pool.query('delete from remit.suppressions where scope = $1 and invoice_id = $2', [scope, invoiceId]);
}

export async function recentRuns(limit = 20): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query('select id, kind, draft_model, scope, started_at, finished_at, stats from remit.runs order by id desc limit $1', [limit]);
  return r.rows;
}
export async function recentDecisions(limit = 60): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query(
    'select id, invoice_id, world_day, segment, playbook, action, outcome, why, at from remit.decisions order by id desc limit $1', [limit]);
  return r.rows;
}
