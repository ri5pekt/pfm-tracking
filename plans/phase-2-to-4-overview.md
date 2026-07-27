# Phase 2–4 — Overview

Details live in `docs/dev-plan.md` §8. Short pointers for agents:

## Phase 2 — KLB + TrackingMore
See [`phase-2-klb-trackingmore.md`](phase-2-klb-trackingmore.md).

- Poll KLB Legacy `shippingorders?shipped=true&include_shipments=true` (30-day trailing window)
- Register + poll TrackingMore for KLB tracking numbers
- Admin retrack action (USPS lag)
- Buy TrackingMore plan sized to ~2,300 trackings/month **before** starting

## Phase 3 — Klaviyo + RichPanel
See [`phase-3-notifications-richpanel.md`](phase-3-notifications-richpanel.md).

- Emit deduped events (shipped, OFD, delivered, attempt failed, exception, stalled)
- Keep failed-attempt vs exception as separate event types
- RichPanel read-only order lookup API

## Phase 4 — Cutover
See [`phase-4-parallel-cutover.md`](phase-4-parallel-cutover.md).

- Parallel run vs Narvar
- Point transactional links to new tracking URLs
- Old Narvar link redirect / grace period
- Keep Narvar one billing period as rollback
