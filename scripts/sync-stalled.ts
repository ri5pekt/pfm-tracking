/**
 * Detect stalled shipments and emit shipment.stalled once.
 * Run: npm run sync:stalled
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';
import { detectStalledShipments } from '../api/src/jobs/stalled.js';
import {
  finishIngestionRun,
  startIngestionRun,
  touchSyncCursor,
} from '../api/src/lib/ingestion-run.js';

const JOB = 'stalled.detect';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env);
  const runId = await startIngestionRun(db, JOB);
  console.log(`=== ${JOB} thresholdDays=${env.STALLED_DAYS} ===`);
  try {
    const result = await detectStalledShipments(db, { thresholdDays: env.STALLED_DAYS });
    console.log(result);
    await touchSyncCursor(db, JOB);
    await finishIngestionRun(db, runId, {
      status: 'success',
      recordsSeen: result.considered,
      recordsUpserted: result.newlyStalled,
      eventsAppended: result.eventsEmitted,
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
