/**
 * reconcile.daily — data-quality findings for parallel run / ops.
 * Run: npm run sync:reconcile
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';
import { listUnmappedStatuses, runDailyReconcile } from '../api/src/jobs/reconcile.js';
import {
  finishIngestionRun,
  startIngestionRun,
  touchSyncCursor,
} from '../api/src/lib/ingestion-run.js';

const JOB = 'reconcile.daily';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env);
  const runId = await startIngestionRun(db, JOB);
  console.log(`=== ${JOB} ===`);
  try {
    const result = await runDailyReconcile(db);
    console.log(result);
    const unmapped = await listUnmappedStatuses(db, { limit: 20 });
    console.log('top unmapped:', unmapped);
    const findingCount = result.findings.reduce((sum, f) => sum + f.n, 0);
    await touchSyncCursor(db, JOB);
    await finishIngestionRun(db, runId, {
      status: 'success',
      recordsSeen: findingCount,
      recordsUpserted: result.findings.length,
    });
  } catch (err) {
    await finishIngestionRun(db, runId, {
      status: 'failed',
      errors: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
