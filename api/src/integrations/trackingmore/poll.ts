import type { Db } from '../../db/pool.js';
import { looksLikeDhlEcommerce } from '../klb/client.js';
import { applyTrackingMoreTimeline } from '../klb/ingest.js';
import {
  courierHintForShipment,
  isTrackingMoreRateLimitError,
  TM_BATCH_MAX,
  TrackingMoreClient,
  trackingMoreCheckpoints,
  type TrackingMoreCreateItem,
} from './client.js';

const TERMINAL = new Set(['DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER']);

export type TrackingMorePollResult = {
  considered: number;
  refreshed: number;
  eventsInserted: number;
  withCheckpoints: number;
  stillPending: number;
  errors: number;
  registered: number;
  stoppedForRateLimit: boolean;
  items: Array<{
    shipmentId: string;
    orderId: string;
    orderNumber: string | null;
    trackingNumber: string;
    eventsInserted: number;
    action: 'updated' | 'unchanged' | 'error' | 'skipped';
    detail?: string;
  }>;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Re-poll TrackingMore for open aggregator=trackingmore shipments.
 * Respects TM rate limits: batch get/create (≤40), client-side pacing,
 * and abort the rest of the cycle on 429 (120s cooldown).
 */
export async function pollOpenTrackingMoreShipments(
  db: Db,
  tm: TrackingMoreClient,
  opts?: { limit?: number; includeTerminal?: boolean },
): Promise<TrackingMorePollResult> {
  // Keep cycles small enough that we stay under ~10 get-req/s with batching.
  const limit = opts?.limit ?? 80;
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
       )
     ORDER BY
       CASE WHEN s.aggregator_id IS NULL THEN 0 ELSE 1 END,
       (SELECT count(*) FROM tracking_events te WHERE te.shipment_id = s.id) ASC,
       s.last_event_at NULLS FIRST,
       s.updated_at ASC
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
    registered: 0,
    stoppedForRateLimit: false,
    items: [],
  };

  try {
    for (const batch of chunk(rows, TM_BATCH_MAX)) {
      const numbers = batch.map((r) => r.tracking_number);
      let got = await tm.getTrackings(numbers);

      const missing = batch.filter((r) => !got.has(r.tracking_number));
      if (missing.length > 0) {
        const createItems: TrackingMoreCreateItem[] = missing.map((r) => ({
          tracking_number: r.tracking_number,
          courier_code: courierHintForShipment(
            r.tracking_number,
            r.carrier_code,
            looksLikeDhlEcommerce,
          ),
        }));
        const created = await tm.createTrackingsBatch(createItems);
        result.registered += created.success.length;
        // already-exists etc. still count as registered enough to get
        const retryNums = missing.map((r) => r.tracking_number);
        const got2 = await tm.getTrackings(retryNums);
        for (const [tn, t] of got2) got.set(tn, t);
      }

      // Optional retrack for expired/notfound with known aggregator id (one at a time, paced)
      for (const row of batch) {
        const tracking = got.get(row.tracking_number);
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

        const status = tracking.delivery_status?.toLowerCase() ?? '';
        if (
          row.aggregator_id &&
          (status === 'expired' || status === 'notfound')
        ) {
          try {
            await tm.retrackById(String(row.aggregator_id));
            const again = await tm.getTracking(row.tracking_number);
            if (again) got.set(row.tracking_number, again);
          } catch (err) {
            if (isTrackingMoreRateLimitError(err)) throw err;
            // retrack not allowed / soft fail
          }
        }

        const finalTracking = got.get(row.tracking_number) ?? tracking;
        const checkpoints = trackingMoreCheckpoints(finalTracking);
        if (checkpoints.length > 0) result.withCheckpoints += 1;
        else if (['pending', 'notfound'].includes((finalTracking.delivery_status ?? '').toLowerCase())) {
          result.stillPending += 1;
        }

        if (checkpoints.length > 0) {
          await db.query(`UPDATE shipments SET status_source_event_id = NULL WHERE id = $1`, [
            row.id,
          ]);
          await db.query(
            `DELETE FROM tracking_events
             WHERE shipment_id = $1
               AND source = 'trackingmore'
               AND description LIKE 'TrackingMore status:%'`,
            [row.id],
          );
        }

        const applied = await applyTrackingMoreTimeline(
          db,
          row.id,
          row.order_id,
          finalTracking,
        );
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
      }
    }
  } catch (err) {
    if (isTrackingMoreRateLimitError(err)) {
      result.stoppedForRateLimit = true;
      console.warn(`[trackingmore.poll] stopped early: ${err.message}`);
      result.items.push({
        shipmentId: '',
        orderId: '',
        orderNumber: null,
        trackingNumber: '',
        eventsInserted: 0,
        action: 'skipped',
        detail: err.message.slice(0, 500),
      });
      return result;
    }
    throw err;
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
