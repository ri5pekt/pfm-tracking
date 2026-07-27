import type { Db } from '../db/pool.js';
import { hashPublicToken, mintPublicToken, unsealPublicToken } from './tokens.js';

export const STATUS_LABELS: Record<string, string> = {
  ORDER_RECEIVED: 'Order confirmed',
  PROCESSING: 'Preparing your order',
  LABEL_CREATED: 'Shipment ready',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  EXCEPTION: 'There was a delivery issue',
  DELIVERED: 'Delivered',
  RETURNED_TO_SENDER: 'Returning to sender',
  CANCELLED: 'Cancelled',
};

export function statusLabel(internal: string | null | undefined): string {
  if (!internal) return 'Unknown';
  return STATUS_LABELS[internal] ?? internal.replaceAll('_', ' ').toLowerCase();
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizePostcode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function publicLocation(location: string | null): string | null {
  if (!location) return null;
  // Prefer city/country style; strip obvious street-number prefixes when present.
  const cleaned = location.replace(/^\d+[A-Za-z]?\s+/, '').trim();
  return cleaned || null;
}

export type PublicTrackingPayload = {
  orderNumber: string;
  orderedAt: string | null;
  destinationCity: string | null;
  destinationCountry: string | null;
  shipments: Array<{
    id: string;
    status: string;
    statusLabel: string;
    statusRank: number;
    isStalled: boolean;
    carrierName: string | null;
    carrierCode: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    edd: string | null;
    shippedAt: string | null;
    deliveredAt: string | null;
    lastEventAt: string | null;
    items: Array<{
      sku: string;
      quantity: number;
      title: string | null;
      imageUrl: string | null;
    }>;
    events: Array<{
      occurredAt: string;
      status: string;
      statusLabel: string;
      description: string | null;
      location: string | null;
    }>;
  }>;
};

async function buildPayload(db: Db, orderId: string): Promise<PublicTrackingPayload | null> {
  const order = await db.query<{
    order_number: string;
    ordered_at: Date | null;
    destination_city: string | null;
    destination_country: string | null;
  }>(
    `SELECT order_number, ordered_at, destination_city, destination_country
     FROM orders WHERE id = $1`,
    [orderId],
  );
  if (!order.rows[0]) return null;
  const o = order.rows[0];

  const shipments = await db.query<{
    id: string;
    internal_status: string;
    status_rank: number;
    is_stalled: boolean;
    tracking_number: string | null;
    carrier_tracking_url: string | null;
    edd: Date | null;
    shipped_at: Date | null;
    delivered_at: Date | null;
    last_event_at: Date | null;
    carrier_code: string | null;
    carrier_name: string | null;
    tracking_url_template: string | null;
  }>(
    `SELECT s.id, s.internal_status, s.status_rank, s.is_stalled, s.tracking_number,
            s.carrier_tracking_url, s.edd, s.shipped_at, s.delivered_at, s.last_event_at,
            s.carrier_code, c.display_name AS carrier_name, c.tracking_url_template
     FROM shipments s
     LEFT JOIN carriers c ON c.code = s.carrier_code
     WHERE s.order_id = $1
     ORDER BY s.shipped_at NULLS LAST, s.created_at`,
    [orderId],
  );

  const payloadShipments = [];
  for (const s of shipments.rows) {
    const items = await db.query<{
      sku: string;
      quantity: number;
      title: string | null;
      image_url: string | null;
      catalog_source: string | null;
    }>(
      `SELECT si.sku, si.quantity,
              COALESCE(NULLIF(trim(si.title), ''), p.title) AS title,
              COALESCE(NULLIF(trim(si.image_url), ''), p.image_url) AS image_url,
              p.source AS catalog_source
       FROM shipment_items si
       LEFT JOIN LATERAL (
         SELECT pr.title, pr.image_url, pr.source
         FROM products pr
         LEFT JOIN product_sku_aliases a ON a.product_sku = pr.sku
         WHERE pr.sku = si.sku
            OR a.alias_sku = si.sku
            OR regexp_replace(pr.sku, '^0+', '') = regexp_replace(si.sku, '^0+', '')
         ORDER BY
           CASE
             WHEN pr.sku = si.sku THEN 0
             WHEN a.alias_sku = si.sku THEN 1
             ELSE 2
           END
         LIMIT 1
       ) p ON true
       WHERE si.shipment_id = $1
       ORDER BY si.created_at`,
      [s.id],
    );
    const events = await db.query<{
      occurred_at: Date;
      internal_status: string;
      description: string | null;
      location: string | null;
    }>(
      `SELECT occurred_at, internal_status, description, location
       FROM tracking_events
       WHERE shipment_id = $1
       ORDER BY occurred_at DESC, status_rank DESC, id DESC`,
      [s.id],
    );

    let trackingUrl = s.carrier_tracking_url;
    if (!trackingUrl && s.tracking_url_template && s.tracking_number) {
      trackingUrl = s.tracking_url_template.replace('{tracking_number}', encodeURIComponent(s.tracking_number));
    }

    payloadShipments.push({
      id: s.id,
      status: s.internal_status,
      statusLabel: statusLabel(s.internal_status),
      statusRank: s.status_rank,
      isStalled: s.is_stalled,
      carrierName: s.carrier_name,
      carrierCode: s.carrier_code,
      trackingNumber: s.tracking_number,
      trackingUrl,
      edd: s.edd ? new Date(s.edd).toISOString() : null,
      shippedAt: s.shipped_at ? new Date(s.shipped_at).toISOString() : null,
      deliveredAt: s.delivered_at ? new Date(s.delivered_at).toISOString() : null,
      lastEventAt: s.last_event_at ? new Date(s.last_event_at).toISOString() : null,
      items: items.rows
        .filter((i) => i.catalog_source !== 'packaging')
        .map((i) => ({
          sku: i.sku,
          quantity: i.quantity,
          title: i.title,
          imageUrl: i.image_url,
        })),
      events: events.rows.map((e) => ({
        occurredAt: new Date(e.occurred_at).toISOString(),
        status: e.internal_status,
        statusLabel: statusLabel(e.internal_status),
        description: e.description,
        location: publicLocation(e.location),
      })),
    });
  }

  return {
    orderNumber: o.order_number,
    orderedAt: o.ordered_at ? new Date(o.ordered_at).toISOString() : null,
    destinationCity: o.destination_city,
    destinationCountry: o.destination_country,
    shipments: payloadShipments,
  };
}

export async function getPublicTrackingByToken(
  db: Db,
  token: string,
): Promise<PublicTrackingPayload | null> {
  const hash = hashPublicToken(token);
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE public_token_hash = $1`,
    [hash],
  );
  if (!rows[0]) return null;
  return buildPayload(db, rows[0].id);
}

export async function lookupPublicTracking(
  db: Db,
  input: {
    orderNumber: string;
    email?: string;
    postcode?: string;
    tokenSecret: string;
    publicBaseUrl: string;
  },
): Promise<{ payload: PublicTrackingPayload; trackingUrl: string } | null> {
  const orderNumber = input.orderNumber.trim();
  if (!orderNumber) return null;

  const email = input.email ? normalizeEmail(input.email) : '';
  const postcode = input.postcode ? normalizePostcode(input.postcode) : '';
  if (!email && !postcode) return null;

  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM orders
     WHERE order_number = $1
       AND (
         ($2 <> '' AND lower(trim(coalesce(customer_email, ''))) = $2)
         OR ($3 <> '' AND regexp_replace(upper(coalesce(destination_postcode, '')), '\\s+', '', 'g') = $3)
       )
     LIMIT 1`,
    [orderNumber, email, postcode],
  );
  if (!rows[0]) return null;

  const trackingUrl = await resolveOrderTrackingUrl(
    db,
    rows[0].id,
    input.tokenSecret,
    input.publicBaseUrl,
  );
  const payload = await buildPayload(db, rows[0].id);
  if (!payload || !trackingUrl) return null;
  return { payload, trackingUrl };
}

