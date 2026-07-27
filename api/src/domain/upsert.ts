import type { Db } from '../db/pool.js';
import { buildEventHash } from './event-hash.js';
import { emitShipmentNotifications, loadNotificationEnv } from './notifications.js';
import {
  applyStickyTerminal,
  loadStatusMappings,
  mapRawStatus,
  type MappedStatus,
  type StatusMapping,
} from './status.js';
import { mintPublicToken } from './tokens.js';

export type UpsertOrderInput = {
  orderNumber: string;
  customerEmail?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  destinationCity?: string | null;
  destinationCountry?: string | null;
  destinationPostcode?: string | null;
  orderedAt?: Date | null;
  currentStatus?: string;
  /** Required when inserting a new order — seals the public tracking token. */
  tokenSecret: string;
};

export type UpsertShipmentInput = {
  orderId: string;
  source: 'shipbob' | 'klb';
  sourceShipmentId: string;
  sourceOrderId?: string | null;
  carrierCode?: string | null;
  carrierService?: string | null;
  trackingNumber?: string | null;
  carrierTrackingUrl?: string | null;
  internalStatus?: string;
  statusRank?: number;
  aggregator?: 'none' | 'trackingmore';
  aggregatorId?: string | null;
  edd?: Date | null;
  eddSource?: 'carrier' | 'shipbob' | null;
  lastMileCarrier?: unknown;
  deliverySignedBy?: string | null;
  proofOfDeliveryUrls?: string[];
  shippedAt?: Date | null;
  deliveredAt?: Date | null;
  lastEventAt?: Date | null;
};

export type UpsertItemInput = {
  sku: string;
  quantity: number;
  title?: string | null;
  imageUrl?: string | null;
};

export type AppendEventInput = {
  orderId: string;
  shipmentId: string;
  occurredAt: Date;
  source: 'shipbob' | 'trackingmore' | 'system';
  rawStatus: string;
  rawSubstatusCode?: string | null;
  rawSubstatus?: string | null;
  description?: string | null;
  location?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  rawPayload?: unknown;
  mappings?: StatusMapping[];
};

