# Phase 4 cutover runbook

Operational checklist for parallel run → Narvar cutover. Code tooling is ready; this is the human path.

## Health probes (uptime)

| URL | Purpose | Expected |
| :--- | :--- | :--- |
| `GET /health` | Process up | `200 { ok: true }` |
| `GET /health/ready` | Postgres up | `200` / `503` |
| `GET /health/ops` | Critical sync jobs not lagging | `200` / `503` + job details |

Point an **external** monitor (UptimeRobot, Better Stack, Pingdom) at `/health` (liveness) and `/health/ops` (sync freshness). Internal-only checks cannot detect a dead VPS.

Critical jobs (503 when lag &gt; 2× schedule or recent failure):

- `shipbob.orders.sync`, `shipbob.tracking.poll` (every 20m → alert after 40m)
- `klb.sync` (20m → 40m)
- `trackingmore.poll` (15m → 30m)

Daily jobs (`stalled.detect`, `reconcile.daily`, `retention.scrub`) show on the admin Dashboard but do not fail `/health/ops`.

## Parallel run (keep Narvar on)

1. Deploy with real ShipBob / KLB / TrackingMore keys. Keep `KLAVIYO_DRY_RUN=true` until events look right.
2. Confirm worker schedules: ShipBob+KLB ~20m, TrackingMore ~15m.
3. Daily spot-check:
   ```bash
   npm run export:parallel-snapshot
   # If you have a Narvar CSV export:
   npm run diff:narvar -- --pfm exports/parallel-snapshot-….csv --narvar path/to/narvar.csv
   ```
4. Review admin **Dashboard** (ops health + reconcile) and **Data quality** (unmapped → **Map to…**).
5. Build Klaviyo flows on metrics `PFM Shipment *` pointing at `https://tracking.particleformen.com/t/{{token}}` (`PUBLIC_BASE_URL`) — do **not** disable Narvar emails yet.

## Cutover

1. Set `KLAVIYO_DRY_RUN=false` with a live `KLAVIYO_API_KEY`; confirm one real event in Klaviyo.
2. Switch transactional / flow tracking links to:
   - Token: `{PUBLIC_BASE_URL}/t/{token}`
   - Lookup: `{PUBLIC_BASE_URL}/lookup`
   - Legacy bridge: `{PUBLIC_BASE_URL}/go?order={order}&email={email}`
3. Turn **off** Narvar shipping notification flows (avoid duplicate emails).
4. Point RichPanel at `GET /api/richpanel/orders/:orderNumber` (`RICHPANEL_API_KEY`).
5. Install host redirect for old Narvar inbox links — see [`deploy/nginx-narvar-bridge.conf.example`](../deploy/nginx-narvar-bridge.conf.example).
6. Keep Narvar billed **one more period** as rollback.
7. Watch WISMO / RichPanel tickets for 1–2 weeks; use Dashboard + Reports.

## Rollback

1. Re-enable Narvar shipping flows.
2. Point Klaviyo links back to Narvar (or dual-send briefly).
3. Leave PFM polling running (harmless) so you can re-cutover quickly.

## References

- `plans/phase-4-parallel-cutover.md`
- `docs/dev-plan.md` §8 Phase 4, §9 NFRs
