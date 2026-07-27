import type { Db } from '../../db/pool.js';
import { loadStatusMappings } from '../../domain/status.js';
import {
  appendTrackingEvent,
  refreshShipmentStatus,
  resolveCarrierCode,
  upsertOrder,
  upsertShipment,
} from '../../domain/upsert.js';
import {
  klbCarrierName,
  klbTrackingNumber,
  looksLikeDhlEcommerce,
  type KlbShippingOrder,
} from '../klb/client.js';
import {
  parseTrackingMoreDate,
  trackingMoreCheckpoints,
  type TrackingMoreClient,
  type TrackingMoreTracking,
} from '../trackingmore/client.js';

export function pickKlbOrderNumber(order: KlbShippingOrder): string {
  return String(
    order.customerorder?.ordernumber ??
      order.customerorder?.customerorderid ??
      order.shippingorderid,
  );
}

export function flattenKlbCandidates(orders: KlbShippingOrder[]): Array<{
  order: KlbShippingOrder;
  tracking: string;
  carrier: string | null;
  service: string | null;
  shipmentKey: string;
}> {
  const out: Array<{
    order: KlbShippingOrder;
    tracking: string;
    carrier: string | null;
    service: string | null;
    shipmentKey: string;
  }> = [];

  for (const order of orders) {
    for (const sh of order.shipments ?? []) {
      if (sh.cancelled) continue;
      const tracking = klbTrackingNumber(sh);
      if (!tracking) continue;
      const carrier = klbCarrierName(order, sh);
      const service = sh.service?.name || sh.service?.code || order.service?.name || null;
      const shipmentKey = String(sh.shipmentid ?? `${pickKlbOrderNumber(order)}:${tracking}`);
      out.push({
        order,
        tracking,
        carrier,
        service: service ? String(service) : null,
        shipmentKey,
      });
    }
  }

  out.sort((a, b) => Number(looksLikeDhlEcommerce(b.tracking)) - Number(looksLikeDhlEcommerce(a.tracking)));
  return out;
}

export async function ingestKlbShipment(
  db: Db,
  input: {
    order: KlbShippingOrder;
    tracking: string;
    carrier: string | null;
    service: string | null;
    shipmentKey: string;
  },
): Promise<{ orderId: string; shipmentId: string; created: boolean }> {
  const orderNumber = pickKlbOrderNumber(input.order);
  const shippedRaw = input.order.shippeddate;
  const shippedAt = shippedRaw ? new Date(shippedRaw.replace(' ', 'T') + 'Z') : null;
  const orderedRaw = input.order.ordereddate;
  const orderedAt = orderedRaw ? new Date(orderedRaw.replace(' ', 'T') + 'Z') : shippedAt;

  const customerName = [input.order.customer?.name, input.order.customer?.surname]
    .filter(Boolean)
    .join(' ')
    .trim();

  const { id: orderId } = await upsertOrder(db, {
    orderNumber,
    customerName: customerName || input.order.shippingaddress?.name || null,
    customerPhone: input.order.shippingaddress?.phone ?? null,
    destinationCity: input.order.shippingaddress?.city ?? null,
    destinationCountry: input.order.shippingaddress?.country ?? null,
    destinationPostcode: input.order.shippingaddress?.zip ?? null,
    orderedAt,
    currentStatus: 'LABEL_CREATED',
    tokenSecret: process.env.ADMIN_SESSION_SECRET ?? 'dev-token-secret-change-me',
  });

  // Blank carrier on many KLB rows — DHL-shaped tracking → dhl_ecs
  const carrierHint =
    input.carrier || (looksLikeDhlEcommerce(input.tracking) ? 'DHL eCommerce' : null);
  const carrierCode = await resolveCarrierCode(db, 'klb', carrierHint);

  const { id: shipmentId, created } = await upsertShipment(db, {
    orderId,
    source: 'klb',
    sourceShipmentId: input.shipmentKey,
    sourceOrderId: String(
      input.order.customerorder?.customerorderid ?? input.order.shippingorderid ?? orderNumber,
    ),
    carrierCode,
    carrierService: input.service,
    trackingNumber: input.tracking,
    aggregator: 'trackingmore',
    shippedAt,
    internalStatus: 'LABEL_CREATED',
    statusRank: 30,
  });

  return { orderId, shipmentId, created };
}

export async function applyTrackingMoreTimeline(
  db: Db,
  shipmentId: string,
  orderId: string,
  tracking: TrackingMoreTracking,
): Promise<{ eventsInserted: number }> {
  const mappings = await loadStatusMappings(db);
  const checkpoints = trackingMoreCheckpoints(tracking);
  let eventsInserted = 0;

  const carrierCode = await resolveCarrierCode(db, 'klb', tracking.courier_code ?? null);
  await db.query(
    `UPDATE shipments SET
       aggregator = 'trackingmore',
       aggregator_id = COALESCE($2, aggregator_id),
       carrier_code = COALESCE($3, carrier_code),
       updated_at = now()
     WHERE id = $1`,
    [shipmentId, tracking.id != null ? String(tracking.id) : null, carrierCode],
  );

  // Empty TM history is common right after create — no fake events.
  // trackingmore.poll catches up when checkpoints appear.
  if (checkpoints.length === 0) {
    await refreshShipmentStatus(db, shipmentId);
    return { eventsInserted: 0 };
  }

  for (const cp of checkpoints) {
    const occurredAt = parseTrackingMoreDate(cp.checkpoint_date);
    if (!occurredAt) continue;
    const rawStatus = cp.checkpoint_delivery_status ?? tracking.delivery_status ?? 'transit';
    const result = await appendTrackingEvent(db, {
      orderId,
      shipmentId,
      occurredAt,
      source: 'trackingmore',
      rawStatus,
      rawSubstatusCode: cp.checkpoint_delivery_substatus ?? cp.substatus ?? null,
      description: cp.tracking_detail ?? null,
      location: cp.location ?? null,
      rawPayload: cp,
      mappings,
    });
    if (result.inserted) eventsInserted += 1;
  }

  await refreshShipmentStatus(db, shipmentId);
  return { eventsInserted };
}

export async function enrichKlbWithTrackingMore(
  db: Db,
  tm: TrackingMoreClient,
  shipmentId: string,
  orderId: string,
  trackingNumber: string,
  preferredCourier?: string | null,
): Promise<{ eventsInserted: number; ok: boolean; error?: string }> {
  try {
    const courierHint =
      preferredCourier && /dhl/i.test(preferredCourier)
        ? 'dhlglobalmail'
        : looksLikeDhlEcommerce(trackingNumber)
          ? 'dhlglobalmail'
          : preferredCourier;
    const tracking = await tm.ensureAndGet(trackingNumber, courierHint);
    if (!tracking) return { eventsInserted: 0, ok: false, error: 'no_tracking_payload' };
    const result = await applyTrackingMoreTimeline(db, shipmentId, orderId, tracking);
    return { ...result, ok: true };
  } catch (err) {
    return {
      eventsInserted: 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
