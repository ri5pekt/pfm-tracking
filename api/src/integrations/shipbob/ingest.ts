import type { Db } from '../../db/pool.js';
import { loadStatusMappings } from '../../domain/status.js';
import {
  appendTrackingEvent,
  refreshShipmentStatus,
  replaceShipmentItems,
  resolveCarrierCode,
  upsertOrder,
  upsertShipment,
} from '../../domain/upsert.js';
import {
  chunkIds,
  type ShipBobClient,
  type ShipBobOrder,
  type ShipBobTrackingRecord,
} from './client.js';

export async function ingestShipBobOrder(db: Db, order: ShipBobOrder): Promise<{
  orderId: string;
  orderNumber: string;
  shipmentIds: string[];
  sourceShipmentIds: string[];
  items: Array<{
    shipmentId: string;
    sourceShipmentId: string;
    trackingNumber: string;
    created: boolean;
  }>;
}> {
  const orderNumber = String(order.order_number ?? order.reference_id ?? order.id);
  const orderedAt = order.purchase_date
    ? new Date(order.purchase_date)
    : order.created_date
      ? new Date(order.created_date)
      : null;

  const { id: orderId } = await upsertOrder(db, {
    orderNumber,
    customerEmail: order.recipient?.email ?? null,
    customerName: order.recipient?.name ?? null,
    customerPhone: order.recipient?.phone_number ?? null,
    destinationCity: order.recipient?.address?.city ?? null,
    destinationCountry: order.recipient?.address?.country ?? null,
    destinationPostcode: order.recipient?.address?.zip_code ?? null,
    orderedAt,
    currentStatus: order.status === 'Completed' ? 'DELIVERED' : 'PROCESSING',
    tokenSecret: process.env.ADMIN_SESSION_SECRET ?? 'dev-token-secret-change-me',
  });

  const shipmentIds: string[] = [];
  const sourceShipmentIds: string[] = [];
  const items: Array<{
    shipmentId: string;
    sourceShipmentId: string;
    trackingNumber: string;
    created: boolean;
  }> = [];
  const products = (order.products ?? []).map((p) => ({
    sku: String(p.sku ?? 'unknown'),
    quantity: p.quantity ?? 1,
    title: p.name ?? null,
  }));

  for (const sh of order.shipments ?? []) {
    if (!sh.id) continue;
    const tracking = sh.tracking?.tracking_number;
    if (!tracking) continue;

    const carrierCode = await resolveCarrierCode(db, 'shipbob', sh.tracking?.carrier ?? null);
    const { id: shipmentId, created } = await upsertShipment(db, {
      orderId,
      source: 'shipbob',
      sourceShipmentId: String(sh.id),
      sourceOrderId: String(order.id),
      carrierCode,
      trackingNumber: tracking,
      carrierTrackingUrl: sh.tracking?.tracking_url ?? null,
      internalStatus: 'LABEL_CREATED',
      statusRank: 30,
      shippedAt: sh.created_date ? new Date(sh.created_date) : null,
    });

    if (products.length) {
      await replaceShipmentItems(db, shipmentId, products);
    }

    shipmentIds.push(shipmentId);
    sourceShipmentIds.push(String(sh.id));
    items.push({
      shipmentId,
      sourceShipmentId: String(sh.id),
      trackingNumber: tracking,
      created,
    });
  }

  return { orderId, orderNumber, shipmentIds, sourceShipmentIds, items };
}

export async function applyShipBobTracking(
  db: Db,
  sourceShipmentId: string,
  record: ShipBobTrackingRecord,
  opts?: { emitNotifications?: boolean },
): Promise<{ eventsInserted: number }> {
  const shipment = await db.query<{ id: string; order_id: string }>(
    `SELECT id, order_id FROM shipments WHERE source = 'shipbob' AND source_shipment_id = $1`,
    [sourceShipmentId],
  );
  if (!shipment.rows[0]) return { eventsInserted: 0 };

  const shipmentId = shipment.rows[0].id;
  const orderId = shipment.rows[0].order_id;
  const mappings = await loadStatusMappings(db);

  const carrierCode = await resolveCarrierCode(db, 'shipbob', record.carrier ?? null);
  const eddSource =
    record.edd_source === 'carrier' || record.edd_source === 'shipbob'
      ? record.edd_source
      : null;

  await upsertShipment(db, {
    orderId,
    source: 'shipbob',
    sourceShipmentId,
    carrierCode,
    carrierService: record.service ?? null,
    trackingNumber: record.tracking_number ?? null,
    carrierTrackingUrl: record.tracking_url ?? null,
    edd: record.edd ? new Date(record.edd) : null,
    eddSource,
    lastMileCarrier: record.last_mile_carrier ?? null,
    deliverySignedBy: record.delivery_signed_by || null,
    proofOfDeliveryUrls: record.proof_of_delivery_urls ?? [],
  });

  let eventsInserted = 0;
  for (const h of record.history ?? []) {
    if (!h.timestamp || !h.status) continue;
    const occurredAt = new Date(h.timestamp);
    if (Number.isNaN(occurredAt.getTime())) continue;

    const loc =
      h.address?.location ||
      [h.address?.city, h.address?.state].filter(Boolean).join(', ') ||
      null;

    const result = await appendTrackingEvent(db, {
      orderId,
      shipmentId,
      occurredAt,
      source: 'shipbob',
      rawStatus: h.status,
      rawSubstatusCode: h.substatus_code ?? null,
      rawSubstatus: h.substatus ?? null,
      description: h.substatus_message ?? h.substatus ?? null,
      location: loc,
      latitude: h.address?.latitude ?? null,
      longitude: h.address?.longitude ?? null,
      rawPayload: h,
      mappings,
    });
    if (result.inserted) eventsInserted += 1;
  }

  await refreshShipmentStatus(db, shipmentId, {
    emitNotifications: opts?.emitNotifications,
  });
  return { eventsInserted };
}

