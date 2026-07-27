# Phase 1 — ShipBob MVP (weeks 2–3)

Exit criterion: a domestic ShipBob order shows a live timeline on our domain (poll lag ≤ 30 min), sourced from the Tracking API.

## Jobs

### `shipbob.orders.sync` + `shipbob.tracking.poll` (every 20 min via worker `shipbob.sync`)
- Implemented in `scripts/sync-shipbob.ts` (`npm run sync:shipbob`)
- Watermark via `sync_cursors` (15-min overlap); only advance on full success
- Upsert `orders`, `shipments`, `shipment_items`
- Poll open ShipBob shipments in chunks of 25 (`ShipmentIds=` repeated params)
- Normalize status; Klaviyo later (Phase 3)

## Public
- [x] `GET /t/:token` — tracking page JSON/HTML from DB only (no live ShipBob on render)
- [x] `POST /lookup` — order number + email/postcode; generic failure; rate limit
- [x] Timeline UI: status, events, locations, carrier link, EDD

## Admin
- [x] Shipments list matching `docs/ui-references/` (status tabs, search, latest event + location on row)
- [x] Right-hand slide-over detail (timeline, shipment fields, “View tracking page”)
- [x] Search by order # / email / tracking #
- [x] Raw event payload tab / section on the slide-over

## Fixtures / sample seed
- [x] One-shot `npm run seed:samples` — 50 ShipBob + 50 KLB (≥14d) with timelines
- [x] `npm run sync:trackingmore` catch-up + worker `trackingmore.poll` every 15m (TM lag after create)
- Use `examples/shipbob/*.json` for unit/integration tests before hitting live APIs

## References
- `docs/dev-plan.md` §5.1, §6, §7
- `docs/research/shipbob-tracking-api-beta.md`
- `examples/analysis-summaries/shipbob-tracking-api-5d-summary.json`
