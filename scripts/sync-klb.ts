/**
 * KLB shipping-order sync + TrackingMore register (Phase 2).
 * Trailing 30-day window of shipped orders; register TM for new/thin shipments.
 * Run: npm run sync:klb
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';
import { KlbClient } from '../api/src/integrations/klb/client.js';
import {
  flattenKlbCandidates,
  ingestKlbShipment,
  pickKlbOrderNumber,
  enrichKlbShipmentsWithTrackingMoreBatch,
} from '../api/src/integrations/klb/ingest.js';
import { TrackingMoreClient } from '../api/src/integrations/trackingmore/client.js';
import {
  appendRunItems,
  finishIngestionRun,
  startIngestionRun,
  type IngestionRunItemInput,
} from '../api/src/lib/ingestion-run.js';

const JOB = 'klb.sync';
/** Cap TrackingMore create/get calls per run to stay under quota. */
const MAX_TM_ENRICH_PER_RUN = 80;

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(0, days));
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.KLB_LEGACY_API_SECRET) throw new Error('KLB_LEGACY_API_SECRET required');
  if (!env.TRACKINGMORE_API_KEY) throw new Error('TRACKINGMORE_API_KEY required');

  const db = createPool(env);
  const klb = new KlbClient({
    apiBase: env.KLB_API_BASE,
    legacySecureKey: env.KLB_LEGACY_API_SECRET,
    db,
  });
  const tm = new TrackingMoreClient({
    apiKey: env.TRACKINGMORE_API_KEY,
    apiBase: env.TRACKINGMORE_API_BASE,
    db,
  });

  const windowDays = env.KLB_WINDOW_DAYS;
  const endDate = isoDateDaysAgo(0);
  const startDate = isoDateDaysAgo(windowDays);
  const runId = await startIngestionRun(db, JOB, null);

  console.log(`=== ${JOB} window ${startDate} → ${endDate} (KLB_WINDOW_DAYS=${windowDays}) ===`);

  let seen = 0;
  let upserted = 0;
  let created = 0;
  let registered = 0;
  let eventsAppended = 0;
  const errors: string[] = [];
  const items: IngestionRunItemInput[] = [];

  try {
    const raw = await klb.listShippingOrders({ startDate, endDate });
    const candidates = flattenKlbCandidates(raw);
    seen = candidates.length;
    console.log(`[klb] candidates=${candidates.length}`);

    let skippedDup = 0;
    for (const c of candidates) {
      const orderNumber = pickKlbOrderNumber(c.order);
      try {
        const result = await ingestKlbShipment(db, c);
        upserted += 1;
        if (result.created) created += 1;
        items.push({
          orderNumber,
          orderId: result.orderId,
          shipmentId: result.shipmentId,
          trackingNumber: c.tracking,
          externalId: c.shipmentKey,
          action: result.created ? 'created' : 'updated',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('shipments_active_tracking_uidx')) {
          skippedDup += 1;
          items.push({
            orderNumber,
            trackingNumber: c.tracking,
            externalId: c.shipmentKey,
            action: 'skipped',
            detail: 'duplicate_tracking',
          });
          continue;
        }
        errors.push(msg);
        items.push({
          orderNumber,
          trackingNumber: c.tracking,
          externalId: c.shipmentKey,
          action: 'error',
          detail: msg.slice(0, 500),
        });
      }
    }
    console.log(`[klb] upserted=${upserted} created=${created} skippedDup=${skippedDup}`);

    const pending = await db.query<{
      id: string;
      order_id: string;
      tracking_number: string;
      carrier_code: string | null;
      order_number: string | null;
    }>(
      `SELECT s.id, s.order_id, s.tracking_number, s.carrier_code, o.order_number
       FROM shipments s
       JOIN orders o ON o.id = s.order_id
       WHERE s.source = 'klb'
         AND s.aggregator = 'trackingmore'
         AND s.tracking_number IS NOT NULL
         AND (
           s.aggregator_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM tracking_events te WHERE te.shipment_id = s.id)
         )
       ORDER BY s.created_at DESC
       LIMIT $1`,
      [MAX_TM_ENRICH_PER_RUN],
    );

    console.log(`[klb] tm enrich queue=${pending.rows.length} (cap ${MAX_TM_ENRICH_PER_RUN})`);

    const enrich = await enrichKlbShipmentsWithTrackingMoreBatch(db, tm, pending.rows);
    registered += enrich.registered;
    eventsAppended += enrich.eventsInserted;
    if (enrich.stoppedForRateLimit) {
      errors.push('TrackingMore rate limit — enrich stopped early (120s cooldown)');
    }
    for (const item of enrich.items) {
      if (item.error) {
        errors.push(`${item.trackingNumber}: ${item.error}`);
        items.push({
          orderNumber: item.orderNumber,
          orderId: item.orderId,
          shipmentId: item.shipmentId,
          trackingNumber: item.trackingNumber,
          action: 'error',
          detail: item.error.slice(0, 500),
        });
      } else {
        items.push({
          orderNumber: item.orderNumber,
          orderId: item.orderId,
          shipmentId: item.shipmentId,
          trackingNumber: item.trackingNumber,
          action: 'updated',
          detail: item.eventsInserted ? `tm_events+${item.eventsInserted}` : 'tm_registered',
        });
      }
    }

    await appendRunItems(db, runId, items);

    await db.query(
      `INSERT INTO sync_cursors (job_name, cursor_at, last_success_at, updated_at)
       VALUES ($1, now(), now(), now())
       ON CONFLICT (job_name) DO UPDATE SET
         cursor_at = now(),
         last_success_at = CASE WHEN $2::boolean THEN now() ELSE sync_cursors.last_success_at END,
         updated_at = now()`,
      [JOB, errors.length === 0],
    );

    await finishIngestionRun(db, runId, {
      status: errors.length === 0 ? 'success' : 'partial',
      recordsSeen: seen,
      recordsUpserted: upserted,
      eventsAppended,
      errors: errors.length ? errors.slice(0, 30) : undefined,
    });

    console.log({
      seen,
      upserted,
      created,
      registered,
      eventsAppended,
      errors: errors.length,
      items: items.length,
    });
  } catch (err) {
    await appendRunItems(db, runId, items);
    await finishIngestionRun(db, runId, {
      status: 'failed',
      recordsSeen: seen,
      recordsUpserted: upserted,
      eventsAppended,
      errors: [err instanceof Error ? err.message : String(err)],
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
