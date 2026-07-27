/**
 * retention.scrub — api_call_log / raw_payload / aged anonymise.
 * Run: npm run sync:retention
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';
import { runRetentionScrub } from '../api/src/jobs/retention.js';
import {
  finishIngestionRun,
  startIngestionRun,
  touchSyncCursor,
} from '../api/src/lib/ingestion-run.js';

const JOB = 'retention.scrub';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env);
  const runId = await startIngestionRun(db, JOB);
  console.log(`=== ${JOB} ===`);
  try {
    const result = await runRetentionScrub(db);
    console.log(result);
    await touchSyncCursor(db, JOB);
    await finishIngestionRun(db, runId, {
      status: 'success',
      recordsSeen:
        result.apiCallLogDeleted +
        result.rawPayloadsScrubbed +
        result.notificationLogDeleted +
        result.trackingEventsDeleted +
        result.ingestionRunsDeleted,
      recordsUpserted: result.ordersAnonymised,
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
