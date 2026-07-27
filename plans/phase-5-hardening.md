# Phase 5 — Hardening / analytics

Post-cutover hardening. Jobs can run during Phase 4 parallel run.

## Done

- [x] `retention.scrub` — 30d `api_call_log` delete, 30d `raw_payload` scrub, 24m notification/event cleanup, aged delivered anonymise, **90d `ingestion_runs` (+ cascade items)** (`npm run sync:retention`, worker daily)
- [x] `reconcile.daily` — open-without-tracking, stale empty timelines, unmapped status pairs (`npm run sync:reconcile`)
- [x] GDPR erasure — `POST /admin/privacy/erasure` (admin-only) + Data quality UI
- [x] Unmapped statuses list — `/data-quality` admin screen (+ **Map to…** → status editor)
- [x] Dashboard reconcile findings panel
- [x] Status-mapping **editor** — `GET/POST/PATCH/DELETE /admin/status-mappings` + `/status-mappings` admin UI
- [x] Delivery performance reports — `GET /admin/reports/delivery` + `/reports` admin UI

## Still open

- [ ] `api_call_log` partitioning if volume justifies
- [ ] Optional ShipBob webhooks
- [x] External uptime monitoring path — `/health` + `/health/ops` (wire monitor in ops; see cutover runbook)

## References

- `docs/dev-plan.md` §3.3, §5.5, §8 Phase 5
- `docs/ops/cutover-runbook.md`
