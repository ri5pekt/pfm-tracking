# Phase 2 — KLB + TrackingMore

Exit criterion: an international KLB order has timeline parity with Narvar discovery samples (DB/cache only on the customer page).

## Jobs

- [x] `klb.sync` — trailing 30-day `shippingorders?shipped=true&include_shipments=true` (`npm run sync:klb`, worker every 20m)
- [x] `trackingmore.register` — inline after KLB ingest for new / thin shipments (`enrichKlbWithTrackingMore`)
- [x] `trackingmore.poll` — every 15m (`npm run sync:trackingmore`)

## Carrier mapping

- [x] DHL eCommerce (`dhl_ecs` → TM `dhlglobalmail`), USPS/Stamps, UniUni, OnTrac, etc. in `002_seed.sql`
- [x] TrackingMore `status_mappings` seed (`004_trackingmore_status_mappings.sql`)

## Admin

- [x] Retrack action on KLB / TrackingMore shipments (audited)

## Manual checks

- [ ] Spot-check a live KLB DHL eCommerce shipment vs Narvar/TM timeline
- [ ] Confirm USPS lag recovers via Retrack or poll auto-retrack
- [ ] TrackingMore plan sized (~2,300 trackings/month)

## References

- `docs/dev-plan.md` §5.2–5.3, §8 Phase 2
- `plans/phase-2-to-4-overview.md`
