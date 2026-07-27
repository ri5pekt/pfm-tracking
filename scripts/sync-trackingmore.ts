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

  console.log(`=== ${JOB} ===`);
  try {
    const result = await pollOpenTrackingMoreShipments(db, tm, {
      limit: 200,
      includeTerminal: true, // also refresh thin histories from seed
    });
    console.log(result);

    await appendRunItems(
      db,
      runId,
      result.items.map((i) => ({
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
      status: result.errors > 0 ? 'partial' : 'success',
      recordsSeen: result.considered,
      recordsUpserted: result.refreshed,
      eventsAppended: result.eventsInserted,
      errors: result.errors > 0 ? { errors: result.errors } : undefined,
    });

    const summary = await db.query(`
      SELECT s.internal_status,
             count(*)::int AS n,
             round(avg((SELECT count(*) FROM tracking_events te WHERE te.shipment_id = s.id))::numeric, 1) AS avg_events
      FROM shipments s
      WHERE s.source = 'klb'
      GROUP BY 1
      ORDER BY n DESC
    `);
    console.log('KLB after sync:', summary.rows);
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
