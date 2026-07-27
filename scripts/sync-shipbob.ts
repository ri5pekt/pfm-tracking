/**
 * ShipBob orders sync + tracking poll (Phase 1 jobs).
 * Run: npm run sync:shipbob
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';
import { ShipBobClient } from '../api/src/integrations/shipbob/client.js';
import {
  ingestShipBobOrder,
  pollShipBobTrackingForIds,
} from '../api/src/integrations/shipbob/ingest.js';
import {
  appendRunItems,
  finishIngestionRun,
  startIngestionRun,
  touchSyncCursor,
  type IngestionRunItemInput,
} from '../api/src/lib/ingestion-run.js';

const JOB_ORDERS = 'shipbob.orders.sync';
const JOB_TRACKING = 'shipbob.tracking.poll';
const OVERLAP_MS = 15 * 60 * 1000;

async function getCursor(
  db: ReturnType<typeof createPool>,
  jobName: string,
): Promise<Date | null> {
  const { rows } = await db.query<{ cursor_at: Date | null }>(
    `SELECT cursor_at FROM sync_cursors WHERE job_name = $1`,
    [jobName],
  );
  return rows[0]?.cursor_at ?? null;
}

async function syncOrders(
  db: ReturnType<typeof createPool>,
  client: ShipBobClient,
  lookbackHours: number,
): Promise<{ seen: number; upserted: number; sourceShipmentIds: string[] }> {
  const prev = await getCursor(db, JOB_ORDERS);
  const lookbackMs = Math.max(0, lookbackHours) * 60 * 60 * 1000;
  const start = new Date((prev?.getTime() ?? Date.now() - lookbackMs) - OVERLAP_MS);
  const end = new Date();
  const runId = await startIngestionRun(db, JOB_ORDERS, prev);
  console.log(
    `[shipbob.orders] window ${start.toISOString()} → ${end.toISOString()} (cursor=${prev?.toISOString() ?? 'none'}, lookbackHours=${lookbackHours})`,
  );

  let seen = 0;
  let upserted = 0;
  const sourceShipmentIds: string[] = [];
  const errors: string[] = [];
  const items: IngestionRunItemInput[] = [];

  try {
    let page = 1;
    while (page <= 20) {
      const batch = await client.listOrders({
        page,
        limit: 250,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      });
      if (!batch.length) break;
      for (const order of batch) {
        seen += 1;
        const orderNumber = String(order.order_number ?? order.reference_id ?? order.id);
        try {
          const result = await ingestShipBobOrder(db, order);
          upserted += 1;
          sourceShipmentIds.push(...result.sourceShipmentIds);
          if (result.items.length === 0) {
            items.push({
              orderNumber: result.orderNumber,
              orderId: result.orderId,
              action: 'skipped',
              detail: 'no_tracking_shipments',
            });
          } else {
            for (const sh of result.items) {
              items.push({
                orderNumber: result.orderNumber,
                orderId: result.orderId,
                shipmentId: sh.shipmentId,
                trackingNumber: sh.trackingNumber,
                externalId: sh.sourceShipmentId,
                action: sh.created ? 'created' : 'updated',
              });
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(msg);
          items.push({
            orderNumber,
            externalId: String(order.id),
            action: 'error',
            detail: msg.slice(0, 500),
          });
        }
      }
      if (batch.length < 250) break;
      page += 1;
    }

    await appendRunItems(db, runId, items);

    if (errors.length === 0) {
      await touchSyncCursor(db, JOB_ORDERS, end);
      await finishIngestionRun(db, runId, {
        status: 'success',
        recordsSeen: seen,
        recordsUpserted: upserted,
        eventsAppended: 0,
        cursorAfter: end,
      });
    } else {
      await finishIngestionRun(db, runId, {
        status: 'partial',
        recordsSeen: seen,
        recordsUpserted: upserted,
        eventsAppended: 0,
        cursorAfter: end,
        errors: errors.slice(0, 20),
      });
    }
  } catch (err) {
    await appendRunItems(db, runId, items);
    await finishIngestionRun(db, runId, {
      status: 'failed',
      recordsSeen: seen,
      recordsUpserted: upserted,
      eventsAppended: 0,
      errors: [err instanceof Error ? err.message : String(err)],
    });
    throw err;
  }

  return { seen, upserted, sourceShipmentIds };
}

async function pollTracking(
  db: ReturnType<typeof createPool>,
  client: ShipBobClient,
  extraIds: string[] = [],
): Promise<{ tracked: number; eventsInserted: number }> {
  const runId = await startIngestionRun(db, JOB_TRACKING, null);
  try {
    const open = await db.query<{ source_shipment_id: string }>(
      `SELECT source_shipment_id FROM shipments
       WHERE source = 'shipbob'
         AND tracking_number IS NOT NULL
         AND internal_status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER')
       ORDER BY last_event_at NULLS FIRST, updated_at
       LIMIT 500`,
    );
    const ids = [...new Set([...extraIds, ...open.rows.map((r) => r.source_shipment_id)])];
    const result = await pollShipBobTrackingForIds(db, client, ids);

    await appendRunItems(
      db,
      runId,
      result.refreshed.map((r) => ({
        orderNumber: r.orderNumber,
        orderId: r.orderId,
        shipmentId: r.shipmentId,
        trackingNumber: r.trackingNumber,
        externalId: r.sourceShipmentId,
        action: 'updated' as const,
        detail: `events+${r.eventsInserted}`,
      })),
    );

    await finishIngestionRun(db, runId, {
      status: 'success',
      recordsSeen: ids.length,
      recordsUpserted: result.tracked,
      eventsAppended: result.eventsInserted,
    });
    return result;
  } catch (err) {
    await finishIngestionRun(db, runId, {
      status: 'failed',
      recordsSeen: 0,
      recordsUpserted: 0,
      eventsAppended: 0,
      errors: [err instanceof Error ? err.message : String(err)],
    });
    throw err;
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.SHIPBOB_API_KEY) throw new Error('SHIPBOB_API_KEY required');

  const db = createPool(env);
  const client = new ShipBobClient({
    apiKey: env.SHIPBOB_API_KEY,
    channelId: env.SHIPBOB_CHANNEL_ID,
    ordersBase: env.SHIPBOB_API_BASE,
    trackingBase: env.SHIPBOB_TRACKING_API_BASE,
    db,
  });

  console.log('=== ShipBob orders.sync ===');
  const orders = await syncOrders(db, client, env.SHIPBOB_ORDERS_LOOKBACK_HOURS);
  console.log(orders);

  console.log('=== ShipBob tracking.poll ===');
  const tracking = await pollTracking(db, client, orders.sourceShipmentIds);
  console.log(tracking);

  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
