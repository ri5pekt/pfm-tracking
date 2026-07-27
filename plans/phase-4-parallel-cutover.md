# Phase 4 — Parallel run + cutover

Exit criterion: Narvar no longer customer-facing; WISMO stable on PFM Tracking.

## Code / ops tooling (done)

- [x] Admin **Dashboard** — sync cursors, recent `ingestion_runs`, shipment counts, notification totals
- [x] Klaviyo Events API client (live when `KLAVIYO_DRY_RUN=false` + `KLAVIYO_API_KEY`)
- [x] Audited notification **Replay** on shipment slide-over
- [x] RichPanel read API (Phase 3)
- [x] Parallel-run CSV snapshot — `npm run export:parallel-snapshot`
- [x] Narvar CSV diff helper — `npm run diff:narvar -- --pfm … --narvar …`
- [x] Legacy bridge redirect — `GET /go?order=&email=` (or `postcode`) → `/t/:token`
- [x] Reconcile + unmapped status screen (supports daily spot-checks)
- [x] Ops health probes — `/health`, `/health/ready`, `/health/ops` (job lag > 2× schedule)
- [x] Dashboard job-lag alerts panel
- [x] Cutover runbook + Nginx Narvar-bridge example — `docs/ops/cutover-runbook.md`, `deploy/nginx-narvar-bridge.conf.example`

## Still deferred

- [ ] Automated Narvar↔PFM auto-diff without a Narvar CSV (needs Narvar export/API access)
- [ ] Live host rewrite once tracking domain is confirmed (template ready under `deploy/`)

## Parallel run checklist (ops)

- [ ] Run ShipBob + KLB sync on production cadence alongside Narvar
- [ ] Daily spot-check: sample orders vs Narvar (`export:parallel-snapshot` + optional `diff:narvar`)
- [ ] Point new Klaviyo flows at PFM metrics (`PFM Shipment *`) and tracking URLs
- [ ] Keep Narvar emails on until PFM events match volume/quality
- [ ] Document mismatches via Data quality / Dashboard reconcile
- [ ] External uptime on `/health` + `/health/ops`

## Cutover checklist (ops)

- [ ] Switch Klaviyo / transactional links to `PUBLIC_BASE_URL/t/:token` (and `/lookup` or `/go`)
- [ ] Turn off Narvar shipping notification flows (avoid duplicate emails)
- [ ] Map old Narvar inbox links → `/go?order=&email=` (or host redirect) once domain confirmed
- [ ] Keep Narvar billed one period as rollback
- [ ] Confirm RichPanel uses `/api/richpanel/orders/:orderNumber`

## References

- `docs/ops/cutover-runbook.md`
- `docs/dev-plan.md` §8 Phase 4
- `plans/phase-3-notifications-richpanel.md`
- `plans/phase-5-hardening.md`
