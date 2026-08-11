/**
 * Cross-check live KLB + ShipBob shipment coverage against our DB.
 * Run: npx tsx scripts/cross-check-sources.ts
 *
 * Reports trackings present in source APIs but missing locally (and vice versa
 * for the same lookback windows). Does not mutate data.
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';
import { KlbClient, klbTrackingNumber } from '../api/src/integrations/klb/client.js';
import {
  flattenKlbCandidates,
  pickKlbOrderNumber,
} from '../api/src/integrations/klb/ingest.js';
import { ShipBobClient } from '../api/src/integrations/shipbob/client.js';

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(0, days));
  return d.toISOString().slice(0, 10);
}

function pct(n: number, d: number): string {
  if (!d) return 'n/a';
  return `${((100 * n) / d).toFixed(1)}%`;
}

async function checkKlb(
  db: ReturnType<typeof createPool>,
  env: ReturnType<typeof loadEnv>,
): Promise<void> {
  if (!env.KLB_LEGACY_API_SECRET) {
    console.log('\n=== KLB === skipped (no KLB_LEGACY_API_SECRET)');
    return;
  }

  const windowDays = env.KLB_WINDOW_DAYS;
  const endDate = isoDateDaysAgo(0);
  const startDate = isoDateDaysAgo(windowDays);
  console.log(`\n=== KLB === window ${startDate} → ${endDate} (KLB_WINDOW_DAYS=${windowDays})`);

  const klb = new KlbClient({
    apiBase: env.KLB_API_BASE,
    legacySecureKey: env.KLB_LEGACY_API_SECRET,
    db,
  });

  const raw = await klb.listShippingOrders({ startDate, endDate });
  const candidates = flattenKlbCandidates(raw);
  const byTracking = new Map<string, { orderNumber: string; shipmentKey: string }>();
  for (const c of candidates) {
    const tn = c.tracking.toUpperCase();
    if (!byTracking.has(tn)) {
      byTracking.set(tn, {
        orderNumber: pickKlbOrderNumber(c.order),
        shipmentKey: c.shipmentKey,
      });
    }
  }

  // Also count raw cancelled / no-tracking for context
  let cancelled = 0;
  let noTracking = 0;
  for (const order of raw) {
    for (const sh of order.shipments ?? []) {
      if (sh.cancelled) {
        cancelled += 1;
        continue;
      }
      if (!klbTrackingNumber(sh)) noTracking += 1;
    }
  }

  const trackings = [...byTracking.keys()];
  const { rows: local } = await db.query<{ tracking_number: string }>(
    `SELECT upper(tracking_number) AS tracking_number
     FROM shipments
     WHERE source = 'klb'
       AND tracking_number IS NOT NULL`,
  );
  const localSet = new Set(local.map((r) => r.tracking_number));

  const missingInApp: Array<{ tracking: string; orderNumber: string; shipmentKey: string }> = [];
  for (const [tn, meta] of byTracking) {
    if (!localSet.has(tn)) {
      missingInApp.push({ tracking: tn, orderNumber: meta.orderNumber, shipmentKey: meta.shipmentKey });
    }
  }

  // Local KLB in window by shipped_at / created_at — compare back to source
  const { rows: localInWindow } = await db.query<{
    tracking_number: string;
    order_number: string;
  }>(
    `SELECT upper(s.tracking_number) AS tracking_number, o.order_number
     FROM shipments s
     JOIN orders o ON o.id = s.order_id
     WHERE s.source = 'klb'
       AND s.tracking_number IS NOT NULL
       AND coalesce(s.shipped_at, s.created_at) >= $1::date
       AND coalesce(s.shipped_at, s.created_at) < ($2::date + interval '1 day')`,
    [startDate, endDate],
  );
  const sourceSet = new Set(byTracking.keys());
  const extraInApp = localInWindow.filter((r) => !sourceSet.has(r.tracking_number));

  // Duplicate trackings that collide with shipbob
  const { rows: collisions } = await db.query<{ tracking_number: string; n: string }>(
    `SELECT upper(tracking_number) AS tracking_number, count(*)::text AS n
     FROM shipments
     WHERE tracking_number IS NOT NULL
       AND upper(tracking_number) = ANY($1::text[])
     GROUP BY 1
     HAVING count(*) > 1
     ORDER BY count(*) DESC
     LIMIT 20`,
    [trackings],
  );

  console.log(
    JSON.stringify(
      {
        apiOrders: raw.length,
        apiCandidates: candidates.length,
        apiUniqueTrackings: byTracking.size,
        cancelledShipments: cancelled,
        noTrackingShipments: noTracking,
        dbKlbTotal: localSet.size,
        dbKlbInWindow: localInWindow.length,
        missingInApp: missingInApp.length,
        missingInAppPct: pct(missingInApp.length, byTracking.size),
        extraInAppVsWindow: extraInApp.length,
        multiRowTrackingsInDb: collisions.length,
      },
      null,
      2,
    ),
  );

  if (missingInApp.length) {
    console.log('sample missing in app (up to 25):');
    for (const m of missingInApp.slice(0, 25)) {
      console.log(`  order=${m.orderNumber} tn=${m.tracking} key=${m.shipmentKey}`);
    }
  }
  if (extraInApp.length) {
    console.log('sample extra in app (not in KLB window, up to 15):');
    for (const m of extraInApp.slice(0, 15)) {
      console.log(`  order=${m.order_number} tn=${m.tracking_number}`);
    }
  }
  if (collisions.length) {
    console.log('sample multi-source tracking collisions (up to 10):');
    for (const c of collisions.slice(0, 10)) {
      console.log(`  tn=${c.tracking_number} rows=${c.n}`);
    }
  }
}

async function checkShipBob(
  db: ReturnType<typeof createPool>,
  env: ReturnType<typeof loadEnv>,
): Promise<void> {
  if (!env.SHIPBOB_API_KEY) {
    console.log('\n=== ShipBob === skipped (no SHIPBOB_API_KEY)');
    return;
  }

  // Fresh-start accumulates via LastUpdate cursor. Default audit uses order
  // *create* time (StartDate) so late tracking pings on ancient orders don't
  // look like gaps. Override with SHIPBOB_CHECK_MODE=last_update if needed.
  const lookbackDays = Number(process.env.SHIPBOB_CHECK_DAYS ?? 21);
  const mode = (process.env.SHIPBOB_CHECK_MODE ?? 'created').toLowerCase();
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  // Optional absolute floor (ISO) — e.g. cutover instant
  const floorIso = process.env.SHIPBOB_CHECK_START?.trim();
  const rangeStart = floorIso ? new Date(floorIso) : start;
  console.log(
    `\n=== ShipBob === HasTracking mode=${mode} ${rangeStart.toISOString()} → ${end.toISOString()} (SHIPBOB_CHECK_DAYS=${lookbackDays})`,
  );

  const client = new ShipBobClient({
    apiKey: env.SHIPBOB_API_KEY,
    channelId: env.SHIPBOB_CHANNEL_ID,
    ordersBase: env.SHIPBOB_API_BASE,
    trackingBase: env.SHIPBOB_TRACKING_API_BASE,
    db,
  });

  type SbShip = {
    orderNumber: string;
    sourceOrderId: string;
    sourceShipmentId: string;
    tracking: string;
  };
  const bySourceId = new Map<string, SbShip>();
  const byTracking = new Map<string, SbShip>();
  let ordersSeen = 0;
  let shipmentsWithTn = 0;
  let shipmentsNoTn = 0;

  let page = 1;
  for (;;) {
    const batch = await client.listOrders({
      page,
      limit: 250,
      hasTracking: true,
      ...(mode === 'last_update'
        ? {
            lastUpdateStartDate: rangeStart.toISOString(),
            lastUpdateEndDate: end.toISOString(),
          }
        : {
            startDate: rangeStart.toISOString(),
            endDate: end.toISOString(),
          }),
    });
    if (!batch.length) break;
    for (const order of batch) {
      ordersSeen += 1;
      const orderNumber = String(order.order_number ?? order.reference_id ?? order.id);
      for (const sh of order.shipments ?? []) {
        if (!sh.id) continue;
        const tracking = sh.tracking?.tracking_number?.trim();
        if (!tracking) {
          shipmentsNoTn += 1;
          continue;
        }
        shipmentsWithTn += 1;
        const row: SbShip = {
          orderNumber,
          sourceOrderId: String(order.id),
          sourceShipmentId: String(sh.id),
          tracking: tracking.toUpperCase(),
        };
        bySourceId.set(row.sourceShipmentId, row);
        byTracking.set(row.tracking, row);
      }
    }
    if (batch.length < 250) break;
    page += 1;
    if (page > 200) {
      console.warn('ShipBob pagination capped at 200 pages');
      break;
    }
  }

  const sourceIds = [...bySourceId.keys()];
  const { rows: localById } = await db.query<{ source_shipment_id: string }>(
    `SELECT source_shipment_id FROM shipments
     WHERE source = 'shipbob' AND source_shipment_id = ANY($1::text[])`,
    [sourceIds],
  );
  const localIdSet = new Set(localById.map((r) => r.source_shipment_id));

  const missingById: SbShip[] = [];
  for (const [id, row] of bySourceId) {
    if (!localIdSet.has(id)) missingById.push(row);
  }

  // Also check tracking-number presence (in case source_shipment_id mismatch)
  const trackings = [...byTracking.keys()];
  const { rows: localByTn } = await db.query<{ tracking_number: string }>(
    `SELECT upper(tracking_number) AS tracking_number FROM shipments
     WHERE tracking_number IS NOT NULL AND upper(tracking_number) = ANY($1::text[])`,
    [trackings],
  );
  const localTnSet = new Set(localByTn.map((r) => r.tracking_number));
  const missingByTn = [...byTracking.values()].filter((r) => !localTnSet.has(r.tracking));

  // Pending local: seen by shipbob sync recently but no shipbob shipment
  const { rows: pending } = await db.query<{ order_number: string; ordered_at: Date | null }>(
    `SELECT o.order_number, o.ordered_at
     FROM orders o
     WHERE o.ordered_at > now() - ($1::text || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM shipments s WHERE s.order_id = o.id AND s.source = 'shipbob'
       )
       AND EXISTS (
         SELECT 1 FROM ingestion_run_items i
         JOIN ingestion_runs r ON r.id = i.run_id
         WHERE i.order_id = o.id AND r.job_name LIKE 'shipbob%'
       )
     ORDER BY o.ordered_at DESC NULLS LAST
     LIMIT 50`,
    [String(lookbackDays)],
  );

  const { rows: totals } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM shipments WHERE source = 'shipbob'`,
  );

  console.log(
    JSON.stringify(
      {
        apiOrdersWithTracking: ordersSeen,
        apiShipmentsWithTn: shipmentsWithTn,
        apiShipmentsNoTn: shipmentsNoTn,
        apiUniqueSourceShipmentIds: bySourceId.size,
        apiUniqueTrackings: byTracking.size,
        dbShipBobTotal: Number(totals[0]?.n ?? 0),
        missingBySourceShipmentId: missingById.length,
        missingBySourceShipmentIdPct: pct(missingById.length, bySourceId.size),
        missingByTrackingNumber: missingByTn.length,
        pendingLocalNoSbShipment: pending.length,
      },
      null,
      2,
    ),
  );

  if (missingById.length) {
    console.log('sample missing in app by source_shipment_id (up to 25):');
    for (const m of missingById.slice(0, 25)) {
      console.log(
        `  order=${m.orderNumber} sbOrder=${m.sourceOrderId} sbShip=${m.sourceShipmentId} tn=${m.tracking}`,
      );
    }
  }
  if (pending.length) {
    console.log('sample local orders still pending ShipBob shipment (up to 20):');
    for (const p of pending.slice(0, 20)) {
      console.log(`  order=${p.order_number} ordered_at=${p.ordered_at?.toISOString() ?? 'null'}`);
    }
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env);
  console.log('=== source ↔ app shipment cross-check ===');
  try {
    const { rows: summary } = await db.query<{
      source: string;
      shipments: string;
      orders: string;
    }>(
      `SELECT source, count(*)::text AS shipments, count(DISTINCT order_id)::text AS orders
       FROM shipments GROUP BY 1 ORDER BY 1`,
    );
    console.log('DB summary:', summary);

    await checkKlb(db, env);
    await checkShipBob(db, env);

    const reconcile = await db.query(`
      SELECT
        (SELECT count(*) FROM shipments WHERE source='shipbob' AND (tracking_number IS NULL OR tracking_number='')) AS sb_no_tn,
        (SELECT count(*) FROM shipments WHERE source='klb' AND (tracking_number IS NULL OR tracking_number='')) AS klb_no_tn,
        (SELECT count(*) FROM shipments s
          WHERE s.internal_status NOT IN ('DELIVERED','CANCELLED','RETURNED_TO_SENDER')
            AND s.tracking_number IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tracking_events te WHERE te.shipment_id=s.id)
            AND s.created_at < now() - interval '2 days') AS open_stale_no_events
    `);
    console.log('\n=== quick DQ ===', reconcile.rows[0]);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
