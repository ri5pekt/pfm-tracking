import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.js';

export type RetentionScrubResult = {
  apiCallLogDeleted: number;
  rawPayloadsScrubbed: number;
  notificationLogDeleted: number;
  trackingEventsDeleted: number;
  ordersAnonymised: number;
  ingestionRunsDeleted: number;
};

function emailHash(email: string): string {
  return `erased:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32)}`;
}

/** Phase 5 retention.scrub — safe to run daily. */
export async function runRetentionScrub(db: Db): Promise<RetentionScrubResult> {
  const api = await db.query(
    `DELETE FROM api_call_log WHERE occurred_at < now() - interval '30 days'`,
  );

  const payloads = await db.query(
    `UPDATE tracking_events SET raw_payload = NULL
     WHERE raw_payload IS NOT NULL
       AND received_at < now() - interval '30 days'`,
  );

  const notifications = await db.query(
    `DELETE FROM notification_log WHERE created_at < now() - interval '24 months'`,
  );

  const oldEvents = await db.query(
    `DELETE FROM tracking_events WHERE occurred_at < now() - interval '24 months'`,
  );

  // Anonymise delivered orders older than 24 months (keep rows for analytics)
  const aged = await db.query<{ id: string; customer_email: string | null }>(
    `SELECT o.id, o.customer_email
     FROM orders o
     WHERE o.anonymised_at IS NULL
       AND EXISTS (
         SELECT 1 FROM shipments s
         WHERE s.order_id = o.id
           AND s.internal_status = 'DELIVERED'
           AND COALESCE(s.delivered_at, s.updated_at) < now() - interval '24 months'
       )`,
  );

  let ordersAnonymised = 0;
  for (const row of aged.rows) {
    const hashed = row.customer_email ? emailHash(row.customer_email) : null;
    await db.query(
      `UPDATE orders SET
         customer_email = $2,
         customer_name = NULL,
         customer_phone = NULL,
         destination_city = NULL,
         destination_postcode = NULL,
         anonymised_at = now(),
         updated_at = now()
       WHERE id = $1`,
      [row.id, hashed],
    );
    ordersAnonymised += 1;
  }

  const oldRuns = await db.query(
    `DELETE FROM ingestion_runs WHERE started_at < now() - interval '90 days'`,
  );

  return {
    apiCallLogDeleted: api.rowCount ?? 0,
    rawPayloadsScrubbed: payloads.rowCount ?? 0,
    notificationLogDeleted: notifications.rowCount ?? 0,
    trackingEventsDeleted: oldEvents.rowCount ?? 0,
    ordersAnonymised,
    ingestionRunsDeleted: oldRuns.rowCount ?? 0,
  };
}

export type ErasureResult = {
  requestId: string;
  ordersAffected: number;
  eventsScrubbed: number;
};

/** GDPR on-demand anonymise for one email. */
export async function processDataErasure(
  db: Db,
  input: { email: string; requestedBy: string | null },
): Promise<ErasureResult> {
  const email = input.email.trim().toLowerCase();
  const { rows: reqRows } = await db.query<{ id: string }>(
    `INSERT INTO data_erasure_requests (customer_email, requested_by)
     VALUES ($1, $2)
     RETURNING id`,
    [email, input.requestedBy],
  );
  const requestId = reqRows[0]!.id;

  const orders = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE lower(trim(customer_email)) = $1 AND anonymised_at IS NULL`,
    [email],
  );

  let eventsScrubbed = 0;
  for (const order of orders.rows) {
    const scrub = await db.query(
      `UPDATE tracking_events SET
         description = NULL,
         location = NULL,
         latitude = NULL,
         longitude = NULL,
         raw_payload = NULL
       WHERE order_id = $1 AND (
         description IS NOT NULL OR location IS NOT NULL OR raw_payload IS NOT NULL
       )`,
      [order.id],
    );
    eventsScrubbed += scrub.rowCount ?? 0;

    await db.query(
      `UPDATE orders SET
         customer_email = $2,
         customer_name = NULL,
         customer_phone = NULL,
         destination_city = NULL,
         destination_postcode = NULL,
         anonymised_at = now(),
         updated_at = now()
       WHERE id = $1`,
      [order.id, emailHash(email)],
    );
  }

  await db.query(
    `UPDATE data_erasure_requests SET
       completed_at = now(),
       orders_affected = $2,
       events_scrubbed = $3
     WHERE id = $1`,
    [requestId, orders.rows.length, eventsScrubbed],
  );

  return {
    requestId,
    ordersAffected: orders.rows.length,
    eventsScrubbed,
  };
}
