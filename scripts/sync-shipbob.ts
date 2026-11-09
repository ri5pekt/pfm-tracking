/**
 * ShipBob orders sync + tracking poll (Phase 1 jobs).
 * Run: npm run sync:shipbob
 *
 * Discovery uses LastUpdate* (not insert StartDate) so Processing → LabeledCreated
 * updates are picked up after the order ages out of the create-time window.
 * A second pass re-fetches local orders that still lack a ShipBob tracking shipment
 * (warehouse delays / bulk label runs / weekends).
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
/** How far back to re-check DB orders that still have no ShipBob tracking. */
const PENDING_RECHECK_DAYS = 21;
/** Max pending order numbers to re-fetch per cycle (ReferenceIds batches of 25). */
const PENDING_RECHECK_LIMIT = 200;
const REFERENCE_BATCH = 25;

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

async function ingestBatch(
  db: ReturnType<typeof createPool>,
  batch: Awaited<ReturnType<ShipBobClient['listOrders']>>,
  items: IngestionRunItemInput[],
  errors: string[],
  sourceShipmentIds: string[],
  detailPrefix = '',
): Promise<{ seen: number; upserted: number }> {
  let seen = 0;
  let upserted = 0;
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
          externalId: String(order.id),
          action: 'skipped',
          detail: detailPrefix
            ? `${detailPrefix}no_tracking_shipments`
            : 'no_tracking_shipments',
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
            detail: detailPrefix || null,
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
  return { seen, upserted };
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
  const started = Date.now();
  console.log(
    `[shipbob.orders] lastUpdate ${start.toISOString()} → ${end.toISOString()} (cursor=${prev?.toISOString() ?? 'none'}, lookbackHours=${lookbackHours})`,
  );

  let seen = 0;
  let upserted = 0;
  let pages = 0;
  const sourceShipmentIds: string[] = [];
  const errors: string[] = [];
  const items: IngestionRunItemInput[] = [];

  try {
    let page = 1;
    while (page <= 20) {
      const batch = await client.listOrders({
        page,
        limit: 250,
        lastUpdateStartDate: start.toISOString(),
        lastUpdateEndDate: end.toISOString(),
      });
      if (!batch.length) break;
      pages += 1;
      const r = await ingestBatch(db, batch, items, errors, sourceShipmentIds);
      seen += r.seen;
      upserted += r.upserted;
      if (batch.length < 250) break;
      page += 1;
    }

    await appendRunItems(db, runId, items.slice(0, 100));

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

    console.log(
      `[shipbob.orders] summary ${JSON.stringify({
        lookbackHours,
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
        durationSec: Math.round((Date.now() - started) / 1000),
        pages,
        seen,
        upserted,
        sourceShipments: sourceShipmentIds.length,
        errors: errors.length,
      })}`,
    );
  } catch (err) {
    await appendRunItems(db, runId, items.slice(0, 100));
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

/**
 * Re-fetch ShipBob for local orders that never got a tracking shipment.
 * Needed because warehouse labeling can lag hours/days after order create,
 * and LastUpdate windows alone can still miss edge cases after outages.
 */
async function recheckPendingOrders(
  db: ReturnType<typeof createPool>,
  client: ShipBobClient,
): Promise<{ checked: number; seen: number; upserted: number; sourceShipmentIds: string[] }> {
  const { rows } = await db.query<{ order_number: string }>(
    `SELECT o.order_number
     FROM orders o
     WHERE o.ordered_at >= now() - ($1::int * interval '1 day')
       AND o.current_status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER')
       AND NOT EXISTS (
         SELECT 1 FROM shipments s
         WHERE s.order_id = o.id
           AND s.source = 'shipbob'
           AND s.tracking_number IS NOT NULL
       )
       AND EXISTS (
         SELECT 1
         FROM ingestion_run_items i
         JOIN ingestion_runs r ON r.id = i.run_id
         WHERE i.order_id = o.id
           AND r.job_name = $2
       )
     ORDER BY o.ordered_at ASC
     LIMIT $3`,
    [PENDING_RECHECK_DAYS, JOB_ORDERS, PENDING_RECHECK_LIMIT],
  );

  const refs = rows.map((r) => r.order_number);
  console.log(
    `[shipbob.pending] recheck ${refs.length} orders without ShipBob tracking (≤${PENDING_RECHECK_DAYS}d)`,
  );

  const sourceShipmentIds: string[] = [];
  if (refs.length === 0) {
    return { checked: 0, seen: 0, upserted: 0, sourceShipmentIds };
  }

  const runId = await startIngestionRun(db, 'shipbob.orders.pending_recheck', null);
  const started = Date.now();
  const items: IngestionRunItemInput[] = [];
  const errors: string[] = [];
  let seen = 0;
  let upserted = 0;

  try {
    for (const chunk of chunkStrings(refs, REFERENCE_BATCH)) {
      const batch = await client.listOrders({
        page: 1,
        limit: 250,
        referenceIds: chunk,
      });
      const r = await ingestBatch(db, batch, items, errors, sourceShipmentIds, 'pending_recheck:');
      seen += r.seen;
      upserted += r.upserted;
    }

    await appendRunItems(db, runId, items.slice(0, 100));
    await finishIngestionRun(db, runId, {
      status: errors.length ? 'partial' : 'success',
      recordsSeen: seen,
      recordsUpserted: upserted,
      eventsAppended: 0,
      errors: errors.length ? errors.slice(0, 20) : undefined,
    });
    console.log(
      `[shipbob.pending] summary ${JSON.stringify({
        checked: refs.length,
        durationSec: Math.round((Date.now() - started) / 1000),
        seen,
        upserted,
        sourceShipments: sourceShipmentIds.length,
        errors: errors.length,
      })}`,
    );
  } catch (err) {
    await appendRunItems(db, runId, items.slice(0, 100));
    await finishIngestionRun(db, runId, {
      status: 'failed',
      recordsSeen: seen,
      recordsUpserted: upserted,
      eventsAppended: 0,
      errors: [err instanceof Error ? err.message : String(err)],
    });
    throw err;
  }

  return { checked: refs.length, seen, upserted, sourceShipmentIds };
}

function chunkStrings(items: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Quiet labels rarely move; poll them ~every 90m (updated_at bumps on each poll). */
const LABEL_CREATED_MIN_AGE_MINUTES = 90;

async function pollTracking(
  db: ReturnType<typeof createPool>,
  client: ShipBobClient,
  extraIds: string[] = [],
): Promise<{ tracked: number; eventsInserted: number; requested: number }> {
  const runId = await startIngestionRun(db, JOB_TRACKING, null);
  try {
    // Active statuses every cycle; LABEL_CREATED on a slow lane (~90m).
    // Fresh order sync IDs (extraIds) are always included.
    const openByStatus = await db.query<{ internal_status: string; n: string }>(
      `SELECT internal_status, count(*)::text AS n
       FROM shipments
       WHERE source = 'shipbob'
         AND tracking_number IS NOT NULL
         AND internal_status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER')
       GROUP BY 1
       ORDER BY count(*) DESC`,
    );
    const openMix = Object.fromEntries(
      openByStatus.rows.map((r) => [r.internal_status, Number(r.n)]),
    );
    const openTotal = Object.values(openMix).reduce((a, b) => a + b, 0);

    const open = await db.query<{ source_shipment_id: string }>(
      `SELECT source_shipment_id FROM shipments
       WHERE source = 'shipbob'
         AND tracking_number IS NOT NULL
         AND internal_status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER')
         AND (
           internal_status <> 'LABEL_CREATED'
           OR updated_at < now() - ($1::int * interval '1 minute')
         )
       ORDER BY
         CASE internal_status
           WHEN 'OUT_FOR_DELIVERY' THEN 0
           WHEN 'EXCEPTION' THEN 1
           WHEN 'IN_TRANSIT' THEN 2
           WHEN 'LABEL_CREATED' THEN 3
           ELSE 4
         END,
         updated_at ASC NULLS FIRST`,
      [LABEL_CREATED_MIN_AGE_MINUTES],
    );
    const ids = [...new Set([...extraIds, ...open.rows.map((r) => r.source_shipment_id)])];
    const labelSkipped = Math.max(0, openTotal - open.rows.length);
    console.log(
      `[shipbob.tracking] sweep ${ids.length} ids (open=${openTotal} labelSkipped~${labelSkipped} labelMinAgeMin=${LABEL_CREATED_MIN_AGE_MINUTES}) openByStatus=${JSON.stringify(openMix)}`,
    );
    const result = await pollShipBobTrackingForIds(db, client, ids);

    // Cap run-item detail so catch-up sweeps don't flood ingestion_run_items.
    const refreshedForLog = result.refreshed.slice(0, 100);
    await appendRunItems(
      db,
      runId,
      refreshedForLog.map((r) => ({
        orderNumber: r.orderNumber,
        orderId: r.orderId,
        shipmentId: r.shipmentId,
        trackingNumber: r.trackingNumber,
        externalId: r.sourceShipmentId,
        action: 'updated' as const,
        detail: `events+${r.eventsInserted}`,
      })),
    );

    const durationSec = Math.round(result.durationMs / 1000);
    const shipmentsChanged = result.refreshed.length;
    const hitRatePct =
      ids.length > 0 ? Math.round((shipmentsChanged / ids.length) * 1000) / 10 : 0;
    console.log(
      `[shipbob.tracking] summary ${JSON.stringify({
        requested: ids.length,
        openTotal,
        labelSkipped,
        labelMinAgeMin: LABEL_CREATED_MIN_AGE_MINUTES,
        tracked: result.tracked,
        missingFromApi: result.missingFromApi,
        apiErrorsSkipped: result.apiErrorsSkipped,
        batches: result.batches,
        durationSec,
        eventsInserted: result.eventsInserted,
        shipmentsChanged,
        hitRatePct,
        rateLimitRetries: result.rateLimitRetries,
        openByStatus: openMix,
      })}`,
    );

    await finishIngestionRun(db, runId, {
      status: result.apiErrorsSkipped > 0 ? 'partial' : 'success',
      recordsSeen: ids.length,
      recordsUpserted: result.tracked,
      eventsAppended: result.eventsInserted,
      errors:
        result.apiErrorsSkipped > 0
          ? [`skipped ${result.apiErrorsSkipped} shipment ids after ShipBob API errors`]
          : undefined,
    });
    return { ...result, requested: ids.length };
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

  // Each step is isolated: a failure in one (e.g. ShipBob API errors during orders.sync)
  // must never prevent the others from running — most critically pollTracking, which is
  // what drives Klaviyo notifications for shipments we already know about. Before this fix,
  // an uncaught throw in syncOrders killed the whole process and pollTracking silently never
  // ran (incident 2026-08-10/11: shipbob.tracking.poll had zero runs — success or failure —
  // for 32+ hours because orders.sync kept throwing on ShipBob's v1.0 API deprecation).
  const errors: string[] = [];
  let orderSourceShipmentIds: string[] = [];
  let pendingSourceShipmentIds: string[] = [];

  console.log('=== ShipBob orders.sync ===');
  try {
    const orders = await syncOrders(db, client, env.SHIPBOB_ORDERS_LOOKBACK_HOURS);
    console.log(orders);
    orderSourceShipmentIds = orders.sourceShipmentIds;
  } catch (err) {
    errors.push(`orders.sync: ${err instanceof Error ? err.message : String(err)}`);
    console.error('[shipbob.orders] failed, continuing to pending-recheck/tracking:', err);
  }

  console.log('=== ShipBob pending recheck ===');
  try {
    const pending = await recheckPendingOrders(db, client);
    console.log(pending);
    pendingSourceShipmentIds = pending.sourceShipmentIds;
  } catch (err) {
    errors.push(`pending_recheck: ${err instanceof Error ? err.message : String(err)}`);
    console.error('[shipbob.pending] failed, continuing to tracking.poll:', err);
  }

  console.log('=== ShipBob tracking.poll ===');
  try {
    const tracking = await pollTracking(db, client, [
      ...orderSourceShipmentIds,
      ...pendingSourceShipmentIds,
    ]);
    console.log(tracking);
  } catch (err) {
    errors.push(`tracking.poll: ${err instanceof Error ? err.message : String(err)}`);
    console.error('[shipbob.tracking] failed:', err);
  }

  await db.end();

  if (errors.length > 0) {
    console.error(`[shipbob.sync] completed with ${errors.length} step failure(s):`, errors);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
