# PFM Tracking Platform

In-house order tracking platform replacing Narvar for Particle For Men.

**Canonical plan:** [`docs/dev-plan.md`](docs/dev-plan.md) (v3)  
**Start here for agents:** [`AGENTS.md`](AGENTS.md)  
**Phase 0 checklist:** [`plans/phase-0-foundations.md`](plans/phase-0-foundations.md)  
**Admin UI reference:** [`docs/ui-references/`](docs/ui-references/) (TrackingMore screenshots)

## What's already decided

| Area | Decision |
| :--- | :--- |
| Architecture | Separate Node.js service (not a Woo plugin) |
| ShipBob timelines | `GET /2026-07/shipments-tracking` batch ≤25 (repeated `ShipmentIds=` params) |
| KLB timelines | TrackingMore (KLB has tracking numbers only) |
| Ingestion | Polling 15–30 min, no webhooks in v1 |
| Notifications | Emit events → Klaviyo sends email/SMS |
| Stack | Postgres + Redis/BullMQ + Docker + Vue admin |

## Repo layout (to build)

```text
api/       # public + admin + RichPanel HTTP API
worker/    # BullMQ jobs (ShipBob, KLB, TrackingMore, Klaviyo)
admin/     # Vue admin dashboard
web/       # customer tracking page (or served by api)
docs/      # plan + brief + research
examples/  # real API response shapes
plans/     # phased build checklists
scripts/   # one-off utilities
```

## Local secrets

Copy `.env.example` → `.env`. Never commit `.env`.

Research credentials live in the research project only; paste working keys into this `.env` when starting Phase 1 integration tests.

## Research provenance

Discovery work was done in  
`Desktop/Cursor Projects/tracking-platform-research`  
and copied into `docs/research/` + `examples/`.
