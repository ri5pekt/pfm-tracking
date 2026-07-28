/**
 * Import Particle product catalog from products.json, download images locally,
 * upsert into `products` (+ optional sku aliases).
 *
 * Usage:
 *   npm run sync:products
 *   PRODUCTS_JSON_PATH="C:/path/to/products.json" npm run sync:products
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imagesDir = path.join(repoRoot, 'api', 'public', 'products');
const aliasesPath = path.join(repoRoot, 'api', 'catalog', 'sku-aliases.json');
const packagingPath = path.join(repoRoot, 'api', 'catalog', 'packaging-skus.json');
const manualPath = path.join(repoRoot, 'api', 'catalog', 'manual-products.json');
const detailsPath = path.join(repoRoot, 'api', 'catalog', 'product-details.json');
const manifestPath = path.join(repoRoot, 'api', 'catalog', 'products-manifest.json');

const DEFAULT_JSON =
  process.env.PRODUCTS_JSON_PATH ||
  path.join(
    'C:',
    'Users',
    'denis_particleformen',
    'Desktop',
    'Cursor Projects',
    'particle-shopify',
    'data',
    'products.json',
  );

type SourceProduct = {
  id?: number | string;
  title: string;
  sku: string;
  short_description?: string;
  card_image_url?: string;
  featured_image_url?: string;
};

type ProductDetailsFile = {
  products?: Record<string, { description?: string | null; product_url?: string | null }>;
};

function safeSkuFile(sku: string, ext: string): string {
  const base = sku.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  return `${base || 'sku'}${ext}`;
}

function extFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i);
    if (m) return `.${m[1]!.toLowerCase().replace('jpeg', 'jpg')}`;
  } catch {
    /* ignore */
  }
  return '.jpg';
}

function flattenCatalog(raw: unknown): SourceProduct[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: SourceProduct[] = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const p = item as SourceProduct;
      if (!p.sku || !p.title) continue;
      out.push(p);
    }
  }
  return out;
}

async function downloadImage(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'pfm-tracking-product-sync/1.0' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`download ${res.status} ${url}`);
  }
  const { Readable } = await import('node:stream');
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
}

async function main(): Promise<void> {
  const jsonPath = DEFAULT_JSON;
  console.log(`=== products.sync from ${jsonPath} ===`);
  const raw = JSON.parse(await readFile(jsonPath, 'utf8')) as unknown;
  const products = flattenCatalog(raw);
  console.log(`catalog products: ${products.length}`);

  await mkdir(imagesDir, { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });

  const env = loadEnv();
  const db = createPool(env);
  const manifest: Array<{
    sku: string;
    title: string;
    imageFile: string;
    imagePath: string;
  }> = [];

  let detailsFile: ProductDetailsFile = {};
  try {
    detailsFile = JSON.parse(await readFile(detailsPath, 'utf8')) as ProductDetailsFile;
  } catch {
    /* optional */
  }
  const details = detailsFile.products ?? {};

  let ok = 0;
  let failed = 0;

  for (const p of products) {
    const imageUrl = p.featured_image_url || p.card_image_url;
    if (!imageUrl) {
      console.warn(`[skip] ${p.sku}: no image url`);
      failed += 1;
      continue;
    }
    const ext = extFromUrl(imageUrl);
    const file = safeSkuFile(String(p.sku), ext);
    const dest = path.join(imagesDir, file);
    const publicPath = `/products/${file}`;
    const sku = String(p.sku);
    const d = details[sku] ?? {};
    const description =
      (p.short_description || '').replace(/\r\n/g, ' ').trim() || d.description || null;
    const productUrl = d.product_url ?? null;

    try {
      await downloadImage(imageUrl, dest);
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
        [sku, p.title.trim(), publicPath, description, productUrl],
      );
      manifest.push({
        sku,
        title: p.title.trim(),
        imageFile: file,
        imagePath: publicPath,
      });
      ok += 1;
      console.log(`[ok] ${p.sku} → ${file}`);
    } catch (err) {
      failed += 1;
      console.warn(`[fail] ${p.sku}:`, err instanceof Error ? err.message : err);
    }
  }

  // Aliases (warehouse SKUs → catalog sku)
  let aliasFile: { aliases?: Record<string, string> } = {};
  try {
    aliasFile = JSON.parse(await readFile(aliasesPath, 'utf8')) as {
      aliases?: Record<string, string>;
    };
  } catch {
    /* optional */
  }

  let aliasesUpserted = 0;
  for (const [alias, productSku] of Object.entries(aliasFile.aliases ?? {})) {
    if (!alias || !productSku || alias.startsWith('_')) continue;
    const exists = await db.query(`SELECT 1 FROM products WHERE sku = $1`, [productSku]);
    if (!exists.rowCount) {
      console.warn(`[alias skip] ${alias} → ${productSku} (product missing)`);
      continue;
    }
    await db.query(
      `INSERT INTO product_sku_aliases (alias_sku, product_sku)
       VALUES ($1, $2)
       ON CONFLICT (alias_sku) DO UPDATE SET product_sku = EXCLUDED.product_sku`,
      [alias, productSku],
    );
    aliasesUpserted += 1;
  }

  // Packaging / inserts (ShipBob warehouse SKUs — not sellable catalog)
  let packagingFile: { packaging?: Record<string, string> } = {};
  try {
    packagingFile = JSON.parse(await readFile(packagingPath, 'utf8')) as {
      packaging?: Record<string, string>;
    };
  } catch {
    /* optional */
  }
  let packagingUpserted = 0;
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
    packagingUpserted += 1;
  }

  // Manual SKUs (samples/vials not in products.json) — images already under public/products
  let manualFile: {
    products?: Array<{ sku: string; title: string; imageFile?: string }>;
  } = {};
  try {
    manualFile = JSON.parse(await readFile(manualPath, 'utf8')) as typeof manualFile;
  } catch {
    /* optional */
  }
  let manualUpserted = 0;
  for (const item of manualFile.products ?? []) {
    if (!item?.sku || !item?.title) continue;
    const file = item.imageFile || safeSkuFile(item.sku, '.jpg');
    const publicPath = `/products/${file}`;
    await db.query(
      `INSERT INTO products (sku, title, image_url, source, updated_at)
       VALUES ($1, $2, $3, 'manual', now())
       ON CONFLICT (sku) DO UPDATE SET
         title = EXCLUDED.title,
         image_url = EXCLUDED.image_url,
         source = 'manual',
         updated_at = now()`,
      [String(item.sku), item.title.trim(), publicPath],
    );
    manifest.push({
      sku: String(item.sku),
      title: item.title.trim(),
      imageFile: file,
      imagePath: publicPath,
    });
    manualUpserted += 1;
    console.log(`[manual] ${item.sku} → ${file}`);
  }

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log({
    ok,
    failed,
    aliasesUpserted,
    packagingUpserted,
    manualUpserted,
    imagesDir,
    manifestPath,
  });
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
