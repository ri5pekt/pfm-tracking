# AGENTS.md — PFM Tracking Platform

You are implementing Particle For Men's in-house order tracking platform (Narvar replacement).

## Read first (in order)

1. [`docs/dev-plan.md`](docs/dev-plan.md) — **canonical build plan (v3)**
2. [`plans/phase-0-foundations.md`](plans/phase-0-foundations.md) — immediate work
3. [`docs/order-tracking-platform-brief.md`](docs/order-tracking-platform-brief.md) — business requirements
4. [`docs/research/shipbob-tracking-api-beta.md`](docs/research/shipbob-tracking-api-beta.md) — ShipBob Tracking API (unlocked)
5. [`examples/shipbob/`](examples/shipbob/) — real response shapes

Do **not** invent a different architecture. Locked decisions are in `docs/dev-plan.md` §1.

## Locked architecture (do not reopen)

- Separate Node.js service — **not** a WooCommerce plugin
- **No WooCommerce** on the runtime order path (ShipBob + KLB only)
- ShipBob carrier data: **`GET /2026-07/shipments-tracking`** (batch), not the old `/timeline` (404s)
- KLB carrier data: **TrackingMore**
- Polling only (15–30 min) in v1 — no webhooks
- Klaviyo receives events; Klaviyo sends emails
- Postgres + Redis/BullMQ + Docker + Vue admin

## Critical ShipBob gotchas

1. **Batch query format:** use repeated params  
   `ShipmentIds=1&ShipmentIds=2` — **not** `ShipmentIds=1,2` (returns 400).
2. Auth: `Authorization: Bearer <SHIPBOB_API_KEY>`. Tracking API does not need `shipbob_channel_id`; order list does (channel `180705`).
3. Old `/shipment/{id}/timeline` returns **404** — do not build against it.
4. A PAT that works for `/order` may still **401** on Tracking API if scopes/entitlement differ — retest both after any key rotation.
5. Rate limit ~150 req/min; watch `X-Remaining-Calls` / `x-retry-after`. Batching ≤25 keeps us well under budget.

## Phase order

| Phase | Goal |
| :--- | :--- |
| 0 | Scaffold, schema, admin auth, Docker Compose |
| 1 | ShipBob MVP: orders sync + tracking poll + customer page + lookup |
| 2 | KLB + TrackingMore |
| 3 | Klaviyo events + RichPanel API |
| 4 | Parallel run with Narvar + cutover |
| 5 | Hardening / analytics |

Start at **Phase 0** unless the user says otherwise. Exit criteria are in the plan.

## Data model essentials

- `orders` / `shipments` / `shipment_items`
- `tracking_events` — append-only; `shipment_id` nullable for order-level events
- `is_stalled` is a **boolean flag**, not a status enum value
- Current status = latest `tracking_events` by `occurred_at`, `status_rank`, `id` — terminals sticky
- Event dedupe via `event_hash` unique constraint
- Map Tracking API `status` / `substatus_code` → internal status via `status_mappings` table (config, not hard-coded)

## Admin UI target

Use TrackingMore’s Shipment Dashboard as the UX reference (not a brand clone):

- Screenshots: [`docs/ui-references/`](docs/ui-references/)
- Pattern: left nav + filterable shipments list + **right-hand slide-over** for detail/timeline
- Search by tracking # or order #; status tabs with counts; latest event + location on each row
- Details: [`docs/ui-references/README.md`](docs/ui-references/README.md)

## Customer features that must work

- Branded tracking page by unguessable token (`/t/:token`)
- Lookup: **order number + email** (or postcode) — never order number alone
- Timeline with locations from `history[].address`
- Split shipments as separate parcels
- City/country only on public page (no full street)

## Notifications (Klaviyo)

Minimum events (match live Narvar + additions):

- `shipment.shipped` (new — label/tracking assigned)
- `shipment.in_transit` (once per shipment when first reaching InTransit+)
- `shipment.out_for_delivery`
- `shipment.delivered`
- `shipment.delivery_attempt_failed`
- `shipment.exception`
- `shipment.stalled`

Do **not** emit on every InTransit scan — once per shipment via `dedupe_key`.

## Secrets & safety

- Never commit `.env` or real API keys
- Redact auth headers in `api_call_log`
- Do not log full street addresses to public APIs
- Prefer fixtures in `examples/` over live API calls while scaffolding
- Production VPS: `ssh root@2.24.104.137` — domain **`tracking.particleformen.com`** — see [`docs/ops/vps.md`](docs/ops/vps.md)

## When stuck

- Re-read `docs/dev-plan.md` §5 (ingestion) and §13 (live sample tables)
- Use examples under `examples/shipbob/` and `examples/analysis-summaries/`
- Research deep-dives: `docs/research/`

## Skills

Project skills in `.cursor/skills/` — load when relevant:

- `pfm-tracking-platform` — overall build conventions
- `shipbob-tracking-api` — how to call and normalize ShipBob Tracking API
