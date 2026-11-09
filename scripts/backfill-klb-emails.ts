/**
 * One-time backfill: fill customer_email for existing KLB orders via Zenventory's
 * customer-orders REST API (separate resource from shippingorders — see
 * plans/klb-customer-email-backfill.md). Safe to re-run — only touches rows still NULL.
 *
 * Run: docker compose -f docker-compose.prod.yml run --rm jobs scripts/backfill-klb-emails.ts
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';
import { KlbClient } from '../api/src/integrations/klb/client.js';

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.KLB_API_KEY || !env.KLB_API_SECRET) {
    throw new Error('KLB_API_KEY / KLB_API_SECRET required for customer-orders lookup');
  }

  const db = createPool(env);
  const klb = new KlbClient({
    apiBase: env.KLB_API_BASE,
    legacySecureKey: env.KLB_LEGACY_API_SECRET ?? '',
    apiKey: env.KLB_API_KEY,
    apiSecret: env.KLB_API_SECRET,
    db,
  });

  try {
    const { rows } = await db.query<{ id: string; order_number: string }>(
      `SELECT DISTINCT o.id, o.order_number
       FROM orders o
       JOIN shipments s ON s.order_id = o.id
       WHERE s.source = 'klb' AND o.customer_email IS NULL
       ORDER BY o.order_number`,
    );

    console.log(`[backfill-klb-emails] ${rows.length} orders missing email`);

    let found = 0;
    let notFound = 0;
    let errors = 0;

    for (const [i, row] of rows.entries()) {
      try {
        const email = await klb.getCustomerOrderEmail(row.order_number);
        if (email) {
          await db.query(
            `UPDATE orders SET customer_email = COALESCE(customer_email, $2), updated_at = now()
             WHERE id = $1 AND customer_email IS NULL`,
            [row.id, email],
          );
          found += 1;
        } else {
          notFound += 1;
        }
      } catch (err) {
        errors += 1;
        console.error(`[backfill-klb-emails] ${row.order_number}:`, err);
      }

      if ((i + 1) % 100 === 0) {
        console.log(`[backfill-klb-emails] progress ${i + 1}/${rows.length}`);
      }
    }

    console.log({ total: rows.length, found, notFound, errors });
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
