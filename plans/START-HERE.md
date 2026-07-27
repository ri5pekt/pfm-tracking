# START HERE

New agent / developer onboarding for **pfm-tracking**.

## 1. Open this folder as the Cursor workspace

`C:\Users\denis_particleformen\Desktop\docker-projects\pfm-tracking`

## 2. Read

1. `AGENTS.md`
2. `docs/dev-plan.md`
3. `plans/phase-0-foundations.md`

## 3. First task

Implement **Phase 0** only:

- Docker Compose Postgres + Redis (already stubbed)
- Monorepo TypeScript scaffold for `api` / `worker` / `admin`
- Schema migrations from `docs/dev-plan.md` §3.2
- Admin login + invite flow

Do **not** jump to Klaviyo or KLB until Phase 1 ShipBob MVP works.

## 4. Credentials

Copy `.env.example` → `.env` and fill keys when ready for live ShipBob calls.  
Until then, use `examples/shipbob/*.json` as fixtures.
