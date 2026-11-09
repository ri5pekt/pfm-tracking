/**
 * Re-poll TrackingMore for KLB / aggregator shipments with missing or stale timelines.
 * Run: npm run sync:trackingmore
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';
import { TrackingMoreClient } from '../api/src/integrations/trackingmore/client.js';
import { pollOpenTrackingMoreShipments } from '../api/src/integrations/trackingmore/poll.js';
import {
  appendRunItems,
  finishIngestionRun,
  startIngestionRun,
  touchSyncCursor,
} from '../api/src/lib/ingestion-run.js';

const JOB = 'trackingmore.poll';
const POLL_LIMIT = 80;

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.TRACKINGMORE_API_KEY) throw new Error('TRACKINGMORE_API_KEY required');

  const db = createPool(env);
  const runId = await startIngestionRun(db, JOB);
  const tm = new TrackingMoreClient({
    apiKey: env.TRACKINGMORE_API_KEY,
    apiBase: env.TRACKINGMORE_API_BASE,
    db,
  });
  const started = Date.now();

  console.log(`=== ${JOB} ===`);
  try {
    const openBefore = await db.query<{ internal_status: string; n: string }>(
      `SELECT internal_status, count(*)::text AS n
       FROM shipments
       WHERE aggregator = 'trackingmore'
         AND tracking_number IS NOT NULL
         AND internal_status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER')
       GROUP BY 1
       ORDER BY count(*) DESC`,
    );
    const openByStatus = Object.fromEntries(
      openBefore.rows.map((r) => [r.internal_status, Number(r.n)]),
    );
    const openTotal = Object.values(openByStatus).reduce((a, b) => a + b, 0);

    const result = await pollOpenTrackingMoreShipments(db, tm, {
      limit: POLL_LIMIT,
      // Prod: don't re-poll terminals every cycle (burns quota on seed backlog)
      includeTerminal: false,
    });

    await appendRunItems(
      db,
      runId,
      result.items.slice(0, 100).map((i) => ({
        orderNumber: i.orderNumber,
        orderId: i.orderId,
        shipmentId: i.shipmentId,
        trackingNumber: i.trackingNumber,
        action: i.action,
        detail: i.detail ?? null,
      })),
    );

    await touchSyncCursor(db, JOB);
    await finishIngestionRun(db, runId, {
      status: result.errors > 0 || result.stoppedForRateLimit ? 'partial' : 'success',
      recordsSeen: result.considered,
      recordsUpserted: result.refreshed,
      eventsAppended: result.eventsInserted,
      errors:
        result.errors > 0 || result.stoppedForRateLimit
          ? {
              errors: result.errors,
              stoppedForRateLimit: result.stoppedForRateLimit,
              registered: result.registered,
            }
          : undefined,
    });

    const hitRatePct =
      result.considered > 0
        ? Math.round(
            (result.items.filter((i) => i.eventsInserted > 0).length / result.considered) * 1000,
          ) / 10
        : 0;

    console.log(
      `[trackingmore.poll] summary ${JSON.stringify({
        pollLimit: POLL_LIMIT,
        openTotal,
        openByStatus,
        durationSec: Math.round((Date.now() - started) / 1000),
        considered: result.considered,
        refreshed: result.refreshed,
        eventsInserted: result.eventsInserted,
        withCheckpoints: result.withCheckpoints,
        stillPending: result.stillPending,
        registered: result.registered,
        shipmentsChanged: result.items.filter((i) => i.eventsInserted > 0).length,
        hitRatePct,
        errors: result.errors,
        stoppedForRateLimit: result.stoppedForRateLimit,
      })}`,
    );
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
