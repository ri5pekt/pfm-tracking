import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';
import { KlbClient } from '../integrations/klb/client.js';
import {
  enrichKlbWithTrackingMore,
  flattenKlbCandidates,
  ingestKlbShipment,
} from '../integrations/klb/ingest.js';
import { ShipBobClient, type ShipBobOrder } from '../integrations/shipbob/client.js';
import { applyShipBobTracking, ingestShipBobOrder } from '../integrations/shipbob/ingest.js';
import { TrackingMoreClient } from '../integrations/trackingmore/client.js';
import { normalizeEmail, normalizePostcode } from './public-tracking.js';

export type HydrateOrderInput = {
  orderNumber: string;
  email?: string;
  postcode?: string;
  /**
   * Public `/go` / `/lookup` must prove email or postcode.
   * Keyed machine APIs may set false and match on Woo order id only.
   */
  requireIdentity?: boolean;
};

type HydrateMatchInput = {
  orderNumber: string;
  email: string;
  postcode: string;
  requireIdentity: boolean;
};

/**
 * On-demand ingest for `/go` / `/lookup` when the order is not in our DB yet
 * (pre-cutover orders). `/t/:token` still reads DB only.
 *
 * Does not emit Klaviyo events — historical catch-up would spam customers.
 */
export async function hydrateMissingOrder(
  db: Db,
  env: Env,
  input: HydrateOrderInput,
): Promise<boolean> {
  const orderNumber = input.orderNumber.trim();
  const email = input.email ? normalizeEmail(input.email) : '';
  const postcode = input.postcode ? normalizePostcode(input.postcode) : '';
  const requireIdentity = input.requireIdentity !== false;
  if (!orderNumber) return false;
  if (requireIdentity && !email && !postcode) return false;

  try {
    const match = { orderNumber, email, postcode, requireIdentity };
    const fromShipBob = await hydrateFromShipBob(db, env, match);
    if (fromShipBob) return true;
    return await hydrateFromKlb(db, env, match);
  } catch (err) {
    console.warn('[hydrate] failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

export function sourceCredentialsMatch(
  request: { email: string; postcode: string },
  source: { email?: string | null; postcode?: string | null },
): boolean {
  if (request.email && source.email && normalizeEmail(source.email) === request.email) {
    return true;
  }
  if (request.postcode && source.postcode && normalizePostcode(source.postcode) === request.postcode) {
    return true;
  }
  return false;
}

/** Public hydrate requires email/postcode; keyed APIs may skip. */
export function hydrateIdentityAllowed(
  requireIdentity: boolean,
  request: { email: string; postcode: string },
  source: { email?: string | null; postcode?: string | null },
): boolean {
  if (!requireIdentity) return true;
  return sourceCredentialsMatch(request, source);
}

async function hydrateFromShipBob(
  db: Db,
  env: Env,
  input: HydrateMatchInput,
): Promise<boolean> {
  if (!env.SHIPBOB_API_KEY) return false;

  const client = new ShipBobClient({
    apiKey: env.SHIPBOB_API_KEY,
    channelId: env.SHIPBOB_CHANNEL_ID,
    ordersBase: env.SHIPBOB_API_BASE,
    trackingBase: env.SHIPBOB_TRACKING_API_BASE,
    db,
  });

  const orders = await client.listOrders({
    referenceIds: [input.orderNumber],
    limit: 25,
  });
  const order = orders.find((o) => shipBobOrderMatches(o, input));
  if (!order) return false;

  const ingested = await ingestShipBobOrder(db, order);
  const ids = ingested.sourceShipmentIds.slice(0, 25);
  if (ids.length === 0) return true;

  const records = await client.getShipmentsTracking(ids);
  for (const record of records) {
    if (record.shipment_id == null) continue;
    await applyShipBobTracking(db, String(record.shipment_id), record, {
      emitNotifications: false,
    });
  }
  return true;
}

function shipBobOrderMatches(order: ShipBobOrder, input: HydrateMatchInput): boolean {
  const ref = String(order.order_number ?? order.reference_id ?? '');
  if (ref !== input.orderNumber && String(order.id) !== input.orderNumber) return false;
  return hydrateIdentityAllowed(input.requireIdentity, input, {
    email: order.recipient?.email,
    postcode: order.recipient?.address?.zip_code,
  });
}

async function hydrateFromKlb(
  db: Db,
  env: Env,
  input: HydrateMatchInput,
): Promise<boolean> {
  if (!env.KLB_LEGACY_API_SECRET) return false;

  const klb = new KlbClient({
    apiBase: env.KLB_API_BASE,
    legacySecureKey: env.KLB_LEGACY_API_SECRET,
    apiKey: env.KLB_API_KEY,
    apiSecret: env.KLB_API_SECRET,
    db,
  });

  const shipping = await klb.findShippingOrdersByOrderNumber(input.orderNumber);
  if (shipping.length === 0) return false;

  const detail = await klb.getCustomerOrder(input.orderNumber);
  const zip = shipping[0]?.shippingaddress?.zip ?? detail?.postcode ?? null;
  if (
    !hydrateIdentityAllowed(input.requireIdentity, input, {
      email: detail?.email,
      postcode: zip,
    })
  ) {
    return false;
  }

  const candidates = flattenKlbCandidates(shipping);
  if (candidates.length === 0) return false;

  const tm = env.TRACKINGMORE_API_KEY
    ? new TrackingMoreClient({
        apiKey: env.TRACKINGMORE_API_KEY,
        apiBase: env.TRACKINGMORE_API_BASE,
        db,
      })
    : null;

  for (const c of candidates) {
    const ingested = await ingestKlbShipment(db, c, klb);
    if (tm) {
      await enrichKlbWithTrackingMore(
        db,
        tm,
        ingested.shipmentId,
        ingested.orderId,
        c.tracking,
        c.carrier,
        { emitNotifications: false },
      );
    }
  }
  return true;
}
