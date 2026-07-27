/**
 * Diff a PFM parallel-run snapshot against a Narvar CSV export.
 *
 * Usage:
 *   npm run diff:narvar -- --pfm exports/parallel-snapshot-….csv --narvar path/to/narvar.csv
 *
 * Narvar CSV must include an order-number column (order_number | order | order#)
 * and preferably a status column (status | shipment_status | current_status).
 * Tracking column optional (tracking | tracking_number | tracking#).
 *
 * Exit code 1 if any status mismatches (for CI / cron spot-checks).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

type Row = Record<string, string>;

function parseArgs(argv: string[]) {
  const out: { pfm?: string; narvar?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pfm') out.pfm = argv[++i];
    else if (a === '--narvar') out.narvar = argv[++i];
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

/** Minimal CSV parser (handles quoted fields). */
function parseCsv(text: string): Row[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Row = {};
    headers.forEach((h, i) => {
      row[h] = (cells[i] ?? '').trim();
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function pick(row: Row, candidates: string[]): string {
  for (const c of candidates) {
    const v = row[c];
    if (v) return v;
  }
  // fuzzy: any key containing
  for (const [k, v] of Object.entries(row)) {
    if (candidates.some((c) => k.includes(c.replace(/_/g, ''))) && v) return v;
  }
  return '';
}

function normStatus(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const map: Record<string, string> = {
    delivered: 'DELIVERED',
    delivery: 'DELIVERED',
    in_transit: 'IN_TRANSIT',
    intransit: 'IN_TRANSIT',
    transit: 'IN_TRANSIT',
    shipped: 'IN_TRANSIT',
    out_for_delivery: 'OUT_FOR_DELIVERY',
    outfordelivery: 'OUT_FOR_DELIVERY',
    ofd: 'OUT_FOR_DELIVERY',
    exception: 'EXCEPTION',
    delayed: 'EXCEPTION',
    failed_attempt: 'EXCEPTION',
    delivery_attempt_failed: 'EXCEPTION',
    returned: 'RETURNED_TO_SENDER',
    returned_to_sender: 'RETURNED_TO_SENDER',
    cancelled: 'CANCELLED',
    canceled: 'CANCELLED',
    label_created: 'LABEL_CREATED',
    pre_transit: 'LABEL_CREATED',
    pending: 'LABEL_CREATED',
    processing: 'PROCESSING',
    order_received: 'ORDER_RECEIVED',
  };
  if (map[s]) return map[s]!;
  const upper = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return upper || '';
}

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pfm || !args.narvar) {
    console.error(
      'Usage: npm run diff:narvar -- --pfm exports/parallel-snapshot-….csv --narvar narvar.csv [--out exports/diff.csv]',
    );
    process.exit(2);
  }

  const pfmRows = parseCsv(await readFile(args.pfm, 'utf8'));
  const narvarRows = parseCsv(await readFile(args.narvar, 'utf8'));

  const pfmByOrder = new Map<string, Row>();
  for (const row of pfmRows) {
    const order = pick(row, ['order_number', 'order', 'order#', 'ordernumber']);
    if (order) pfmByOrder.set(order.toLowerCase(), row);
  }

  const narvarByOrder = new Map<string, Row>();
  for (const row of narvarRows) {
    const order = pick(row, ['order_number', 'order', 'order#', 'ordernumber', 'order_id']);
    if (order) narvarByOrder.set(order.toLowerCase(), row);
  }

  type Diff = {
    order_number: string;
    kind: 'status_mismatch' | 'tracking_mismatch' | 'missing_in_pfm' | 'missing_in_narvar';
    pfm_status: string;
    narvar_status: string;
    pfm_tracking: string;
    narvar_tracking: string;
  };
  const diffs: Diff[] = [];

  for (const [order, nRow] of narvarByOrder) {
    const pRow = pfmByOrder.get(order);
    const nStatus = normStatus(
      pick(nRow, ['status', 'shipment_status', 'current_status', 'delivery_status', 'internal_status']),
    );
    const nTrack = pick(nRow, ['tracking_number', 'tracking', 'tracking#', 'tracking_no']);
    if (!pRow) {
      diffs.push({
        order_number: order,
        kind: 'missing_in_pfm',
        pfm_status: '',
        narvar_status: nStatus,
        pfm_tracking: '',
        narvar_tracking: nTrack,
      });
      continue;
    }
    const pStatus = normStatus(pick(pRow, ['internal_status', 'status']));
    const pTrack = pick(pRow, ['tracking_number', 'tracking']);
    if (nStatus && pStatus && nStatus !== pStatus) {
      diffs.push({
        order_number: order,
        kind: 'status_mismatch',
        pfm_status: pStatus,
        narvar_status: nStatus,
        pfm_tracking: pTrack,
        narvar_tracking: nTrack,
      });
    } else if (nTrack && pTrack && nTrack.toLowerCase() !== pTrack.toLowerCase()) {
      diffs.push({
        order_number: order,
        kind: 'tracking_mismatch',
        pfm_status: pStatus,
        narvar_status: nStatus,
        pfm_tracking: pTrack,
        narvar_tracking: nTrack,
      });
    }
  }

  for (const [order, pRow] of pfmByOrder) {
    if (narvarByOrder.has(order)) continue;
    diffs.push({
      order_number: order,
      kind: 'missing_in_narvar',
      pfm_status: normStatus(pick(pRow, ['internal_status', 'status'])),
      narvar_status: '',
      pfm_tracking: pick(pRow, ['tracking_number', 'tracking']),
      narvar_tracking: '',
    });
  }

  const summary = {
    pfmRows: pfmRows.length,
    narvarRows: narvarRows.length,
    matchedOrders: [...pfmByOrder.keys()].filter((o) => narvarByOrder.has(o)).length,
    statusMismatch: diffs.filter((d) => d.kind === 'status_mismatch').length,
    trackingMismatch: diffs.filter((d) => d.kind === 'tracking_mismatch').length,
    missingInPfm: diffs.filter((d) => d.kind === 'missing_in_pfm').length,
    missingInNarvar: diffs.filter((d) => d.kind === 'missing_in_narvar').length,
  };
  console.log(summary);

  const outPath =
    args.out ??
    path.join('exports', `narvar-diff-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  await mkdir(path.dirname(outPath), { recursive: true });
  const header = [
    'order_number',
    'kind',
    'pfm_status',
    'narvar_status',
    'pfm_tracking',
    'narvar_tracking',
  ];
  const body = [
    header.join(','),
    ...diffs.map((d) => header.map((h) => csvEscape(d[h as keyof Diff])).join(',')),
  ].join('\n');
  await writeFile(outPath, body, 'utf8');
  console.log(`Wrote ${diffs.length} diffs → ${outPath}`);

  if (summary.statusMismatch > 0 || summary.trackingMismatch > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