/** Stay under ShipBob ~150 req/min when sweeping thousands of open IDs. */
const TRACKING_BATCH_GAP_MS = 450;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b/.test(msg) || /rate limit/i.test(msg);
}

/**
 * Fetch a tracking batch. On 5xx/other API errors (not 429), binary-split so one
 * poisoned ShipmentId cannot fail the whole sweep — ShipBob sometimes 500s on
 * specific IDs with an empty body.
 */
async function fetchTrackingRecordsResilient(
  client: ShipBobClient,
  ids: Array<string | number>,
  counters: { rateLimitRetries: number; apiErrorsSkipped: number; splits: number },
): Promise<ShipBobTrackingRecord[]> {
  if (ids.length === 0) return [];

  try {
    return await client.getShipmentsTracking(ids);
  } catch (err) {
    let failure: unknown = err;
    if (isRateLimitError(err)) {
      counters.rateLimitRetries += 1;
      console.warn('[shipbob.tracking] 429 — waiting 60s then retrying batch');
      await sleep(60_000);
      try {
        return await client.getShipmentsTracking(ids);
      } catch (retryErr) {
        if (isRateLimitError(retryErr)) throw retryErr;
        // Fall through to split/skip after cooldown.
        failure = retryErr;
      }
    }

    if (ids.length === 1) {
      counters.apiErrorsSkipped += 1;
      const msg = failure instanceof Error ? failure.message : String(failure);
      console.warn(`[shipbob.tracking] skip id=${ids[0]} — ${msg.slice(0, 160)}`);
      return [];
    }

    counters.splits += 1;
    const mid = Math.ceil(ids.length / 2);
    const left = ids.slice(0, mid);
    const right = ids.slice(mid);
    // Small gap between split halves to avoid bursting after a 500.
    const a = await fetchTrackingRecordsResilient(client, left, counters);
    await sleep(TRACKING_BATCH_GAP_MS);
    const b = await fetchTrackingRecordsResilient(client, right, counters);
    return [...a, ...b];
  }
}

export async function pollShipBobTrackingForIds(
  db: Db,
  client: ShipBobClient,
  sourceShipmentIds: string[],
): Promise<{
  tracked: number;
  eventsInserted: number;
  batches: number;
  missingFromApi: number;
  rateLimitRetries: number;
  apiErrorsSkipped: number;
  durationMs: number;
  refreshed: Array<{
    sourceShipmentId: string;
    shipmentId: string;
    orderId: string;
    orderNumber: string | null;
    trackingNumber: string | null;
    eventsInserted: number;
  }>;
}> {
  let tracked = 0;
  let eventsInserted = 0;
  const counters = { rateLimitRetries: 0, apiErrorsSkipped: 0, splits: 0 };
  const refreshed: Array<{
    sourceShipmentId: string;
    shipmentId: string;
    orderId: string;
    orderNumber: string | null;
    trackingNumber: string | null;
    eventsInserted: number;
  }> = [];

  const started = Date.now();
  const batches = chunkIds(sourceShipmentIds, 25);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i]!;
    if (i > 0) await sleep(TRACKING_BATCH_GAP_MS);

    const records = await fetchTrackingRecordsResilient(client, batch, counters);

    const byId = new Map(records.map((r) => [String(r.shipment_id), r]));
    for (const id of batch) {
      const record = byId.get(String(id));
      if (!record) continue;
      tracked += 1;
      const result = await applyShipBobTracking(db, String(id), record);
      eventsInserted += result.eventsInserted;
      if (result.eventsInserted > 0) {
        const meta = await db.query<{
          id: string;
          order_id: string;
          tracking_number: string | null;
          order_number: string | null;
        }>(
          `SELECT s.id, s.order_id, s.tracking_number, o.order_number
           FROM shipments s
           JOIN orders o ON o.id = s.order_id
           WHERE s.source = 'shipbob' AND s.source_shipment_id = $1`,
          [String(id)],
        );
        const row = meta.rows[0];
        if (row) {
          refreshed.push({
            sourceShipmentId: String(id),
            shipmentId: row.id,
            orderId: row.order_id,
            orderNumber: row.order_number,
            trackingNumber: row.tracking_number,
            eventsInserted: result.eventsInserted,
          });
        }
      }
    }

    if ((i + 1) % 40 === 0 || i + 1 === batches.length) {
      const elapsedSec = Math.round((Date.now() - started) / 1000);
      console.log(
        `[shipbob.tracking] progress ${i + 1}/${batches.length} batches — tracked=${tracked} events+${eventsInserted} skipped=${counters.apiErrorsSkipped} elapsed=${elapsedSec}s`,
      );
    }
  }

  if (counters.apiErrorsSkipped > 0 || counters.splits > 0) {
    console.warn(
      `[shipbob.tracking] resilient fetch: skipped=${counters.apiErrorsSkipped} splits=${counters.splits} rateLimitRetries=${counters.rateLimitRetries}`,
    );
  }

  return {
    tracked,
    eventsInserted,
    batches: batches.length,
    missingFromApi: Math.max(0, sourceShipmentIds.length - tracked - counters.apiErrorsSkipped),
    rateLimitRetries: counters.rateLimitRetries,
    apiErrorsSkipped: counters.apiErrorsSkipped,
    durationMs: Date.now() - started,
    refreshed,
  };
}
