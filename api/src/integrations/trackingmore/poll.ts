import type { Db } from '../../db/pool.js';
import { looksLikeDhlEcommerce } from '../klb/client.js';
import { applyTrackingMoreTimeline } from '../klb/ingest.js';
import { TrackingMoreClient, trackingMoreCheckpoints } from './client.js';

const TERMINAL = new Set(['DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER']);

export type TrackingMorePollResult = {
  considered: number;
  refreshed: number;
  eventsInserted: number;
  withCheckpoints: number;
  stillPending: number;
  errors: number;
  items: Array<{
    shipmentId: string;
    orderId: string;
    orderNumber: string | null;
    trackingNumber: string;
    eventsInserted: number;
    action: 'updated' | 'unchanged' | 'error';
    detail?: string;
  }>;
};

/**
 * Re-poll TrackingMore for open KLB (and any aggregator=trackingmore) shipments.
 * TrackingMore often returns pending/empty history for minutes–hours after create —
 * this is the durable catch-up path (also used by the worker).
 */
export async function pollOpenTrackingMoreShipments(
  db: Db,
  tm: TrackingMoreClient,
  opts?: { limit?: number; includeTerminal?: boolean },
): Promise<TrackingMorePollResult> {
  const limit = opts?.limit ?? 200;
  const { rows } = await db.query<{
    id: string;
    order_id: string;
    tracking_number: string;
    aggregator_id: string | null;
    carrier_code: string | null;
    internal_status: string;
    event_count: string;
    order_number: string | null;
  }>(
    `SELECT s.id, s.order_id, s.tracking_number, s.aggregator_id, s.carrier_code,
            s.internal_status, o.order_number,
            (SELECT count(*)::text FROM tracking_events te WHERE te.shipment_id = s.id) AS event_count
     FROM shipments s
     JOIN orders o ON o.id = s.order_id
     WHERE s.aggregator = 'trackingmore'
       AND s.tracking_number IS NOT NULL
       AND (
         $2::boolean
         OR s.internal_status NOT IN ('DELIVERED','CANCELLED','RETURNED_TO_SENDER')
         OR (SELECT count(*) FROM tracking_events te WHERE te.shipment_id = s.id) <= 1
       )
     ORDER BY s.updated_at ASC
     LIMIT $1`,
    [limit, opts?.includeTerminal ?? false],
  );

  const result: TrackingMorePollResult = {
    considered: rows.length,
    refreshed: 0,
    eventsInserted: 0,
    withCheckpoints: 0,
    stillPending: 0,
    errors: 0,
    items: [],
  };

  for (const row of rows) {
    try {
      const courierHint =
        row.carrier_code === 'dhl_ecs' || looksLikeDhlEcommerce(row.tracking_number)
          ? 'dhlglobalmail'
          : row.carrier_code === 'usps'
            ? 'usps'
            : null;

      // Prefer get; if expired/notfound and we have aggregator id, retrack then get again
      let tracking = await tm.getTracking(row.tracking_number);
      const status = tracking?.delivery_status?.toLowerCase() ?? '';
      if (
        row.aggregator_id &&
        (status === 'expired' || status === 'notfound' || status === 'pending')
      ) {
        try {
          await tm.retrackById(String(row.aggregator_id));
          await new Promise((r) => setTimeout(r, 500));
          tracking = (await tm.getTracking(row.tracking_number)) ?? tracking;
        } catch {
          // retrack only allowed for expired/notfound — ignore
        }
      }

      // If never registered successfully, try ensure again
      if (!tracking) {
        tracking = await tm.ensureAndGet(row.tracking_number, courierHint);
      }

      if (!tracking) {
        result.errors += 1;
        result.items.push({
          shipmentId: row.id,
          orderId: row.order_id,
          orderNumber: row.order_number,
          trackingNumber: row.tracking_number,
          eventsInserted: 0,
          action: 'error',
          detail: 'no_tracking_payload',
        });
        continue;
      }

      const checkpoints = trackingMoreCheckpoints(tracking);
      if (checkpoints.length > 0) result.withCheckpoints += 1;
      else if (['pending', 'notfound'].includes((tracking.delivery_status ?? '').toLowerCase())) {
        result.stillPending += 1;
      }

      // Clear FK before removing seed-era synthetic pending placeholders.
      if (checkpoints.length > 0) {
        await db.query(`UPDATE shipments SET status_source_event_id = NULL WHERE id = $1`, [row.id]);
        await db.query(
          `DELETE FROM tracking_events
           WHERE shipment_id = $1
             AND source = 'trackingmore'
             AND description LIKE 'TrackingMore status:%'`,
          [row.id],
        );
      }

      const applied = await applyTrackingMoreTimeline(db, row.id, row.order_id, tracking);
      result.refreshed += 1;
      result.eventsInserted += applied.eventsInserted;

      if (applied.eventsInserted > 0) {
        result.items.push({
          shipmentId: row.id,
          orderId: row.order_id,
          orderNumber: row.order_number,
          trackingNumber: row.tracking_number,
          eventsInserted: applied.eventsInserted,
          action: 'updated',
          detail: `events+${applied.eventsInserted}`,
        });
      }

      // Avoid hammering rate limits (TM ~10 req/s)
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      result.errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[trackingmore.poll] ${row.tracking_number}:`, err);
      result.items.push({
        shipmentId: row.id,
        orderId: row.order_id,
        orderNumber: row.order_number,
        trackingNumber: row.tracking_number,
        eventsInserted: 0,
        action: 'error',
        detail: msg.slice(0, 500),
      });
    }
  }

  return result;
}

export function needsTrackingMoreFollowUp(input: {
  internalStatus: string;
  checkpointCount: number;
  deliveryStatus?: string | null;
}): boolean {
  if (TERMINAL.has(input.internalStatus) && input.checkpointCount > 0) return false;
  if (input.checkpointCount === 0) return true;
  const st = (input.deliveryStatus ?? '').toLowerCase();
  return st === 'pending' || st === 'notfound' || st === 'transit';
}
