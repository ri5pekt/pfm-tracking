import type { Db } from '../db/pool.js';
import { statusLabel } from './public-tracking.js';

export type ExternalShipment = {
  id: string;
  status: string;
  statusLabel: string;
  carrier: string | null;
  carrierCode: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  isStalled: boolean;
  edd: string | null;
  lastEventAt: string | null;
};

export type ExternalOrderPayload = {
  orderId: string;
  status: string;
  statusLabel: string;
  carrier: string | null;
  shipments: ExternalShipment[];
};

export function normalizeExternalOrderId(raw: string): string {
  return raw.trim().replace(/^#/, '');
}

export function resolveCarrierTrackingUrl(
  carrierTrackingUrl: string | null,
  template: string | null,
  trackingNumber: string | null,
): string | null {
  if (carrierTrackingUrl) return carrierTrackingUrl;
  if (template && trackingNumber) {
    return template.replace('{tracking_number}', encodeURIComponent(trackingNumber));
  }
  return null;
}

/** Order-level carrier: shipment matching roll-up status, else first named carrier. */
export function primaryCarrier(
  shipments: Array<{ status: string; carrier: string | null }>,
  orderStatus: string,
): string | null {
  const matching = shipments.find((s) => s.status === orderStatus && s.carrier);
  if (matching) return matching.carrier;
  return shipments.find((s) => s.carrier)?.carrier ?? null;
}

export async function lookupExternalOrder(
  db: Db,
  orderId: string,
): Promise<ExternalOrderPayload | null> {
  const { rows: orders } = await db.query<{
    id: string;
    order_number: string;
    current_status: string;
  }>(`SELECT id, order_number, current_status FROM orders WHERE order_number = $1`, [orderId]);
  const order = orders[0];
  if (!order) return null;

  const { rows: shipmentRows } = await db.query<{
    id: string;
    tracking_number: string | null;
    carrier_code: string | null;
    carrier_name: string | null;
    carrier_tracking_url: string | null;
    tracking_url_template: string | null;
    internal_status: string;
    is_stalled: boolean;
    edd: Date | null;
    last_event_at: Date | null;
  }>(
    `SELECT s.id, s.tracking_number, s.carrier_code, c.display_name AS carrier_name,
            s.carrier_tracking_url, c.tracking_url_template, s.internal_status,
            s.is_stalled, s.edd, s.last_event_at
     FROM shipments s
     LEFT JOIN carriers c ON c.code = s.carrier_code
     WHERE s.order_id = $1
     ORDER BY s.created_at`,
    [order.id],
  );

  const shipments: ExternalShipment[] = shipmentRows.map((s) => ({
    id: s.id,
    status: s.internal_status,
    statusLabel: statusLabel(s.internal_status),
    carrier: s.carrier_name ?? s.carrier_code,
    carrierCode: s.carrier_code,
    trackingNumber: s.tracking_number,
    trackingUrl: resolveCarrierTrackingUrl(
      s.carrier_tracking_url,
      s.tracking_url_template,
      s.tracking_number,
    ),
    isStalled: s.is_stalled,
    edd: s.edd ? new Date(s.edd).toISOString() : null,
    lastEventAt: s.last_event_at ? new Date(s.last_event_at).toISOString() : null,
  }));

  return {
    orderId: order.order_number,
    status: order.current_status,
    statusLabel: statusLabel(order.current_status),
    carrier: primaryCarrier(shipments, order.current_status),
    shipments,
  };
}