export async function resolveOrderTrackingUrl(
  db: Db,
  orderId: string,
  secret: string,
  publicBaseUrl: string,
): Promise<string | null> {
  const { rows } = await db.query<{ public_token_sealed: string | null }>(
    `SELECT public_token_sealed FROM orders WHERE id = $1`,
    [orderId],
  );
  const sealed = rows[0]?.public_token_sealed;
  if (!sealed) return null;
  const token = unsealPublicToken(sealed, secret);
  if (!token) return null;
  const base = publicBaseUrl.replace(/\/$/, '');
  return `${base}/t/${token}`;
}

/** Ensure every order has a sealed token (re-mints when missing / corrupt). */
export async function ensureOrderTokensSealed(db: Db, secret: string): Promise<number> {
  const { rows } = await db.query<{ id: string; public_token_sealed: string | null }>(
    `SELECT id, public_token_sealed FROM orders`,
  );
  let fixed = 0;
  for (const row of rows) {
    if (row.public_token_sealed && unsealPublicToken(row.public_token_sealed, secret)) {
      continue;
    }
    const minted = mintPublicToken(secret);
    await db.query(
      `UPDATE orders
       SET public_token_hash = $2, public_token_sealed = $3, updated_at = now()
       WHERE id = $1`,
      [row.id, minted.hash, minted.sealed],
    );
    fixed += 1;
  }
  return fixed;
}
