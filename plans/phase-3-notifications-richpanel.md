# Phase 3 — Notifications + RichPanel

Exit criterion: a status change produces one correct (deduped) Klaviyo event in `notification_log`; RichPanel can fetch tracking links.

## Notifications

- [x] Emitter with `dedupe_key = {shipment_id}:{event_type}`
- [x] Events: shipped, out_for_delivery, delivered, delivery_attempt_failed, exception, stalled
- [x] Dry-run by default (`KLAVIYO_DRY_RUN=true`) — no live Klaviyo API yet
- [x] Emit hooked from `refreshShipmentStatus` + backfill `npm run sync:notifications`
- [x] Admin slide-over “Klaviyo / notifications” timeline

## Stalled

- [x] `stalled.detect` (`npm run sync:stalled`, worker daily) — `STALLED_DAYS` default 7
- [x] Sets `is_stalled` flag; emits `shipment.stalled` once

## RichPanel

- [x] `GET /api/richpanel/orders/:orderNumber` with `X-Api-Key` / Bearer (`RICHPANEL_API_KEY`)

## Still open

- [x] Wire real Klaviyo Events API when key is ready (`KLAVIYO_DRY_RUN=false`)
- [x] Admin notification Replay (audited)
- [ ] Cutover checklist: switch off duplicate Narvar shipping emails → see Phase 4

## References

- `docs/dev-plan.md` §6, §8 Phase 3
- `docs/research/klaviyo-event-research.md`
