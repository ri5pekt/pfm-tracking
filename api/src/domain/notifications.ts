import type { Db } from '../db/pool.js';
import { KlaviyoClient, klaviyoMetricName } from '../integrations/klaviyo/client.js';
import { resolveOrderTrackingUrl } from './public-tracking.js';

export const NOTIFICATION_EVENT_TYPES = [
  'shipment.shipped',
  'shipment.in_transit',
  'shipment.out_for_delivery',
  'shipment.delivered',
  'shipment.delivery_attempt_failed',
  'shipment.exception',
  'shipment.stalled',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export type NotificationEnv = {
  dryRun: boolean;
  apiKey?: string | null;
  publicBaseUrl: string;
  tokenSecret: string;
};

export function loadNotificationEnv(
  raw: NodeJS.ProcessEnv = process.env,
): NotificationEnv {
  return {
    dryRun: raw.KLAVIYO_DRY_RUN !== 'false',
    apiKey: raw.KLAVIYO_API_KEY ?? null,
    publicBaseUrl: raw.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    tokenSecret: raw.ADMIN_SESSION_SECRET ?? '',
  };
}

export function dedupeKey(shipmentId: string, eventType: NotificationEventType): string {
  return `${shipmentId}:${eventType}`;
}

const ATTEMPT_FAIL_RAW = new Set([
  'deliveryattemptfailed',
  'attemptfail',
  'deliveryfailure',
  'undelivered',
]);

export function isDeliveryAttemptFailed(rawStatus: string | null | undefined): boolean {
  if (!rawStatus) return false;
  const n = rawStatus.toLowerCase().replace(/[_\s-]/g, '');
  return ATTEMPT_FAIL_RAW.has(n) || n.includes('attemptfail') || n.includes('deliveryattempt');
}

type ShipmentNotifyRow = {
  id: string;
  order_id: string;
  internal_status: string;
  status_rank: number;
  is_stalled: boolean;
  tracking_number: string | null;
  carrier_code: string | null;
  carrier_tracking_url: string | null;
  edd: Date | null;
  order_number: string;
  customer_email: string | null;
  customer_name: string | null;
  destination_country: string | null;
  carrier_name: string | null;
  latest_raw_status: string | null;
  latest_description: string | null;
};

async function loadShipment(db: Db, shipmentId: string): Promise<ShipmentNotifyRow | null> {
  const { rows } = await db.query<ShipmentNotifyRow>(
    `SELECT s.id, s.order_id, s.internal_status, s.status_rank, s.is_stalled,
            s.tracking_number, s.carrier_code, s.carrier_tracking_url, s.edd,
            o.order_number, o.customer_email, o.customer_name, o.destination_country,
            c.display_name AS carrier_name,
            (
              SELECT te.raw_status FROM tracking_events te
              WHERE te.shipment_id = s.id
              ORDER BY te.occurred_at DESC, te.status_rank DESC, te.id DESC
              LIMIT 1
            ) AS latest_raw_status,
            (
              SELECT te.description FROM tracking_events te
              WHERE te.shipment_id = s.id
              ORDER BY te.occurred_at DESC, te.status_rank DESC, te.id DESC
              LIMIT 1
            ) AS latest_description
     FROM shipments s
     JOIN orders o ON o.id = s.order_id
     LEFT JOIN carriers c ON c.code = s.carrier_code
     WHERE s.id = $1`,
    [shipmentId],
  );
  return rows[0] ?? null;
}

async function loadItems(db: Db, shipmentId: string, publicBaseUrl: string) {
  const { rows } = await db.query<{
    sku: string;
    quantity: number;
    title: string | null;
    image_url: string | null;
    description: string | null;
    product_url: string | null;
    catalog_source: string | null;
  }>(
    `SELECT si.sku, si.quantity,
            COALESCE(NULLIF(trim(si.title), ''), p.title) AS title,
            COALESCE(NULLIF(trim(si.image_url), ''), p.image_url) AS image_url,
            p.description,
            p.product_url,
            p.source AS catalog_source
     FROM shipment_items si
     LEFT JOIN LATERAL (
       SELECT pr.title, pr.image_url, pr.description, pr.product_url, pr.source
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
    [shipmentId],
  );

  const base = publicBaseUrl.replace(/\/$/, '');
  return rows
    .filter((i) => i.catalog_source !== 'packaging')
    .map((i) => {
      const image = i.image_url?.trim() || null;
      const imageUrl =
        image && image.startsWith('/')
          ? `${base}${image}`
          : image;
      return {
        // Narvar-compatible names for Klaviyo flow templates
        product_sku: i.sku,
        name: i.title,
        description: i.description,
        item_url: i.product_url,
        image_url: imageUrl,
        quantity: i.quantity,
        // camelCase aliases (existing PFM shape)
        sku: i.sku,
        title: i.title,
        imageUrl,
        itemUrl: i.product_url,
      };
    });
}

function candidateTypes(row: ShipmentNotifyRow): NotificationEventType[] {
  const types: NotificationEventType[] = [];

  if (row.tracking_number && row.status_rank >= 30) {
    types.push('shipment.shipped');
  }
  // Once per shipment (dedupe_key); rank>=40 covers catch-up if we miss the IN_TRANSIT poll.
  if (row.status_rank >= 40) {
    types.push('shipment.in_transit');
  }
  if (row.internal_status === 'OUT_FOR_DELIVERY') {
    types.push('shipment.out_for_delivery');
  }
  if (row.internal_status === 'DELIVERED') {
    types.push('shipment.delivered');
  }
  if (row.internal_status === 'EXCEPTION') {
    if (isDeliveryAttemptFailed(row.latest_raw_status)) {
      types.push('shipment.delivery_attempt_failed');
    } else {
      types.push('shipment.exception');
    }
  }
  if (row.is_stalled) {
    types.push('shipment.stalled');
  }

  return types;
}

async function buildPayload(
  db: Db,
  env: NotificationEnv,
  row: ShipmentNotifyRow,
  eventType: NotificationEventType,
): Promise<Record<string, unknown>> {
  const trackingPageUrl = env.tokenSecret
    ? await resolveOrderTrackingUrl(db, row.order_id, env.tokenSecret, env.publicBaseUrl)
    : null;
  const items = await loadItems(db, row.id, env.publicBaseUrl);

  const carrierDescription = row.latest_description;

  return {
    event: eventType,
    email: row.customer_email,
    customerName: row.customer_name,
    orderNumber: row.order_number,
    order_number: row.order_number,
    trackingPageUrl,
    tracking_url: trackingPageUrl,
    carrier: row.carrier_name ?? row.carrier_code,
    trackingNumber: row.tracking_number,
    tracking_number: row.tracking_number,
    carrierTrackingUrl: row.carrier_tracking_url,
    edd: row.edd ? new Date(row.edd).toISOString() : null,
    destinationCountry: row.destination_country,
    internalStatus: row.internal_status,
    latestDescription: carrierDescription,
    // Narvar template aliases (see examples/klavio-events/)
    carrier_description: carrierDescription,
    shipment_status: carrierDescription,
    package_status: carrierDescription,
    notification_type:
      eventType === 'shipment.in_transit'
        ? 'shipment_confirmation_standard' // Narvar In Transit
        : eventType === 'shipment.out_for_delivery'
          ? 'outfordelivery_standard'
          : eventType === 'shipment.delivery_attempt_failed'
            ? 'delivery_attempt_standard'
            : eventType === 'shipment.exception'
              ? 'exception'
              : eventType.replace(/^shipment\./, ''),
    item_names: items.map((i) => i.name).filter(Boolean),
    items,
    dryRun: env.dryRun || !env.apiKey,
  };
}

async function sendToKlaviyo(
  db: Db,
  env: NotificationEnv,
  notificationId: string,
  eventType: string,
  dedupe: string,
  payload: Record<string, unknown>,
): Promise<'sent' | 'failed' | 'suppressed'> {
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  if (!email) {
    await db.query(
      `UPDATE notification_log SET status = 'suppressed', updated_at = now(),
         payload = payload || $2::jsonb
       WHERE id = $1`,
      [notificationId, JSON.stringify({ suppressReason: 'missing_email' })],
    );
    return 'suppressed';
  }

  if (env.dryRun || !env.apiKey) {
    await db.query(
      `UPDATE notification_log SET status = 'sent', updated_at = now() WHERE id = $1`,
      [notificationId],
    );
    return 'sent';
  }

  try {
    const client = new KlaviyoClient({ apiKey: env.apiKey, db });
    const { dryRun: _d, ...properties } = payload;
    await client.createEvent({
      metricName: klaviyoMetricName(eventType),
      email,
      properties,
      uniqueId: dedupe,
    });
    await db.query(
      `UPDATE notification_log SET status = 'sent', updated_at = now() WHERE id = $1`,
      [notificationId],
    );
    return 'sent';
  } catch (err) {
    await db.query(
      `UPDATE notification_log SET
         status = 'failed',
         updated_at = now(),
         payload = payload || $2::jsonb
       WHERE id = $1`,
      [
        notificationId,
        JSON.stringify({
          sendError: err instanceof Error ? err.message : String(err),
        }),
      ],
    );
    return 'failed';
  }
}

/**
 * Insert notification_log row if new (unique dedupe_key), then send (or dry-run).
 * Safe to call on every status refresh.
 */
export async function emitShipmentNotifications(
  db: Db,
  shipmentId: string,
  env: NotificationEnv = loadNotificationEnv(),
): Promise<{ attempted: NotificationEventType[]; inserted: NotificationEventType[] }> {
  const row = await loadShipment(db, shipmentId);
  if (!row) return { attempted: [], inserted: [] };

  const types = candidateTypes(row);
  const inserted: NotificationEventType[] = [];

  for (const eventType of types) {
    const key = dedupeKey(shipmentId, eventType);
    const payload = await buildPayload(db, env, row, eventType);

    const result = await db.query<{ id: string }>(
      `INSERT INTO notification_log (order_id, shipment_id, event_type, dedupe_key, status, payload)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [row.order_id, shipmentId, eventType, key, JSON.stringify(payload)],
    );

    if (!result.rows[0]) continue;
    inserted.push(eventType);
    await sendToKlaviyo(db, env, result.rows[0].id, eventType, key, payload);
  }

  return { attempted: types, inserted };
}

