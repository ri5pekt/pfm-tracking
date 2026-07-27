/**
 * Load another batch of ShipBob + KLB sample orders, skipping IDs already in DB.
 * Run: npm run seed:more
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';
import { ShipBobClient } from '../api/src/integrations/shipbob/client.js';
import {
  ingestShipBobOrder,
  pollShipBobTrackingForIds,
} from '../api/src/integrations/shipbob/ingest.js';
import { KlbClient } from '../api/src/integrations/klb/client.js';
import {
  enrichKlbWithTrackingMore,
  flattenKlbCandidates,
  ingestKlbShipment,
  pickKlbOrderNumber,
} from '../api/src/integrations/klb/ingest.js';
import { TrackingMoreClient } from '../api/src/integrations/trackingmore/client.js';
import { pollOpenTrackingMoreShipments } from '../api/src/integrations/trackingmore/poll.js';

const TARGET = 50;
const DAYS_AGO = 14;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(23, 59, 59, 0);
  return d.toISOString();
}

function isoDaysAgoStart(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

async function existingIds(
  db: ReturnType<typeof createPool>,
  source: 'shipbob' | 'klb',
): Promise<Set<string>> {
  const { rows } = await db.query<{ source_shipment_id: string }>(
    `SELECT source_shipment_id FROM shipments WHERE source = $1`,
    [source],
  );
  return new Set(rows.map((r) => r.source_shipment_id));
}

async function seedMoreShipBob(db: ReturnType<typeof createPool>, env: ReturnType<typeof loadEnv>) {
  if (!env.SHIPBOB_API_KEY) throw new Error('SHIPBOB_API_KEY required');
  const known = await existingIds(db, 'shipbob');
  const client = new ShipBobClient({
    apiKey: env.SHIPBOB_API_KEY,
    channelId: env.SHIPBOB_CHANNEL_ID,
    ordersBase: env.SHIPBOB_API_BASE,
    trackingBase: env.SHIPBOB_TRACKING_API_BASE,
    db,
  });

  const endDate = isoDaysAgo(DAYS_AGO);
  const startDate = isoDaysAgo(DAYS_AGO + 45);
  const selected = [];
  let page = 1;

  console.log(`[shipbob] more: skipping ${known.size} existing; window ${startDate} → ${endDate}`);

  while (selected.length < TARGET && page <= 20) {
    const batch = await client.listOrders({ page, limit: 250, startDate, endDate });
    console.log(`[shipbob] page ${page}: ${batch.length}`);
    if (!batch.length) break;

    for (const order of batch) {
      const tracked = (order.shipments ?? []).filter((s) => s.tracking?.tracking_number && s.id);
      if (!tracked.length) continue;
      const newOnes = tracked.filter((s) => !known.has(String(s.id)));
      if (!newOnes.length) continue;
      selected.push(order);
      for (const s of newOnes) known.add(String(s.id));
      if (selected.length >= TARGET) break;
    }
    page += 1;
  }

  const sourceShipmentIds: string[] = [];
  let shipments = 0;
  for (const order of selected) {
    const result = await ingestShipBobOrder(db, order);
    shipments += result.shipmentIds.length;
    sourceShipmentIds.push(...result.sourceShipmentIds);
  }
  const poll = await pollShipBobTrackingForIds(db, client, [...new Set(sourceShipmentIds)]);
  console.log(`[shipbob] more done: orders=${selected.length} shipments=${shipments} events=${poll.eventsInserted}`);
  return { orders: selected.length, shipments, events: poll.eventsInserted };
}

async function seedMoreKlb(db: ReturnType<typeof createPool>, env: ReturnType<typeof loadEnv>) {
  if (!env.KLB_LEGACY_API_SECRET) throw new Error('KLB_LEGACY_API_SECRET required');
  if (!env.TRACKINGMORE_API_KEY) throw new Error('TRACKINGMORE_API_KEY required');

  const known = await existingIds(db, 'klb');
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

  const endDate = isoDaysAgoStart(DAYS_AGO);
  const startDate = isoDaysAgoStart(DAYS_AGO + 45);
  console.log(`[klb] more: skipping ${known.size} existing; window ${startDate} → ${endDate}`);

  const raw = await klb.listShippingOrders({ startDate, endDate });
  const candidates = flattenKlbCandidates(raw).filter((c) => !known.has(c.shipmentKey));
  const selected = candidates.slice(0, TARGET);
  console.log(`[klb] candidates new=${candidates.length}, taking=${selected.length}`);

  let shipments = 0;
  let events = 0;
  for (const c of selected) {
    const { orderId, shipmentId } = await ingestKlbShipment(db, c);
    shipments += 1;
    known.add(c.shipmentKey);
    const enrich = await enrichKlbWithTrackingMore(db, tm, shipmentId, orderId, c.tracking, c.carrier);
    events += enrich.eventsInserted;
  }

  // Catch-up poll for any still-empty TM timelines from this batch
  const poll = await pollOpenTrackingMoreShipments(db, tm, { limit: 100, includeTerminal: false });
  console.log(`[klb] more done: shipments=${shipments} events=${events}; poll=`, poll);
  return { shipments, events, poll };
}

async function main() {
  const env = loadEnv();
  const db = createPool(env);
  console.log('=== Seed +50 ShipBob + +50 KLB ===');
  const sb = await seedMoreShipBob(db, env);
  const klb = await seedMoreKlb(db, env);
  const carriers = await db.query(`
    SELECT COALESCE(c.code, s.carrier_code, '(none)') AS code,
           COALESCE(c.display_name, s.carrier_code, '(none)') AS name,
           count(*)::int AS n
    FROM shipments s
    LEFT JOIN carriers c ON c.code = s.carrier_code
    GROUP BY 1, 2
    ORDER BY n DESC
  `);
  const totals = await db.query(`SELECT source, count(*)::int AS n FROM shipments GROUP BY 1 ORDER BY 1`);
  console.log('ShipBob:', sb);
  console.log('KLB:', klb);
  console.log('Totals:', totals.rows);
  console.log('Carriers:', carriers.rows);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
