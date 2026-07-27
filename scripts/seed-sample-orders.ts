/**
 * One-shot seed: 50 ShipBob + 50 KLB orders (≥14 days old) with timelines.
 * Run: npm run seed:samples
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

function redactShipBobOrders(orders: unknown[]): unknown[] {
  return orders.map((o) => {
    const order = o as Record<string, unknown>;
    const recipient = { ...(order.recipient as Record<string, unknown> | undefined) };
    if (recipient?.address && typeof recipient.address === 'object') {
      const addr = { ...(recipient.address as Record<string, unknown>) };
      delete addr.address1;
      delete addr.address2;
      recipient.address = addr;
    }
    return { ...order, recipient };
  });
}

async function seedShipBob(
  db: ReturnType<typeof createPool>,
  env: ReturnType<typeof loadEnv>,
  examplesDir: string,
): Promise<{ orders: number; shipments: number; events: number }> {
  if (!env.SHIPBOB_API_KEY) throw new Error('SHIPBOB_API_KEY required');

  const client = new ShipBobClient({
    apiKey: env.SHIPBOB_API_KEY,
    channelId: env.SHIPBOB_CHANNEL_ID,
    ordersBase: env.SHIPBOB_API_BASE,
    trackingBase: env.SHIPBOB_TRACKING_API_BASE,
    db,
  });

  const endDate = isoDaysAgo(DAYS_AGO);
  // Window ~30 days before the cutoff so we get completed cycles
  const startDate = isoDaysAgo(DAYS_AGO + 30);

  const collected = [];
  const sourceShipmentIds: string[] = [];
  let page = 1;

  console.log(`[shipbob] fetching orders EndDate<=${endDate} StartDate>=${startDate}`);

  while (collected.length < TARGET && page <= 10) {
    const batch = await client.listOrders({
      page,
      limit: 250,
      startDate,
      endDate,
    });
    console.log(`[shipbob] page ${page}: ${batch.length} orders`);
    if (batch.length === 0) break;

    for (const order of batch) {
      const withTracking = (order.shipments ?? []).filter((s) => s.tracking?.tracking_number);
      if (withTracking.length === 0) continue;
      // Prefer completed for full cycle
      collected.push(order);
      if (collected.length >= TARGET) break;
    }
    page += 1;
  }

  // Prefer Completed first
  collected.sort((a, b) => Number(b.status === 'Completed') - Number(a.status === 'Completed'));
  const selected = collected.slice(0, TARGET);

  await writeFile(
    path.join(examplesDir, 'shipbob-orders-sample.json'),
    JSON.stringify(redactShipBobOrders(selected), null, 2),
  );

  let shipments = 0;
  for (const order of selected) {
    const result = await ingestShipBobOrder(db, order);
    shipments += result.shipmentIds.length;
    sourceShipmentIds.push(...result.sourceShipmentIds);
  }

  console.log(`[shipbob] upserted ${selected.length} orders / ${shipments} shipments; polling tracking…`);
  const poll = await pollShipBobTrackingForIds(db, client, [...new Set(sourceShipmentIds)]);
  console.log(`[shipbob] tracked ${poll.tracked}, events inserted ${poll.eventsInserted}`);

  return { orders: selected.length, shipments, events: poll.eventsInserted };
}

async function seedKlb(
  db: ReturnType<typeof createPool>,
  env: ReturnType<typeof loadEnv>,
  examplesDir: string,
): Promise<{ orders: number; shipments: number; events: number; tmOk: number; tmFail: number }> {
  if (!env.KLB_LEGACY_API_SECRET) throw new Error('KLB_LEGACY_API_SECRET required');
  if (!env.TRACKINGMORE_API_KEY) throw new Error('TRACKINGMORE_API_KEY required');

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
  const startDate = isoDaysAgoStart(DAYS_AGO + 28);

  console.log(`[klb] fetching shippingorders ${startDate} → ${endDate}`);
  const raw = await klb.listShippingOrders({ startDate, endDate });
  console.log(`[klb] got ${raw.length} shipping orders`);

  const candidates = flattenKlbCandidates(raw);
  const selected = candidates.slice(0, TARGET);

  await writeFile(
    path.join(examplesDir, 'klb-shipping-orders-sample.json'),
    JSON.stringify(
      selected.map((c) => ({
        orderNumber: pickKlbOrderNumber(c.order),
        tracking: c.tracking,
        carrier: c.carrier,
        shippedDate: c.order.shippeddate,
        city: c.order.shippingaddress?.city,
        country: c.order.shippingaddress?.country,
      })),
      null,
      2,
    ),
  );

  let shipments = 0;
  let events = 0;
  let tmOk = 0;
  let tmFail = 0;
  const orderNumbers = new Set<string>();

  for (const c of selected) {
    const { orderId, shipmentId } = await ingestKlbShipment(db, c);
    shipments += 1;
    orderNumbers.add(pickKlbOrderNumber(c.order));

    const enrich = await enrichKlbWithTrackingMore(
      db,
      tm,
      shipmentId,
      orderId,
      c.tracking,
      c.carrier,
    );
    events += enrich.eventsInserted;
    if (enrich.ok) tmOk += 1;
    else {
      tmFail += 1;
      console.warn(`[klb/tm] ${c.tracking}: ${enrich.error}`);
    }
  }

  return { orders: orderNumbers.size, shipments, events, tmOk, tmFail };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const examplesDir = path.join(root, 'examples', 'seed');
  await mkdir(examplesDir, { recursive: true });

  console.log('=== Seed sample orders (50 ShipBob + 50 KLB, ≥14 days old) ===');

  const sb = await seedShipBob(db, env, examplesDir);
  const klb = await seedKlb(db, env, examplesDir);

  const summary = await db.query<{
    source: string;
    shipments: string;
    delivered: string;
    events: string;
  }>(
    `SELECT s.source,
            count(*)::text AS shipments,
            count(*) FILTER (WHERE s.internal_status = 'DELIVERED')::text AS delivered,
            (SELECT count(*)::text FROM tracking_events te
               JOIN shipments s2 ON s2.id = te.shipment_id
              WHERE s2.source = s.source) AS events
     FROM shipments s
     GROUP BY s.source
     ORDER BY s.source`,
  );

  console.log('\n=== Summary ===');
  console.log('ShipBob seed:', sb);
  console.log('KLB seed:', klb);
  console.log('DB by source:', summary.rows);

  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
