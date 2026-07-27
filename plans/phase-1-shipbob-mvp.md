# Phase 1 — ShipBob MVP (weeks 2–3)

Exit criterion: a domestic ShipBob order shows a live timeline on our domain (poll lag ≤ 30 min), sourced from the Tracking API.

## Jobs

### `shipbob.orders.sync` (15–30 min)
- `GET https://api.shipbob.com/1.0/order?Limit=250&…` with `Authorization: Bearer` + `shipbob_channel_id`
- Watermark via `sync_cursors` (15-min overlap); only advance on full success
- Upsert `orders`, `shipments`, `shipment_items`
- Capture `tracking.tracking_number` / carrier when present

### `shipbob.tracking.poll` (15–30 min)
- Select open ShipBob shipments with a tracking number
- Chunk 25 IDs →  
  `GET /2026-07/shipments-tracking?ShipmentIds=a&ShipmentIds=b`  
  (**repeated params**, never comma-separated)
- Upsert EDD, tracking_url, last_mile, POD fields on `shipments`
- Append new `history[]` rows into `tracking_events` (`event_hash` dedupe)
- Normalize status; emit Klaviyo only later (Phase 3) — optional stub ok

## Public
- [ ] `GET /t/:token` — tracking page JSON/HTML from DB only (no live ShipBob on render)
- [ ] `POST /lookup` — order number + email/postcode; generic failure; rate limit
- [ ] Timeline UI: status, events, locations, carrier link, EDD

## Admin
- [ ] Shipments list matching `docs/ui-references/` (status tabs, search, latest event + location on row)
- [ ] Right-hand slide-over detail (timeline, shipment fields, “View tracking page”)
- [ ] Search by order # / email / tracking #
- [ ] Raw event payload tab / section on the slide-over

## Fixtures
Use `examples/shipbob/*.json` for unit/integration tests before hitting live APIs.

## References
- `docs/dev-plan.md` §5.1, §6, §7
- `docs/research/shipbob-tracking-api-beta.md`
- `examples/analysis-summaries/shipbob-tracking-api-5d-summary.json`
