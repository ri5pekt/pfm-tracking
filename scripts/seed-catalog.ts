/**
 * Seed catalog (products + packaging + manual SKUs) — no orders/shipments.
 * Uses api/catalog manifests already in the repo (images under api/public/products).
 *
 *   npx tsx scripts/seed-catalog.ts
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env);

  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, 'api/catalog/products-manifest.json'), 'utf8'),
  ) as Array<{ sku: string; title: string; imagePath: string }>;

  let detailsFile: {
    products?: Record<string, { description?: string | null; product_url?: string | null }>;
  } = {};
  try {
    detailsFile = JSON.parse(
      await readFile(path.join(repoRoot, 'api/catalog/product-details.json'), 'utf8'),
    ) as typeof detailsFile;
  } catch {
    /* optional */
  }
  const details = detailsFile.products ?? {};

  let products = 0;
  for (const p of manifest) {
    if (!p.sku || !p.title) continue;
    const d = details[p.sku] ?? {};
    await db.query(
      `INSERT INTO products (sku, title, image_url, description, product_url, source, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'shopify_catalog', now())
       ON CONFLICT (sku) DO UPDATE SET
         title = EXCLUDED.title,
         image_url = EXCLUDED.image_url,
         description = COALESCE(EXCLUDED.description, products.description),
         product_url = COALESCE(EXCLUDED.product_url, products.product_url),
         source = EXCLUDED.source,
         updated_at = now()`,
      [p.sku, p.title, p.imagePath, d.description ?? null, d.product_url ?? null],
    );
    products += 1;
  }

  // Apply details to any SKU already in DB (e.g. manual) even if not in manifest
  let detailsApplied = 0;
  for (const [sku, d] of Object.entries(details)) {
    if (!sku || sku.startsWith('_')) continue;
    const result = await db.query(
      `UPDATE products
       SET description = COALESCE($2, description),
           product_url = COALESCE($3, product_url),
           updated_at = now()
       WHERE sku = $1`,
      [sku, d.description ?? null, d.product_url ?? null],
    );
    detailsApplied += result.rowCount ?? 0;
  }

  let packaging = 0;
  try {
    const packagingFile = JSON.parse(
      await readFile(path.join(repoRoot, 'api/catalog/packaging-skus.json'), 'utf8'),
    ) as { packaging?: Record<string, string> };
    for (const [sku, title] of Object.entries(packagingFile.packaging ?? {})) {
      if (!sku || !title || sku.startsWith('_')) continue;
      await db.query(
        `INSERT INTO products (sku, title, image_url, source, updated_at)
         VALUES ($1, $2, NULL, 'packaging', now())
         ON CONFLICT (sku) DO UPDATE SET
           title = EXCLUDED.title,
           source = 'packaging',
           updated_at = now()`,
        [sku, title],
      );
      packaging += 1;
    }
  } catch {
    /* optional */
  }

  let manual = 0;
  try {
    const manualFile = JSON.parse(
      await readFile(path.join(repoRoot, 'api/catalog/manual-products.json'), 'utf8'),
    ) as { products?: Array<{ sku: string; title: string; imageFile?: string }> };
    for (const item of manualFile.products ?? []) {
      if (!item?.sku || !item?.title) continue;
      const publicPath = `/products/${item.imageFile || `${item.sku}.jpg`}`;
      await db.query(
        `INSERT INTO products (sku, title, image_url, source, updated_at)
         VALUES ($1, $2, $3, 'manual', now())
         ON CONFLICT (sku) DO UPDATE SET
           title = EXCLUDED.title,
           image_url = EXCLUDED.image_url,
           source = 'manual',
           updated_at = now()`,
        [item.sku, item.title, publicPath],
      );
      manual += 1;
    }
  } catch {
    /* optional */
  }

  console.log({ products, packaging, manual, detailsApplied });
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
