# Ops API spec — read-only shipment status for `pfm-shopify-ops`

**Audience:** an agent implementing this inside the `pfm-tracking` repo. Read `AGENTS.md` first —
this doc doesn't repeat locked architecture decisions from there, only adds to them.

**Status:** implemented in `api` (POST/GET ops routes, `OPS_API_KEY`, `buildApp`). §9 join-key
cross-check against a live `pfm-shopify-ops` dispatch is still open. This is a spec, not a plan
doc — if you start a `plans/phase-N-*.md`-style tracker, that file is the source of truth for
progress, not this one.

## 1. Why this exists

`pfm-shopify-ops` (a separate repo, `particle-shopify-apps/pfm-shopify-ops`) dispatches orders to
ShipBob and Zenventory and needs to know, for each order it dispatched, whether the shipment has
since been marked **shipped**, **delivered**, or hit a carrier-level **exception** — the actual
last-mile carrier truth, not just "warehouse accepted the order." It does not have this today: its
own ShipBob/Zenventory polling (`reconcileShipBobStatus.ts` / `reconcileZenventoryStatus.ts`) only
reads the *warehouse's* shipment status (e.g. ShipBob's `Completed`/`Cancelled`/`Exception`), which
is a different, earlier signal than carrier delivery. `pfm-tracking` already computes exactly the
missing signal — canonical carrier status per shipment — because that's this tool's whole job. This
spec adds a small, **read-only** API so `pfm-shopify-ops` can query it instead of both tools
re-implementing carrier-status polling independently.

## 2. Non-goals (do not build these)

- **No order intake from `pfm-shopify-ops`.** This tool already learns about every order
  independently via its own ShipBob/KLB polling (`scripts/sync-shipbob.ts`,
  `scripts/sync-klb.ts`). `pfm-shopify-ops` never pushes an order in; it only reads shipment status
  back out. Do not add a "create order" or "register shipment" endpoint for this consumer.
- **No status-vocabulary mapping done here.** `pfm-tracking` returns its own 9 canonical statuses
  (§4) verbatim. Deciding how `IN_TRANSIT`/`EXCEPTION`/etc. fold into `pfm-shopify-ops`'s own
  `pending`/`accepted`/`shipped`/`delivered`/`failed`/`exception` vocabulary is `pfm-shopify-ops`'s
  job, not this tool's — same principle already applied to Zenventory's raw status in that repo
  ("deliberately does not classify... the raw value is recorded... for a human to read").
