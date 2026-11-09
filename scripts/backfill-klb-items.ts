/**
 * Backfill shipment_items for KLB orders from Zenventory customer-orders.
 * Safe to re-run — only shipments that still have zero items.
 *
 * Run: docker compose -f docker-compose.prod.yml --profile tools run --rm jobs scripts/backfill-klb-items.ts
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';
import { replaceShipmentItems } from '../api/src/domain/upsert.js';
import { KlbClient } from '../api/src/integrations/klb/client.js';

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.KLB_API_KEY || !env.KLB_API_SECRET) {
    throw new Error('KLB_API_KEY / KLB_API_SECRET required for customer-orders lookup');
  }

  const db = createPool(env);
  const onlyOrder = process.argv[2]?.trim() || null;
  const klb = new KlbClient({
    apiBase: env.KLB_API_BASE,
    legacySecureKey: env.KLB_LEGACY_API_SECRET ?? '',
    apiKey: env.KLB_API_KEY,
    apiSecret: env.KLB_API_SECRET,
    db,
  });

  try {
    const { rows } = await db.query<{ shipment_id: string; order_number: string }>(
      `SELECT s.id AS shipment_id, o.order_number
       FROM shipments s
       JOIN orders o ON o.id = s.order_id
       WHERE s.source = 'klb'
         AND NOT EXISTS (SELECT 1 FROM shipment_items si WHERE si.shipment_id = s.id)
         AND ($1::text IS NULL OR o.order_number = $1)
       ORDER BY o.created_at DESC, s.created_at DESC`,
      [onlyOrder],
    );

    console.log(`[backfill-klb-items] ${rows.length} shipments missing items`);

    const cache = new Map<string, Awaited<ReturnType<KlbClient['getCustomerOrder']>>>();
    let found = 0;
    let notFound = 0;
    let errors = 0;

    for (const [i, row] of rows.entries()) {
      try {
        let detail = cache.get(row.order_number);
        if (detail === undefined) {
          detail = await klb.getCustomerOrder(row.order_number);
          cache.set(row.order_number, detail);
        }
        if (detail?.items.length) {
          await replaceShipmentItems(db, row.shipment_id, detail.items);
          found += 1;
        } else {
          notFound += 1;
        }
      } catch (err) {
        errors += 1;
        console.error(`[backfill-klb-items] ${row.order_number}:`, err);
      }

      if ((i + 1) % 100 === 0) {
        console.log(`[backfill-klb-items] progress ${i + 1}/${rows.length}`);
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