export async function upsertOrder(
  db: Db,
  input: UpsertOrderInput,
): Promise<{ id: string; created: boolean }> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE order_number = $1`,
    [input.orderNumber],
  );
  if (existing.rows[0]) {
    await db.query(
      `UPDATE orders SET
         customer_email = COALESCE($2, customer_email),
         customer_name = COALESCE($3, customer_name),
         customer_phone = COALESCE($4, customer_phone),
         destination_city = COALESCE($5, destination_city),
         destination_country = COALESCE($6, destination_country),
         destination_postcode = COALESCE($7, destination_postcode),
         ordered_at = COALESCE($8, ordered_at),
         current_status = COALESCE($9, current_status),
         updated_at = now()
       WHERE id = $1`,
      [
        existing.rows[0].id,
        input.customerEmail ?? null,
        input.customerName ?? null,
        input.customerPhone ?? null,
        input.destinationCity ?? null,
        input.destinationCountry ?? null,
        input.destinationPostcode ?? null,
        input.orderedAt ?? null,
        input.currentStatus ?? null,
      ],
    );
    return { id: existing.rows[0].id, created: false };
  }

  const minted = mintPublicToken(input.tokenSecret);
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO orders (
       order_number, customer_email, customer_name, customer_phone,
       destination_city, destination_country, destination_postcode,
       public_token_hash, public_token_sealed,
       ordered_at, current_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      input.orderNumber,
      input.customerEmail ?? null,
      input.customerName ?? null,
      input.customerPhone ?? null,
      input.destinationCity ?? null,
      input.destinationCountry ?? null,
      input.destinationPostcode ?? null,
      minted.hash,
      minted.sealed,
      input.orderedAt ?? null,
      input.currentStatus ?? 'ORDER_RECEIVED',
    ],
  );
  return { id: inserted.rows[0].id, created: true };
}

export async function resolveCarrierCode(
  db: Db,
  source: 'shipbob' | 'klb',
  carrierName: string | null | undefined,
): Promise<string | null> {
  if (!carrierName) return null;
  const needle = carrierName.trim();
  const { rows } = await db.query<{ code: string }>(
    `SELECT code FROM carriers
     WHERE lower(display_name) = lower($1)
        OR EXISTS (
          SELECT 1 FROM unnest(shipbob_aliases) a WHERE lower(a) = lower($1)
        )
        OR lower(trackingmore_code) = lower($1)
     LIMIT 1`,
    [needle],
  );
  if (rows[0]) return rows[0].code;

  // Best-effort defaults for KLB carriers
  if (/dhl/i.test(needle)) return 'dhl_ecs';
  if (/usps|stamps/i.test(needle)) return 'usps';
  if (source === 'shipbob') return null;
  return null;
}

export async function upsertShipment(
  db: Db,
  input: UpsertShipmentInput,
): Promise<{ id: string; created: boolean }> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM shipments WHERE source = $1 AND source_shipment_id = $2`,
    [input.source, input.sourceShipmentId],
  );

  if (existing.rows[0]) {
    await db.query(
      `UPDATE shipments SET
         carrier_code = COALESCE($2, carrier_code),
         carrier_service = COALESCE($3, carrier_service),
         tracking_number = COALESCE($4, tracking_number),
         carrier_tracking_url = COALESCE($5, carrier_tracking_url),
         aggregator = COALESCE($6, aggregator),
         aggregator_id = COALESCE($7, aggregator_id),
         edd = COALESCE($8, edd),
         edd_source = COALESCE($9, edd_source),
         last_mile_carrier = COALESCE($10, last_mile_carrier),
         delivery_signed_by = COALESCE($11, delivery_signed_by),
         proof_of_delivery_urls = COALESCE($12, proof_of_delivery_urls),
         shipped_at = COALESCE($13, shipped_at),
         delivered_at = COALESCE($14, delivered_at),
         last_event_at = COALESCE($15, last_event_at),
         source_order_id = COALESCE($16, source_order_id),
         updated_at = now()
       WHERE id = $1`,
      [
        existing.rows[0].id,
        input.carrierCode ?? null,
        input.carrierService ?? null,
        input.trackingNumber ?? null,
        input.carrierTrackingUrl ?? null,
        input.aggregator ?? null,
        input.aggregatorId ?? null,
        input.edd ?? null,
        input.eddSource ?? null,
        input.lastMileCarrier ? JSON.stringify(input.lastMileCarrier) : null,
        input.deliverySignedBy ?? null,
        input.proofOfDeliveryUrls ?? null,
        input.shippedAt ?? null,
        input.deliveredAt ?? null,
        input.lastEventAt ?? null,
        input.sourceOrderId ?? null,
      ],
    );
    return { id: existing.rows[0].id, created: false };
  }

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO shipments (
       order_id, source, source_shipment_id, source_order_id,
       carrier_code, carrier_service, tracking_number, carrier_tracking_url,
       internal_status, status_rank, aggregator, aggregator_id,
       edd, edd_source, last_mile_carrier, delivery_signed_by,
       proof_of_delivery_urls, shipped_at, delivered_at, last_event_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
     ) RETURNING id`,
    [
      input.orderId,
      input.source,
      input.sourceShipmentId,
      input.sourceOrderId ?? null,
      input.carrierCode ?? null,
      input.carrierService ?? null,
      input.trackingNumber ?? null,
      input.carrierTrackingUrl ?? null,
      input.internalStatus ?? 'PROCESSING',
      input.statusRank ?? 20,
      input.aggregator ?? 'none',
      input.aggregatorId ?? null,
      input.edd ?? null,
      input.eddSource ?? null,
      input.lastMileCarrier ? JSON.stringify(input.lastMileCarrier) : null,
      input.deliverySignedBy ?? null,
      input.proofOfDeliveryUrls ?? [],
      input.shippedAt ?? null,
      input.deliveredAt ?? null,
      input.lastEventAt ?? null,
    ],
  );
  return { id: inserted.rows[0].id, created: true };
}

export async function replaceShipmentItems(
  db: Db,
  shipmentId: string,
  items: UpsertItemInput[],
): Promise<void> {
  await db.query(`DELETE FROM shipment_items WHERE shipment_id = $1`, [shipmentId]);
  for (const item of items) {
    await db.query(
      `INSERT INTO shipment_items (shipment_id, sku, quantity, title, image_url)
       VALUES ($1,$2,$3,$4,$5)`,
      [shipmentId, item.sku, item.quantity, item.title ?? null, item.imageUrl ?? null],
    );
  }
}

export async function appendTrackingEvent(
  db: Db,
  input: AppendEventInput,
): Promise<{ id: string | null; inserted: boolean; mapped: MappedStatus }> {
  const mappings = input.mappings ?? (await loadStatusMappings(db));
  const mapped = mapRawStatus(mappings, {
    source: input.source,
    rawStatus: input.rawStatus,
    rawSubstatusCode: input.rawSubstatusCode,
  });

  const eventHash = buildEventHash({
    shipmentId: input.shipmentId,
    occurredAt: input.occurredAt,
    rawStatus: input.rawStatus,
    rawSubstatusCode: input.rawSubstatusCode,
    description: input.description,
  });

  const result = await db.query<{ id: string }>(
    `INSERT INTO tracking_events (
       order_id, shipment_id, occurred_at, internal_status, status_rank,
       source, raw_status, raw_substatus_code, raw_substatus, description,
       location, latitude, longitude, raw_payload, event_hash
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
     )
     ON CONFLICT (event_hash) DO NOTHING
     RETURNING id`,
    [
      input.orderId,
      input.shipmentId,
      input.occurredAt,
      mapped.internalStatus,
      mapped.statusRank,
      input.source,
      input.rawStatus,
      input.rawSubstatusCode ?? null,
      input.rawSubstatus ?? null,
      input.description ?? null,
      input.location ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      input.rawPayload ? JSON.stringify(input.rawPayload) : null,
      eventHash,
    ],
  );

  return {
    id: result.rows[0]?.id ?? null,
    inserted: result.rows.length > 0,
    mapped,
  };
}

export async function refreshShipmentStatus(db: Db, shipmentId: string): Promise<MappedStatus | null> {
  const current = await db.query<{
    internal_status: string;
    status_rank: number;
  }>(`SELECT internal_status, status_rank FROM shipments WHERE id = $1`, [shipmentId]);

  const latest = await db.query<{
    id: string;
    internal_status: string;
    status_rank: number;
    occurred_at: Date;
  }>(
    `SELECT id, internal_status, status_rank, occurred_at
     FROM tracking_events
     WHERE shipment_id = $1
     ORDER BY occurred_at DESC, status_rank DESC, id DESC
     LIMIT 1`,
    [shipmentId],
  );

  if (!latest.rows[0]) return null;

  const next: MappedStatus = {
    internalStatus: latest.rows[0].internal_status,
    statusRank: latest.rows[0].status_rank,
  };
  const sticky = applyStickyTerminal(
    current.rows[0]
      ? {
          internalStatus: current.rows[0].internal_status,
          statusRank: current.rows[0].status_rank,
        }
      : null,
    next,
  );

  const deliveredAt =
    sticky.internalStatus === 'DELIVERED' ? latest.rows[0].occurred_at : null;

  await db.query(
    `UPDATE shipments SET
       internal_status = $2,
       status_rank = $3,
       status_source_event_id = $4,
       last_event_at = $5,
       delivered_at = COALESCE($6, delivered_at),
       updated_at = now()
     WHERE id = $1`,
    [
      shipmentId,
      sticky.internalStatus,
      sticky.statusRank,
      latest.rows[0].id,
      latest.rows[0].occurred_at,
      deliveredAt,
    ],
  );

  // Roll up order status to max rank across shipments
  await db.query(
    `UPDATE orders o SET
       current_status = s.internal_status,
       updated_at = now()
     FROM (
       SELECT order_id, internal_status
       FROM shipments
       WHERE order_id = (SELECT order_id FROM shipments WHERE id = $1)
       ORDER BY status_rank DESC, updated_at DESC
       LIMIT 1
     ) s
     WHERE o.id = s.order_id`,
    [shipmentId],
  );

  // Phase 3: Klaviyo / notification_log (deduped; dry-run by default)
  try {
    await emitShipmentNotifications(db, shipmentId, loadNotificationEnv());
  } catch (err) {
    console.warn(`[notifications] emit failed for ${shipmentId}:`, err);
  }

  return sticky;
}