export async function emitNotificationsForShipments(
  db: Db,
  shipmentIds: string[],
  env: NotificationEnv = loadNotificationEnv(),
): Promise<{ shipments: number; inserted: number }> {
  let inserted = 0;
  for (const id of shipmentIds) {
    const result = await emitShipmentNotifications(db, id, env);
    inserted += result.inserted.length;
  }
  return { shipments: shipmentIds.length, inserted };
}

/**
 * Force re-send an existing notification (new unique_id suffix for Klaviyo).
 * Updates replayed_by; does not violate dedupe_key uniqueness.
 */
export async function replayNotification(
  db: Db,
  notificationId: string,
  actorId: string,
  env: NotificationEnv = loadNotificationEnv(),
): Promise<{ ok: boolean; status: string; error?: string }> {
  const { rows } = await db.query<{
    id: string;
    event_type: string;
    dedupe_key: string;
    payload: Record<string, unknown> | null;
  }>(
    `SELECT id, event_type, dedupe_key, payload FROM notification_log WHERE id = $1`,
    [notificationId],
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 'failed', error: 'not_found' };

  const payload = {
    ...(row.payload ?? {}),
    dryRun: env.dryRun || !env.apiKey,
    replayedAt: new Date().toISOString(),
  };

  await db.query(
    `UPDATE notification_log SET
       status = 'pending',
       replayed_by = $2,
       payload = $3,
       updated_at = now()
     WHERE id = $1`,
    [notificationId, actorId, JSON.stringify(payload)],
  );

  const uniqueId = `${row.dedupe_key}:replay:${Date.now()}`;
  const status = await sendToKlaviyo(db, env, notificationId, row.event_type, uniqueId, payload);
  return { ok: status === 'sent' || status === 'suppressed', status };
}
