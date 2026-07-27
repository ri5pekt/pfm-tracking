/**
 * Seed sync cursors to "now" so the next ShipBob orders sync only picks up
 * new orders (plus a small overlap). Does not insert any orders/shipments.
 *
 *   npx tsx scripts/seed-fresh-cursors.ts
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';

const JOBS = ['shipbob.orders.sync'] as const;

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env);
  const now = new Date();

  for (const job of JOBS) {
    await db.query(
      `INSERT INTO sync_cursors (job_name, cursor_at, last_success_at, updated_at)
       VALUES ($1, $2, $2, now())
       ON CONFLICT (job_name) DO UPDATE SET
         cursor_at = EXCLUDED.cursor_at,
         last_success_at = EXCLUDED.last_success_at,
         updated_at = now()`,
      [job, now],
    );
    console.log(`[cursor] ${job} → ${now.toISOString()}`);
  }

  console.log('KLB uses KLB_WINDOW_DAYS (set to 0/1 on prod) — no cursor seed needed.');
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
