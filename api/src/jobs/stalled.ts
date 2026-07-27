import type { Db } from '../db/pool.js';
import { emitShipmentNotifications, loadNotificationEnv } from '../domain/notifications.js';

export type StalledDetectResult = {
  considered: number;
  newlyStalled: number;
  cleared: number;
  eventsEmitted: number;
};

/**
 * Flag open shipments with no new tracking event for `thresholdDays`.
 * Clears the flag when a fresher event appears. Emits shipment.stalled once
 * via notification_log dedupe.
 */
export async function detectStalledShipments(
  db: Db,
  opts?: { thresholdDays?: number },
): Promise<StalledDetectResult> {
  const thresholdDays = opts?.thresholdDays ?? Number(process.env.STALLED_DAYS ?? 7);
  const env = loadNotificationEnv();

  const result: StalledDetectResult = {
    considered: 0,
    newlyStalled: 0,
    cleared: 0,
    eventsEmitted: 0,
  };

  // Clear stalled when movement resumed
  const cleared = await db.query(
    `UPDATE shipments SET
       is_stalled = false,
       stalled_since = NULL,
       updated_at = now()
     WHERE is_stalled = true
       AND (
         internal_status IN ('DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER')
         OR (
           last_event_at IS NOT NULL
           AND last_event_at > now() - ($1::text || ' days')::interval
         )
       )`,
    [String(thresholdDays)],
  );
  result.cleared = cleared.rowCount ?? 0;

  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM shipments
     WHERE internal_status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER')
       AND tracking_number IS NOT NULL
       AND last_event_at IS NOT NULL
       AND last_event_at <= now() - ($1::text || ' days')::interval
       AND is_stalled = false`,
    [String(thresholdDays)],
  );
  result.considered = rows.length;

  for (const row of rows) {
    await db.query(
      `UPDATE shipments SET
         is_stalled = true,
         stalled_since = COALESCE(stalled_since, last_event_at, now()),
         updated_at = now()
       WHERE id = $1`,
      [row.id],
    );
    result.newlyStalled += 1;
    const emitted = await emitShipmentNotifications(db, row.id, env);
    result.eventsEmitted += emitted.inserted.length;
  }

  return result;
}