- **No webhooks out.** `pfm-shopify-ops` polls this API on its own schedule; this tool does not
  push to it. (If that changes later, it's a new spec, not a silent addition to this one.)
- **Not a general-purpose public API.** Same trust tier as the existing RichPanel integration:
  one shared secret, one consumer, no per-tenant auth model.

## 3. The join-key problem — read this before writing any query

`orders.order_number` (this tool's primary external key today, used by the RichPanel endpoint) is
whatever ShipBob/KLB call it back to us as — see `ingestShipBobOrder()` /
`api/src/integrations/shipbob/ingest.ts:30` and `pickKlbOrderNumber()` /
`api/src/integrations/klb/ingest.ts:26`. The code prefers a native `order_number`/
`customerorder.ordernumber` field from the warehouse response first, falling back to the creator's
own `reference_id`/`orderNumber` only if the warehouse didn't supply one — so in principle this
column's meaning could differ per carrier.

**Empirically checked against live production data, 2026-08-05** (queried
`pfm-tracking`'s prod Postgres directly — 13,526 ShipBob shipments, 1,859 KLB): for both carriers,
`order_number` today holds small, WooCommerce-order-shaped values (e.g. `4057462`), clearly
distinct from the warehouse's own big internal id stored separately in `source_order_id` (e.g.
ShipBob's `381894238`, KLB's `8657767`). A handful of ShipBob rows even show the `999012415`-style
values that are `pfm-shopify-ops`'s own documented legacy WooCommerce-Replacement-Order id offset
(`fulfillable.ts`'s comment: *"a real replacement order (999001651) went through the identical KLB
dispatch path"*) — direct proof `order_number` is the legacy WooCommerce dispatcher's own
`reference_id`/`orderNumber`, for both carriers, not a ShipBob-native field overriding it. **So for
orders dispatched by the current (WooCommerce-based) system, the ambiguity above does not manifest
in practice.**

**This does NOT mean `order_number` will stay human-readable once `pfm-shopify-ops` is the live
dispatcher.** `pfm-shopify-ops`'s `fulfillableRefToString()` (`domain/fulfillable.ts`) sends
`` `${kind}:${id}` `` — e.g. `shopify_order:5723849573921`, Shopify's *raw numeric* order id, not
the human order name (`#1001`) — as both ShipBob's `reference_id` and Zenventory's `orderNumber`.
If ShipBob/KLB continue to just echo back whatever the creator sent (as confirmed above), a
Shopify-era order's `order_number` in this tool will read `shopify_order:5723849573921`, not a
clean number. Don't design the `orderNumber` fallback matcher (§5) assuming it'll look like the
WooCommerce-era rows above once `pfm-shopify-ops` orders start flowing through — it'll look
different, just still be an exact, matchable string.

**There is a second, more reliable key that both systems independently derive from the same
warehouse API response and is NOT ambiguous:** the warehouse's own native order ID.

- `pfm-shopify-ops` stores this in `fulfillment.dispatch_log.warehouse_order_id` — set from
  ShipBob's create-order response `body.id` and Zenventory's create-order response `body.id`
  (both `String(body.id)`; see `infra/carriers/shipbob/client.ts` and
  `infra/carriers/zenventory/client.ts` in that repo).
- This tool stores the same value in `shipments.source_order_id` (`text`, nullable). The real
  ShipBob (`381894238`) and KLB (`8657767`) values queried above are consistent with this being the
  warehouse's own order id (both large, carrier-distinct numbering, clearly not a shipment id or a
  small store-order-shaped number) — but this is still inference from field-naming and shape, not a
  confirmed cross-system row match. **§9, first bullet, is still open**: an actual `dispatch_log.
  warehouse_order_id` ↔ `source_order_id` comparison needs a real order that `pfm-shopify-ops`
  itself dispatched, which doesn't exist yet (production dispatch is still the legacy WooCommerce
  path as of this check) — re-run that check once `pfm-shopify-ops` has dispatched its first real
  live order, before fully trusting this join key in production.

**Design decision for this spec: match primarily on `(source, source_order_id)`, and accept
`orderNumber` only as a secondary/fallback matcher.** This is the one join key with no ambiguity
about which of two candidate strings wins.

**Naming mismatch to handle explicitly:** `pfm-shopify-ops` calls the KLB/Zenventory warehouse
`zenventory`; this tool's `shipments.source` / `orders` ingestion calls the same warehouse `klb`.
The caller (`pfm-shopify-ops`) is responsible for translating `zenventory` → `klb` before calling
this API — document this in the endpoint's request schema (§5) with an explicit example, and
**reject** (400, not silently ignore) any `source` value that isn't `'shipbob'` or `'klb'`, so a
missed translation fails loudly instead of just never matching.

## 4. Canonical statuses returned (verbatim, do not translate)

From `api/src/routes/admin-mappings.ts`:

```ts
const INTERNAL = [
  'ORDER_RECEIVED',
  'PROCESSING',
  'LABEL_CREATED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'EXCEPTION',
  'DELIVERED',
  'RETURNED_TO_SENDER',
  'CANCELLED',
] as const;
```

Return `shipments.internal_status` as-is, plus `shipments.is_stalled` as its own separate boolean
field (it is a flag, not one of the 9 statuses — do not fold it into `internal_status`, matching
how `admin-shipments.ts` and `richpanel.ts` already keep the two separate).

## 5. New endpoint: bulk lookup (the one `pfm-shopify-ops` actually needs)

```
POST /api/ops/shipments/lookup
```

This is the primary endpoint. `pfm-shopify-ops` will call it from a scheduled poll (its own
`platform/queue` scheduled-task pattern — see that repo's `scheduledTaskRepo.ts` — not built yet on
its side, but design this endpoint assuming a batch caller, not a per-order one, so it doesn't need
a second bulk-vs-single redesign later).

### Auth

Same shared-secret pattern as `authorizeRichPanel()` in `routes/richpanel.ts` — do not invent JWT.
Add a **new** env var `OPS_API_KEY` (do not reuse `RICHPANEL_API_KEY` — different consumer,
independently rotatable). Extract the existing `authorizeRichPanel` body into a small shared
helper (e.g. `lib/api-key-auth.ts` exporting `authorizeApiKey(request, expectedKey)`) and call it
from both `richpanel.ts` and the new route module, rather than copy-pasting the header-parsing
logic a second time.

Header: `X-Api-Key: <OPS_API_KEY>` or `Authorization: Bearer <OPS_API_KEY>` (mirror RichPanel's
either-header acceptance exactly).

### Request body

```ts
interface OpsLookupRequest {
  readonly orders: ReadonlyArray<{
    /** Opaque, chosen by the caller (e.g. a Shopify order GID) — echoed back verbatim so the
     *  caller can correlate results without needing this tool's internal order id. Required. */
    readonly clientRef: string;
    /** Primary matcher. Omit only if you truly have nothing but orderNumber (discouraged — see §3). */
    readonly source?: 'shipbob' | 'klb';
    readonly sourceOrderId?: string;
    /** Fallback matcher, used only when source+sourceOrderId doesn't find a row, or wasn't given. */
    readonly orderNumber?: string;
  }>;
}
```

- Reject the request with `400 { error: 'empty_batch' }` if `orders` is empty.
- Reject with `400 { error: 'batch_too_large', max: 500 }` above some cap — **500** is a reasonable
  starting point (this tool's own KLB poll batches 50 shipment updates/run per
  `pfm-shopify-ops`'s `docs/DEV-PLAN.md` §P2.17; a status *read* is far cheaper than a warehouse
  write, so a materially higher cap is fine, but pick one and enforce it rather than leaving it
  unbounded).
- Reject any item where `source` is present but not `'shipbob'`/`'klb'` with `400
  { error: 'invalid_source', clientRef }` — per §3, fail loudly on the naming mismatch rather than
  silently returning `found: false`.
- Reject any item with neither `sourceOrderId` nor `orderNumber` present with
  `400 { error: 'no_matcher', clientRef }`.

### Response body

```ts
interface OpsLookupResponse {
  readonly results: ReadonlyArray<
    | {
        readonly clientRef: string;
        readonly found: true;
        readonly orderNumber: string;
        readonly currentStatus: string; // orders.current_status — one of the 9 canonical values
        readonly shipments: ReadonlyArray<{
          readonly source: 'shipbob' | 'klb';
          readonly sourceShipmentId: string;
          readonly sourceOrderId: string | null;
          readonly carrierCode: string | null;
          readonly carrierService: string | null;
          readonly trackingNumber: string | null;
          readonly carrierTrackingUrl: string | null;
          readonly internalStatus: string; // one of the 9 canonical values, verbatim
          readonly isStalled: boolean;
          readonly shippedAt: string | null; // ISO
          readonly deliveredAt: string | null; // ISO
          readonly lastEventAt: string | null; // ISO
          readonly edd: string | null; // ISO
        }>;
      }
    | { readonly clientRef: string; readonly found: false }
  >;
}
```

- One result per request item, same order, matched back by `clientRef` — do not silently drop
  unmatched items from the array; return `found: false` for them so the caller can distinguish
  "not found" from "dropped due to a bug."
- An order can have more than one shipment (split shipments — see `AGENTS.md`'s "Split shipments as
  separate parcels"); return all of them, not just one.
- Match order: try `(source, sourceOrderId)` against `shipments.source` + `shipments.source_order_id`
  first if both are given; only fall back to `orders.order_number = orderNumber` if that didn't find
  a row (or wasn't given). Join `shipments` → `orders` on `shipments.order_id` either way.

### Implementation notes

- Put this in a new route module `api/src/routes/ops.ts`, exporting
  `registerOpsRoutes(app, { db, env })`, registered in `index.ts` alongside the other
  `register*Routes` calls (same `{ db, env }` deps shape everything else already uses).
- Do this as a single SQL query per batch (e.g. `WHERE (source, source_order_id) IN (...)  OR
  order_number = ANY(...)`, matched back up in application code by whichever key matched) — not
  one round trip per item. The whole point of a bulk endpoint the caller doesn't have to poll
  order-by-order is defeated if this issues N queries internally.
- Reuse the exact `shipments`/`orders` column list `richpanel.ts` already selects (§ code snippet
  in that file) as your starting point — this is the closest existing analog, clone its shape
  rather than designing a new one from scratch.

## 6. New endpoint: single lookup (nice-to-have, not required for the poller)

```
GET /api/ops/shipments/:sourceOrderId?source=shipbob|klb
```

Same auth, same matching rules, same response shape as one element of §5's `results` array (minus
the `clientRef` wrapper). Useful later for an ad-hoc "view tracking" action on
`pfm-shopify-ops`'s order-detail page, but not required to unblock the scheduled-poll use case —
build §5 first; add this only if it's cheap to add alongside it (it should be, if you factor the
query logic into a shared function both routes call).

## 7. Required refactor: `index.ts` has no testable app factory

`api/src/index.ts`'s `main()` builds the Fastify instance and calls `app.listen(...)` inline —
there is no exported function that returns the built-but-not-listening app. Every other route
module in this repo (`richpanel.test.ts`, etc. — **check first**, there may be none yet) has zero
Fastify-level HTTP tests as a result; this repo's tests are all pure-function `node:test` on
`domain/`/`lib/` code (see `domain/event-hash.test.ts`, `lib/ops-health.test.ts`).

Before writing a route test for the new endpoint, extract a `buildApp(deps): Promise<FastifyInstance>`
function (same registration steps `main()` currently does, minus `ensureBootstrapAdmin` /
`ensureOrderTokensSealed` / `app.listen`, or with those made optional) so a test can do:

```ts
const app = await buildApp({ db, env });
const response = await app.inject({ method: 'POST', url: '/api/ops/shipments/lookup', payload: {...} });
```

This is new territory for this repo (§10 of the exploration that produced this spec found **no**
existing `app.inject()` usage anywhere) — do it once, cleanly, rather than working around the lack
of a factory with a one-off test setup that the next route won't be able to reuse.

## 8. Config / env checklist

- `api/src/config.ts`: add `OPS_API_KEY: z.string().optional()` to `envSchema`, next to
  `RICHPANEL_API_KEY`.
- `.env.example`: add `OPS_API_KEY=` with a comment noting it's the shared secret
  `pfm-shopify-ops` sends as `X-Api-Key`.
- `docker-compose.yml` / `docker-compose.prod.yml`: confirm `env_file: .env` already covers the API
  service (it should — same mechanism as `RICHPANEL_API_KEY`) rather than assuming; check.

## 9. Verify before calling this done — do not skip

1. **Confirm the join key (§3) against a real `pfm-shopify-ops`-dispatched order — still open.**
   The 2026-08-05 check only confirmed `source_order_id`'s *shape* is consistent with "warehouse's
   own order id" (large, carrier-distinct numbering) by inspecting rows from the *current*
   WooCommerce-dispatched population — it could not cross-check against
   `pfm-shopify-ops.fulfillment.dispatch_log.warehouse_order_id` because no order in production has
   been dispatched by `pfm-shopify-ops` yet. As soon as it has dispatched even one real order to
   each warehouse, pick that order and confirm `dispatch_log.warehouse_order_id` for it equals this
   tool's `shipments.source_order_id` for the matching row. If it does not match for either
   warehouse, the matching design in §5 needs to change before this ships in production — do not
   assume the shape-based inference above is sufficient on its own.
2. **`orders.order_number`'s actual content for the WooCommerce era is now confirmed (§3, checked
   2026-08-05)** — it's the creator's own `reference_id`/`orderNumber` (WooCommerce order ids,
   including the legacy `999xxxxxx` Replacement Order offset), not a ShipBob/KLB-native field, for
   both carriers. **Still open:** re-confirm this holds once real `pfm-shopify-ops`-dispatched
   orders exist — §3 predicts they'll show `shopify_order:<numeric id>` rather than a clean number,
   but that's inference from `fulfillableRefToString()`'s code, not a checked live row yet.
