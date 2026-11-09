/**
 * Compare Narvar vs PFM Tracking Klaviyo metrics by order_number.
 *
 * Usage:
 *   npx tsx scripts/compare-klaviyo-narvar-pfm.ts --from 2026-07-31 --days 3
 *
 * Requires KLAVIYO_READ_API_KEY in .env (metrics:read + events:read).
 * Timezone for day buckets: Asia/Jerusalem (account-local).
 *
 * Writes exports/klaviyo-narvar-pfm-*.json and *.md
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../api/src/config.js';

const REVISION = '2024-10-15';
const API_BASE = 'https://a.klaviyo.com';
const TZ = 'Asia/Jerusalem';

/** Paired metrics (Narvar live flows ↔ PFM Tracking). */
const PAIRS: Array<{ key: string; narvarName: string; pfmName: string }> = [
  { key: 'in_transit', narvarName: 'Narvar - In Transit', pfmName: 'PFM Tracking - In Transit' },
  {
    key: 'out_for_delivery',
    narvarName: 'Narvar - Out for delivery',
    pfmName: 'PFM Tracking - Out For Delivery',
  },
  {
    key: 'delivered',
    narvarName: 'Narvar - Received delivery',
    pfmName: 'PFM Tracking - Received Delivery',
  },
  {
    key: 'failed_attempt',
    narvarName: 'Narvar - Failed delivery attempt',
    pfmName: 'PFM Tracking - Failed Delivery Attempt',
  },
  {
    key: 'exception',
    narvarName: 'Narvar - Delivery exception',
    pfmName: 'PFM Tracking - Delivery Exception',
  },
];

type EventRow = { datetime: string; email: string | null; order: string | null };

type DayDiff = {
  date: string;
  narvar: number;
  pfm: number;
  both: number;
  onlyNarvar: number;
  onlyPfm: number;
  onlyNarvarOrders: string[];
  onlyPfmOrders: string[];
};

type PairReport = {
  key: string;
  narvarName: string;
  pfmName: string;
  narvarMetricId: string;
  pfmMetricId: string;
  days: DayDiff[];
  window: {
    narvar: number;
    pfm: number;
    both: number;
    onlyNarvar: number;
    onlyPfm: number;
    onlyNarvarOrders: string[];
    onlyPfmOrders: string[];
  };
};

function parseArgs(argv: string[]) {
  let from = '2026-07-31';
  let days = 3;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') from = argv[++i]!;
    else if (argv[i] === '--days') days = Number(argv[++i]);
  }
  return { from, days };
}

function loadReadKey(): string {
  loadEnv();
  const key = process.env.KLAVIYO_READ_API_KEY?.trim();
  if (!key) throw new Error('KLAVIYO_READ_API_KEY missing in .env');
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normOrder(o: string | null | undefined): string | null {
  if (!o) return null;
  return o.replace(/^#/, '').trim().toLowerCase();
}

/** Israel calendar day YYYY-MM-DD → UTC [start, end) ISO strings. */
function israelDayBounds(dateYmd: string): { start: string; end: string } {
  // Asia/Jerusalem is UTC+3 in summer (IDT). Fixed offset is fine for Jul–Aug.
  const start = `${dateYmd}T00:00:00+03:00`;
  const [y, m, d] = dateYmd.split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  const ny = next.getUTCFullYear();
  const nm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const nd = String(next.getUTCDate()).padStart(2, '0');
  const end = `${ny}-${nm}-${nd}T00:00:00+03:00`;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

function addDays(dateYmd: string, n: number): string {
  const [y, m, d] = dateYmd.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

async function klaviyoGet(apiKey: string, url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        Accept: 'application/vnd.api+json',
        revision: REVISION,
      },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? 2) * 1000;
      await sleep(Math.max(wait, 1500));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GET ${url} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error(`Rate limited on ${url}`);
}

async function listMetrics(apiKey: string): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  let url: string | null = `${API_BASE}/api/metrics/`;
  while (url) {
    const body = (await klaviyoGet(apiKey, url)) as {
      data: Array<{ id: string; attributes: { name: string } }>;
      links?: { next?: string | null };
    };
    for (const m of body.data) byName.set(m.attributes.name, m.id);
    url = body.links?.next ?? null;
    await sleep(100);
  }
  return byName;
}

async function fetchEvents(
  apiKey: string,
  metricId: string,
  startIso: string,
  endIso: string,
): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  const filter = encodeURIComponent(
    `equals(metric_id,"${metricId}"),greater-or-equal(datetime,${startIso}),less-than(datetime,${endIso})`,
  );
  let url: string | null =
    `${API_BASE}/api/events/?filter=${filter}&sort=datetime` +
    `&fields[event]=datetime,event_properties&include=profile&fields[profile]=email`;

  while (url) {
    const body = (await klaviyoGet(apiKey, url)) as {
      data: Array<{
        attributes: { datetime: string; event_properties?: Record<string, unknown> };
        relationships?: { profile?: { data?: { id: string } } };
      }>;
      included?: Array<{ id: string; type: string; attributes?: { email?: string } }>;
      links?: { next?: string | null };
    };
    const profiles = new Map<string, string>();
    for (const inc of body.included ?? []) {
      if (inc.type === 'profile' && inc.attributes?.email) profiles.set(inc.id, inc.attributes.email);
    }
    for (const e of body.data) {
      const props = e.attributes.event_properties ?? {};
      const orderRaw =
        (props.order_number as string | undefined) ??
        (props.orderNumber as string | undefined) ??
        null;
      const profileId = e.relationships?.profile?.data?.id;
      rows.push({
        datetime: e.attributes.datetime,
        email: profileId ? (profiles.get(profileId) ?? null) : null,
        order: orderRaw,
      });
    }
    url = body.links?.next ?? null;
    await sleep(120);
  }
  return rows;
}

