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

  await refreshShipmentStatus(db, shipmentId);
  return { eventsInserted };
}

export async function pollShipBobTrackingForIds(
  db: Db,
  client: ShipBobClient,
  sourceShipmentIds: string[],
): Promise<{
  tracked: number;
  eventsInserted: number;
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
  const refreshed: Array<{
    sourceShipmentId: string;
    shipmentId: string;
    orderId: string;
    orderNumber: string | null;
    trackingNumber: string | null;
    eventsInserted: number;
  }> = [];

  for (const batch of chunkIds(sourceShipmentIds, 25)) {
    const records = await client.getShipmentsTracking(batch);
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
  }

  return { tracked, eventsInserted, refreshed };
}
