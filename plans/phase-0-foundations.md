# Phase 0 — Foundations (week 1)

Exit criterion from `docs/dev-plan.md`:  
`docker compose up` runs API + worker + DB; can log into empty admin and invite a second user.

## Checklist

### Scaffold
- [ ] Monorepo folders: `api/`, `worker/`, `admin/` (optional `web/`)
- [ ] Root `package.json` workspaces (or separate packages) + shared TypeScript config
- [ ] `docker-compose.yml`: Postgres 16, Redis, api, worker, admin
- [ ] `.env` from `.env.example` (local only)

### Schema (see `docs/dev-plan.md` §3.2)
- [ ] Migrations: `orders`, `shipments`, `shipment_items`, `tracking_events`
- [ ] `carriers`, `status_mappings` (+ seed from §13 live codes)
- [ ] `notification_log`, `ingestion_runs`, `sync_cursors`
- [ ] `admin_users`, `admin_invites`, `admin_audit_log`
- [ ] `data_erasure_requests`, lightweight `api_call_log`
- [ ] `products`

### Status seed (minimum)
Map Tracking API → internal:

| raw_status | internal_status | rank |
| :--- | :--- | ---: |
| PreTransit | LABEL_CREATED | 30 |
| InTransit | IN_TRANSIT | 40 |
| OutForDelivery | OUT_FOR_DELIVERY | 50 |
| AvailableForPickup | OUT_FOR_DELIVERY | 50 |
| DeliveryAttemptFailed | EXCEPTION | 55 |
| DeliveryException | EXCEPTION | 55 |
| Exception | EXCEPTION | 55 |
| Delivered | DELIVERED | 90 |

### Admin auth
- [ ] Login (email + password), no self-signup
- [ ] Invite flow + roles (`admin` / `staff`)
- [ ] Audit log on user actions
- [ ] `GET /admin/version` with build-time GIT_SHA / APP_VERSION
- [ ] Shell layout stub matching UI reference (sidebar + empty shipments list) — see `docs/ui-references/`

### Infra hygiene
- [ ] Wrapped HTTP client stub (redact Authorization)
- [ ] CI stub: test → build images tagged with git SHA
- [ ] Confirm `HasTracking` / `IsTrackingUploaded` on current PAT (informational only)

## Out of scope for Phase 0
- Live ShipBob poll (Phase 1)
- Customer tracking page UI polish (Phase 1)
- KLB / TrackingMore / Klaviyo (Phases 2–3)

## Next after Phase 0 exit
Open [`plans/phase-1-shipbob-mvp.md`](phase-1-shipbob-mvp.md).