function ordersFrom(rows: EventRow[]): Map<string, EventRow> {
  const map = new Map<string, EventRow>();
  for (const r of rows) {
    const k = normOrder(r.order);
    if (!k) continue;
    if (!map.has(k)) map.set(k, r);
  }
  return map;
}

function diffMaps(a: Map<string, EventRow>, b: Map<string, EventRow>) {
  const both: string[] = [];
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const k of a.keys()) {
    if (b.has(k)) both.push(k);
    else onlyA.push(k);
  }
  for (const k of b.keys()) {
    if (!a.has(k)) onlyB.push(k);
  }
  return { both, onlyA, onlyB };
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function buildMarkdown(
  from: string,
  days: number,
  dates: string[],
  pairs: PairReport[],
): string {
  const lines: string[] = [];
  lines.push(`# Klaviyo Narvar vs PFM Tracking — event compare`);
  lines.push('');
  lines.push(`- Window: **${from}** + ${days} days (${dates.join(', ')})`);
  lines.push(`- Timezone: **${TZ}** (day buckets)`);
  lines.push(`- Join key: \`order_number\``);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`## Test plan`);
  lines.push('');
  lines.push(`1. Pull all events for each Narvar ↔ PFM metric pair on each calendar day.`);
  lines.push(`2. Same-day join on \`order_number\` (unique per side).`);
  lines.push(`3. Window join across the full ${days}-day range (catches poll lag).`);
  lines.push(`4. Leftovers after the window are true gaps (channel / suppressed / missing).`);
  lines.push('');
  lines.push(`## Summary by metric (full window)`);
  lines.push('');
  lines.push(`| Event | Narvar | PFM | Both | Only Narvar | Only PFM | Overlap % |`);
  lines.push(`| :--- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const p of pairs) {
    const denom = Math.max(p.window.narvar, p.window.pfm, 1);
    const pct = ((p.window.both / denom) * 100).toFixed(1);
    lines.push(
      `| ${p.key} | ${p.window.narvar} | ${p.window.pfm} | ${p.window.both} | ${p.window.onlyNarvar} | ${p.window.onlyPfm} | ${pct}% |`,
    );
  }
  lines.push('');

  for (const p of pairs) {
    lines.push(`## ${p.narvarName} ↔ ${p.pfmName}`);
    lines.push('');
    lines.push(`| Date | Narvar | PFM | Both | Only Narvar | Only PFM |`);
    lines.push(`| :--- | ---: | ---: | ---: | ---: | ---: |`);
    for (const d of p.days) {
      lines.push(
        `| ${d.date} | ${d.narvar} | ${d.pfm} | ${d.both} | ${d.onlyNarvar} | ${d.onlyPfm} |`,
      );
    }
    lines.push('');
    lines.push(
      `**Window leftovers** — only Narvar: ${p.window.onlyNarvar}, only PFM: ${p.window.onlyPfm}`,
    );
    if (p.window.onlyNarvarOrders.length) {
      lines.push('');
      lines.push(`Only Narvar (sample ≤30): ${p.window.onlyNarvarOrders.slice(0, 30).map(mdEscape).join(', ')}`);
    }
    if (p.window.onlyPfmOrders.length) {
      lines.push('');
      lines.push(`Only PFM (sample ≤30): ${p.window.onlyPfmOrders.slice(0, 30).map(mdEscape).join(', ')}`);
    }
    lines.push('');
  }

  lines.push(`## How to re-run`);
  lines.push('');
  lines.push('```bash');
  lines.push(`npx tsx scripts/compare-klaviyo-narvar-pfm.ts --from ${from} --days ${days}`);
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { from, days } = parseArgs(process.argv.slice(2));
  const apiKey = loadReadKey();
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const windowStart = israelDayBounds(dates[0]!).start;
  const windowEnd = israelDayBounds(dates[dates.length - 1]!).end;

  console.log(`Comparing ${dates.join(', ')} (${TZ})`);
  console.log('Listing metrics…');
  const metrics = await listMetrics(apiKey);

  const reports: PairReport[] = [];

  for (const pair of PAIRS) {
    const nid = metrics.get(pair.narvarName);
    const pid = metrics.get(pair.pfmName);
    if (!nid || !pid) {
      throw new Error(
        `Missing metric id for ${pair.narvarName}=${nid ?? '?'} / ${pair.pfmName}=${pid ?? '?'}`,
      );
    }
    console.log(`\n=== ${pair.key} ===`);

    const dayDiffs: DayDiff[] = [];
    const narvarWindow = new Map<string, EventRow>();
    const pfmWindow = new Map<string, EventRow>();

    for (const date of dates) {
      const { start, end } = israelDayBounds(date);
      console.log(`  ${date}: fetching Narvar…`);
      const nRows = await fetchEvents(apiKey, nid, start, end);
      console.log(`  ${date}: fetching PFM…`);
      const pRows = await fetchEvents(apiKey, pid, start, end);
      const nMap = ordersFrom(nRows);
      const pMap = ordersFrom(pRows);
      for (const [k, v] of nMap) if (!narvarWindow.has(k)) narvarWindow.set(k, v);
      for (const [k, v] of pMap) if (!pfmWindow.has(k)) pfmWindow.set(k, v);
      const d = diffMaps(nMap, pMap);
      const day: DayDiff = {
        date,
        narvar: nMap.size,
        pfm: pMap.size,
        both: d.both.length,
        onlyNarvar: d.onlyA.length,
        onlyPfm: d.onlyB.length,
        onlyNarvarOrders: d.onlyA.sort(),
        onlyPfmOrders: d.onlyB.sort(),
      };
      dayDiffs.push(day);
      console.log(
        `  ${date}: N=${day.narvar} P=${day.pfm} both=${day.both} onlyN=${day.onlyNarvar} onlyP=${day.onlyPfm}`,
      );
    }

    const w = diffMaps(narvarWindow, pfmWindow);
    reports.push({
      key: pair.key,
      narvarName: pair.narvarName,
      pfmName: pair.pfmName,
      narvarMetricId: nid,
      pfmMetricId: pid,
      days: dayDiffs,
      window: {
        narvar: narvarWindow.size,
        pfm: pfmWindow.size,
        both: w.both.length,
        onlyNarvar: w.onlyA.length,
        onlyPfm: w.onlyB.length,
        onlyNarvarOrders: w.onlyA.sort(),
        onlyPfmOrders: w.onlyB.sort(),
      },
    });
    console.log(
      `  WINDOW: N=${narvarWindow.size} P=${pfmWindow.size} both=${w.both.length} onlyN=${w.onlyA.length} onlyP=${w.onlyB.length}`,
    );
  }

  const payload = {
    from,
    days,
    dates,
    timezone: TZ,
    windowStart,
    windowEnd,
    generatedAt: new Date().toISOString(),
    pairs: reports,
  };

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = path.join(root, 'exports');
  await mkdir(outDir, { recursive: true });
  const stamp = `${from}_${days}d`;
  const jsonPath = path.join(outDir, `klaviyo-narvar-pfm-${stamp}.json`);
  const mdPath = path.join(outDir, `klaviyo-narvar-pfm-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  await writeFile(mdPath, buildMarkdown(from, days, dates, reports), 'utf8');
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
