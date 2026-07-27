/**
 * Backfill notification_log (dry-run Klaviyo) for recent / open shipments.
 * Safe to re-run — unique dedupe_key.
 * Run: npm run sync:notifications
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';
import {
  emitNotificationsForShipments,
  loadNotificationEnv,
} from '../api/src/domain/notifications.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env);
  const notifyEnv = loadNotificationEnv();

  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM shipments
     WHERE tracking_number IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT 500`,
  );

  console.log(`=== notifications.emit backfill n=${rows.length} dryRun=${notifyEnv.dryRun} ===`);
  const result = await emitNotificationsForShipments(
    db,
    rows.map((r) => r.id),
    notifyEnv,
  );
  console.log(result);

  const counts = await db.query(
    `SELECT event_type, status, count(*)::int AS n
     FROM notification_log
     GROUP BY 1, 2
     ORDER BY 1, 2`,
  );
  console.log('notification_log:', counts.rows);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
