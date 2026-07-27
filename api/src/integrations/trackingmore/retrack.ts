import type { Db } from '../../db/pool.js';
import { looksLikeDhlEcommerce } from '../klb/client.js';
import { applyTrackingMoreTimeline } from '../klb/ingest.js';
import { TrackingMoreClient, trackingMoreCheckpoints } from './client.js';

export type RetrackResult = {
  ok: boolean;
  eventsInserted: number;
  deliveryStatus: string | null;
  checkpointCount: number;
  error?: string;
};

function courierHint(carrierCode: string | null, trackingNumber: string): string | null {
  if (carrierCode === 'dhl_ecs' || looksLikeDhlEcommerce(trackingNumber)) return 'dhlglobalmail';
  if (carrierCode === 'usps') return 'usps';
  if (carrierCode === 'uniuni') return 'uniuni';
  if (carrierCode === 'ontrac') return 'ontrac';
  if (carrierCode === 'fedex') return 'fedex';
  if (carrierCode === 'ups') return 'ups';
  return null;
}

/** Admin / CS action: force TrackingMore retrack + refresh timeline (USPS lag, expired, etc.). */
export async function retrackShipment(
  db: Db,
  tm: TrackingMoreClient,
  shipmentId: string,
): Promise<RetrackResult> {
  const { rows } = await db.query<{
    id: string;
    order_id: string;
    tracking_number: string | null;
    aggregator: string;
    aggregator_id: string | null;
    carrier_code: string | null;
    trackingmore_code: string | null;
  }>(
    `SELECT s.id, s.order_id, s.tracking_number, s.aggregator, s.aggregator_id, s.carrier_code,
            c.trackingmore_code
     FROM shipments s
     LEFT JOIN carriers c ON c.code = s.carrier_code
     WHERE s.id = $1`,
    [shipmentId],
  );
  const row = rows[0];
  if (!row) return { ok: false, eventsInserted: 0, deliveryStatus: null, checkpointCount: 0, error: 'not_found' };
  if (!row.tracking_number) {
    return { ok: false, eventsInserted: 0, deliveryStatus: null, checkpointCount: 0, error: 'no_tracking_number' };
  }
  if (row.aggregator !== 'trackingmore') {
    return {
      ok: false,
      eventsInserted: 0,
      deliveryStatus: null,
      checkpointCount: 0,
      error: 'not_trackingmore',
    };
  }

  try {
    if (row.aggregator_id) {
      await tm.retrackById(String(row.aggregator_id));
      await new Promise((r) => setTimeout(r, 600));
    }

    const preferred =
      row.trackingmore_code || courierHint(row.carrier_code, row.tracking_number);
    const tracking = await tm.ensureAndGet(row.tracking_number, preferred);
    if (!tracking) {
      return {
        ok: false,
        eventsInserted: 0,
        deliveryStatus: null,
        checkpointCount: 0,
        error: 'no_tracking_payload',
      };
    }

    const applied = await applyTrackingMoreTimeline(db, row.id, row.order_id, tracking);
    const checkpoints = trackingMoreCheckpoints(tracking);
    return {
      ok: true,
      eventsInserted: applied.eventsInserted,
      deliveryStatus: tracking.delivery_status ?? null,
      checkpointCount: checkpoints.length,
    };
  } catch (err) {
    return {
      ok: false,
      eventsInserted: 0,
      deliveryStatus: null,
      checkpointCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
