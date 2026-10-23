#!/usr/bin/env node
import { defaultModel } from './models.js';
import { sweep } from './sweep.js';
import { evaluate } from './evaluate.js';
import { serve } from './server.js';
import { pool } from './db.js';

const USAGE = `remit - B2B invoice collection agent

Usage:
  remit sweep [--draft-model provider:model] [--budget 1] [--ledger URL]
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

const [cmd, ...args] = process.argv.slice(2);
const ledgerUrl = flag(args, 'ledger') ?? process.env.LEDGER_URL ?? 'http://localhost:8090';
const draftModel = flag(args, 'draft-model') ?? process.env.DRAFT_MODEL ?? defaultModel('draft');

try {
  if (cmd === 'sweep') {
    const s = await sweep({ ledgerUrl, draftModel, budgetUsd: num(flag(args, 'budget') ?? process.env.REMIT_BUDGET_USD, 1, 'budget') });
    console.log(`sweep done: day=${s.day} considered=${s.considered} contacted=${s.contacted} plans=${s.plansOffered} escalated=${s.escalated} queued=${s.queued} waited=${s.waited} cost=$${s.costUsd.toFixed(4)}`);
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