3. **Confirmed live, 2026-08-05, against `https://tracking.particleformen.com/api/ops/shipments/
   lookup` in production** (not unit-tested only — real HTTP requests from `pfm-shopify-ops`'s own
   side): missing `X-Api-Key` → `401 {"error":"unauthorized"}`; wrong key → same; valid key via
   either `X-Api-Key` or `Authorization: Bearer` → `200`. Response shape matches §5 exactly for a
   real ShipBob order (`4057462`) and a real KLB order (`999012415`, correctly reported back as
   `source: "klb"`). `invalid_source` (sent `"zenventory"`), `no_matcher`, and `empty_batch` all
   returned the documented `400` shapes. A not-found item inside an otherwise-valid batch correctly
   returned `{clientRef, found:false}` without failing the rest of the batch. The `orderNumber`
   fallback matcher (no `source`/`sourceOrderId` given) correctly resolved to the same ShipBob
   order. **This item is done — no further action needed.**
4. **Load-test the batch cap you picked** (§5) against realistic response sizes — an order with
   several split shipments returns proportionally more rows; make sure 500 orders/request doesn't
   produce a pathological response size or query plan before shipping that number as the limit.
   **Still open** — the live check above only used small batches (1-4 items).

## 10. Out-of-scope follow-ups (do not build now, just don't design against them)

- ShipBob webhooks as the trigger instead of `pfm-shopify-ops` polling this API — blocked
  independently in `pfm-shopify-ops` (`DEV-PLAN.md` P2.13: ShipBob's webhook body shape is
  undocumented) and not something this tool can unblock.
- A push/webhook FROM this tool TO `pfm-shopify-ops` when a shipment's status changes — would
  remove the need for `pfm-shopify-ops` to poll at all, but is strictly more work (delivery
  guarantees, retries, an inbound receiver on the other side) than this read-only API and isn't
  needed to answer the immediate question ("is this order shipped/delivered/exception yet").
