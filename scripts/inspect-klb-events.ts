import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';

async function main() {
  const env = loadEnv();
  const db = createPool(env);
  const byStatus = await db.query(`
    SELECT s.internal_status,
           count(*)::int AS n,
           count(*) FILTER (
             WHERE (SELECT count(*) FROM tracking_events te WHERE te.shipment_id = s.id) = 0
           )::int AS no_events,
           count(*) FILTER (
             WHERE (SELECT count(*) FROM tracking_events te WHERE te.shipment_id = s.id) <= 1
           )::int AS le1_event,
           round(avg((SELECT count(*) FROM tracking_events te WHERE te.shipment_id = s.id))::numeric, 1) AS avg_events
    FROM shipments s
    WHERE s.source = 'klb'
    GROUP BY 1
    ORDER BY n DESC
  `);
  console.log('by status', byStatus.rows);
  const samples = await db.query(`
    SELECT s.tracking_number, s.internal_status,
      (SELECT count(*)::int FROM tracking_events te WHERE te.shipment_id = s.id) AS events,
      (SELECT te.description FROM tracking_events te WHERE te.shipment_id = s.id
         ORDER BY te.occurred_at DESC LIMIT 1) AS latest
    FROM shipments s
    WHERE s.source = 'klb'
    ORDER BY events ASC, s.created_at DESC
    LIMIT 10
  `);
  console.log('samples', samples.rows);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
