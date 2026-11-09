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

## Known gaps

- [x] `scripts/sync-shipbob.ts` ran orders.sync → pending_recheck → tracking.poll
      sequentially with no error isolation — an uncaught throw in orders.sync killed the
      whole process, so tracking.poll silently never ran. Incident 2026-08-10/11:
      `shipbob.tracking.poll` had zero runs (success or failure) for 32+ hours, collapsing
      Klaviyo `sent` volume from ~2-4k/day to near zero. Fixed 2026-08-11 — each step is now
      wrapped in its own try/catch so failures don't cascade.
- [x] `SHIPBOB_API_BASE` pointed at the deprecated `/1.0` order API (hard cutoff
      2026-08-31; already intermittently returning `410 api_version_deprecated` and
      triggering the cascading failure above). Migrated to `/2026-07` (same version already
      proven stable for the Tracking API) — fixed and deployed 2026-08-11.

## References
- `docs/dev-plan.md` §5.1, §6, §7
- `docs/research/shipbob-tracking-api-beta.md`
- `examples/analysis-summaries/shipbob-tracking-api-5d-summary.json`
