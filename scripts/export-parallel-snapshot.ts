/**
 * Export a parallel-run snapshot CSV for spot-checking vs Narvar.
 * Run: npm run export:parallel-snapshot
 *
 * Columns are stable so you can join/diff against a Narvar export by order #.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env);
  const limit = Number(process.env.EXPORT_LIMIT ?? 500);

  const { rows } = await db.query<{
    order_number: string;
    source: string;
    tracking_number: string | null;
    carrier_code: string | null;
    carrier_name: string | null;
    internal_status: string;
    is_stalled: boolean;
    edd: Date | null;
    last_event_at: Date | null;
    latest_description: string | null;
    latest_location: string | null;
    destination_country: string | null;
    shipped_at: Date | null;
    delivered_at: Date | null;
  }>(
    `SELECT o.order_number, s.source, s.tracking_number, s.carrier_code,
            c.display_name AS carrier_name, s.internal_status, s.is_stalled,
            s.edd, s.last_event_at, s.shipped_at, s.delivered_at,
            o.destination_country,
            (
              SELECT te.description FROM tracking_events te
              WHERE te.shipment_id = s.id
              ORDER BY te.occurred_at DESC, te.status_rank DESC, te.id DESC
              LIMIT 1
            ) AS latest_description,
            (
              SELECT te.location FROM tracking_events te
              WHERE te.shipment_id = s.id
              ORDER BY te.occurred_at DESC, te.status_rank DESC, te.id DESC
              LIMIT 1
            ) AS latest_location
     FROM shipments s
     JOIN orders o ON o.id = s.order_id
     LEFT JOIN carriers c ON c.code = s.carrier_code
     ORDER BY s.updated_at DESC
     LIMIT $1`,
    [limit],
  );

  const header = [
    'order_number',
    'source',
    'tracking_number',
    'carrier_code',
    'carrier_name',
    'internal_status',
    'is_stalled',
    'edd',
    'last_event_at',
    'latest_description',
    'latest_location',
    'destination_country',
    'shipped_at',
    'delivered_at',
  ];

  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.order_number,
        r.source,
        r.tracking_number,
        r.carrier_code,
        r.carrier_name,
        r.internal_status,
        r.is_stalled,
        r.edd?.toISOString() ?? '',
        r.last_event_at?.toISOString() ?? '',
        r.latest_description,
        r.latest_location,
        r.destination_country,
        r.shipped_at?.toISOString() ?? '',
        r.delivered_at?.toISOString() ?? '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }

  const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../exports');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `parallel-snapshot-${stamp}.csv`);
  await writeFile(outPath, lines.join('\n'), 'utf8');
  console.log(`Wrote ${rows.length} rows → ${outPath}`);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
