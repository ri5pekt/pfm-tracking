---
name: pfm-tracking-platform
description: >-
  Build and extend the Particle For Men order tracking platform (Narvar
  replacement). Use when scaffolding, implementing sync jobs, tracking page,
  admin, status mapping, Klaviyo events, or anything covered by docs/dev-plan.md.
---

# PFM Tracking Platform skill

## Before coding

1. Read `AGENTS.md` and the relevant phase file under `plans/`.
2. Confirm the change matches a locked decision in `docs/dev-plan.md` §1.
3. Prefer fixtures in `examples/` over live API calls until integration tests.

## Implementation order

Phase 0 → Phase 1 (ShipBob) → Phase 2 (KLB/TM) → Phase 3 (Klaviyo/RichPanel) → Phase 4 cutover.

## Status derivation

```text
internal_status = tracking_events for shipment
  ORDER BY occurred_at DESC, status_rank DESC, id DESC
  LIMIT 1
```

Terminal statuses (`DELIVERED`, `CANCELLED`, `RETURNED_TO_SENDER`) are sticky.  
`EXCEPTION` is not sticky — a later InTransit/Delivered clears it.  
`is_stalled` is orthogonal (boolean).

## Klaviyo

Emit only on transitions, not on every InTransit scan. Keep  
`delivery_attempt_failed` distinct from `exception`.

## References

- Plan: `docs/dev-plan.md`
- ShipBob Tracking API: `.cursor/skills/shipbob-tracking-api/SKILL.md`
- Live frequency tables: `examples/analysis-summaries/`
