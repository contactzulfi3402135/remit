// Seeds the stand-in ledger world if (and only if) it is empty.
// resetWorld wipes the ledger, so this guard matters: live data is
// never reseeded by a scheduled job.
import { Ledger } from '../src/ledger.js';
import { migrate, pool } from '../src/db.js';

const ledger = new Ledger(process.env.LEDGER_URL ?? 'http://localhost:8090', process.env.LEDGER_TOKEN);
await migrate();
const stats = await ledger.stats();
if (stats.invoicedCents === 0 && stats.openCount === 0 && stats.paidCount === 0) {
  const seed = Number(process.env.WORLD_SEED ?? 20261023);
  await ledger.resetWorld(seed);
  const after = await ledger.stats();
  console.log(`seeded world seed=${seed} invoiced=$${(after.invoicedCents / 100).toFixed(0)} open=${after.openCount}`);
} else {
  console.log(`ledger already has data (open=${stats.openCount} paid=${stats.paidCount}); not reseeding`);
}
await pool.end();
