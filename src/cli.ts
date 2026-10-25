#!/usr/bin/env node
import { defaultModel } from './models.js';
import { sweep } from './sweep.js';
import { evaluate } from './evaluate.js';
import { serve } from './server.js';
import { pool } from './db.js';

const USAGE = `remit - B2B invoice collection agent

Usage:
  remit sweep [--draft-model provider:model] [--budget 1] [--force] [--ledger URL]
  remit eval  [--seed 20261023] [--draft-model provider:model] [--budget 5] [--ledger URL]
  remit serve [--port 3000] [--ledger URL]

One sweep = one business day in the stand-in ledger world (see README).
Use baseline:rules for deterministic, keyless drafting.`;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}
function num(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} needs a number`);
  return n;
}
function optionalNum(v: string | undefined, name: string): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} needs a number`);
  return n;
}
function nonEmpty(v: string | undefined): string | undefined {
  const s = v?.trim();
  return s ? s : undefined;
}

const [cmd, ...args] = process.argv.slice(2);
const ledgerUrl = flag(args, 'ledger') ?? process.env.LEDGER_URL ?? 'http://localhost:8090';
const draftModelOverride = nonEmpty(flag(args, 'draft-model')) ?? nonEmpty(process.env.DRAFT_MODEL);
const draftModel = draftModelOverride ?? defaultModel('draft');

try {
  if (cmd === 'sweep') {
    const s = await sweep({
      ledgerUrl,
      draftModelOverride,
      budgetOverrideUsd: optionalNum(flag(args, 'budget') ?? process.env.REMIT_BUDGET_USD, 'budget'),
      forceSchedule: args.includes('--force'),
      source: 'cli',
    });
    if (s.busy) console.log('sweep skipped: another sweep is already running');
    else if (s.skipped) console.log(`sweep skipped: ${s.skipped} (world day ${s.worldDayAfter ?? s.day}; model ${s.draftModel}; budget $${s.budgetUsd})`);
    else console.log(`sweep done: day=${s.day} considered=${s.considered} contacted=${s.contacted} plans=${s.plansOffered} escalated=${s.escalated} queued=${s.queued} waited=${s.waited} cost=$${s.costUsd.toFixed(4)} model=${s.draftModel}`);
    await pool.end();
  } else if (cmd === 'eval') {
    await evaluate({
      ledgerUrl, draftModel,
      seed: Math.floor(num(flag(args, 'seed'), 20261023, 'seed')),
      budgetUsd: num(flag(args, 'budget'), 5, 'budget'),
    });
    await pool.end();
  } else if (cmd === 'serve') {
    await serve(Math.floor(num(flag(args, 'port') ?? process.env.PORT, 3000, 'port')), ledgerUrl);
  } else {
    console.log(USAGE);
    process.exitCode = cmd === undefined ? 0 : 2;
  }
} catch (err) {
  console.error(`remit: ${(err as Error).message}`);
  try { await pool.end(); } catch { /* pool may already be closed */ }
  process.exit(1);
}
