# Order Tracking Platform — Development Plan

**Status:** Ready for build
**Version:** v3 — 27 July 2026
**Supersedes:** v1 (26 July 2026)
**Based on:** `order-tracking-platform-brief.md`, `warehouse-api-discovery.md`,
`docs/shipbob-tracking-api-beta.md`, `docs/klaviyo-event-research.md`, and live
data pulls summarized in `examples/analysis-summaries/` (full research repo kept separately).

---

## 0. What changed in v3

The single biggest input to this revision: **ShipBob's new Tracking API is
live on our credentials** (confirmed 27 July 2026, after regenerating the
PAT). This replaces the old `/shipment/{id}/timeline` endpoint used in v1 —
which now returns **404** on retest — and removes the rate-limit-driven
complexity that would otherwise have shaped the whole ShipBob ingestion
design.

| # | Change | Why |
| :---- | :---- | :---- |
| A | ShipBob carrier timeline source switched from `/shipment/{id}/timeline` to `GET /2026-07/shipments-tracking` (batch, ≤25 shipment IDs per call) | Old endpoint 404s as of 27 Jul. New endpoint is live, richer (substatus codes, EDD, tracking URL, last-mile carrier, POD, geo), and **25× more efficient per call** — see `docs/shipbob-tracking-api-beta.md` |
| B | ShipBob polling no longer needs to be "change-driven" / conditional to fit the rate limit | At even the brief's high-volume band (~12,900 open shipments), batching at 25/call means a full poll of *every* open shipment costs ~34 req/min average against a 150 req/min budget — 4×+ headroom without any conditional-fetch logic. Simpler design, same safety margin |
| C | Event log renamed `tracking_events` (from `shipment_events`), gains `order_id` so order-level events (before any parcel exists) don't need a separate table | Matches how ShipBob itself models it (order → shipments → tracking) and avoids a `UNION ALL` for the pre-shipment part of the customer timeline |
| D | `is_stalled` moved from an internal-status value to a boolean flag on `shipments` | A stalled parcel is still, factually, `IN_TRANSIT` — treating "stalled" as a status was fighting the no-regression rule (brief FR1.4) and destroying the real carrier state on the page |
| E | New `api_call_log` table (lightweight, sampled) for HTTP-level debugging | CS and engineering need to go from "this shipment looks wrong" to "here is the exact HTTP response" without re-running scripts by hand |
| F | Batch query format documented as a gotcha | Docs say comma-separated `ShipmentIds`; live API returns **400** for that and requires **repeated params** (`ShipmentIds=a&ShipmentIds=b`). Costly to discover mid-build — noted here and in `docs/shipbob-tracking-api-beta.md` |
| G | `AvailableForPickup` and generic `Exception` added to the internal status mapping table | Not in the original brief's status list; both appeared in live Tracking API data (§13) |

Two structural ideas are also carried over from an earlier extended draft of
this plan (credited: Claude Opus 5 pass, `claude-projects/tracking-platform-research/docs/dev-plan.md`)
because they hold up independent of which ShipBob endpoint is in use:

- **Separating transport logs from domain events from side-effect logs**
  (`api_call_log` / `tracking_events` / `notification_log`) instead of one
  big JSON blob per shipment — see §3.1 for the reasoning.
- **`status_rank` + derive-don't-track** for current status, with terminal
  statuses sticky — see §4.

Everything else from that draft was evaluated and **not** carried forward
here, mainly because it was built around the *old* `/timeline` endpoint's
rate-limit pressure (ShipBob's documented `HasTracking`/`IsTrackingUploaded`
flag dance, per-shipment conditional fetching, a 1,200-line admin spec). The
new batch Tracking API removes the constraint that design was solving, so
adopting it wholesale would add complexity this project doesn't need. Where
a simpler version of an idea earns its keep (e.g. `sync_cursors`, GDPR
erasure table, `carriers` table) it's included below in a trimmed form.

### 0.1 Deviations from the brief — need explicit sign-off

| Brief said | This plan does | Consequence |
| :---- | :---- | :---- |
| FR1.1: ingest ShipBob via **webhook**, polling as reconciliation | **Polling only**, 15–30 min, full batch poll every cycle | Average latency ~7–15 min instead of near-instant; still inside the 30-min SLA. Webhooks remain a Phase 5 option if this stops being enough headroom. |
| §4.2: WooCommerce is **source of truth for the order** | **WooCommerce not used at all** on the runtime path; ShipBob + KLB supply customer/order data; local table supplies product titles/images | Orders that never reach a warehouse (cancelled, unpaid, stuck pre-fulfilment) won't exist in the hub — CS uses Woo directly for those. No product photos unless sourced separately (Woo products-only sync, ShipBob catalog, or CSV — not yet decided). |

---

## 1. Locked decisions

| Decision | Choice |
| :---- | :---- |
| Architecture | Separate Node.js service (not a WooCommerce plugin) |
| Data sources | ShipBob + KLB/Zenventory directly — no WooCommerce on the order path |
| Carrier timelines (ShipBob) | **ShipBob Tracking API** `GET /2026-07/shipments-tracking` (batch ≤25 shipment IDs; `TrackingIds` variant for tracking-number lookups) |
| Carrier timelines (KLB) | TrackingMore aggregator (KLB itself gives tracking numbers only, no timeline) |
| Ingestion mode | **Polling only** (15–30 min). No webhooks in v1 |
| Notifications | Emit events to Klaviyo; Klaviyo sends email/SMS |
| Product catalog | Local SKU + image/title table (no live Woo product fetch) |
| Customer UI | Branded tracking page + order lookup |
| Admin UI | Vue.js dashboard (logs, statuses, re-sync tools) |
| External API | Read-only API for RichPanel |
| Datastore | PostgreSQL |
| Jobs / cache | Redis + BullMQ |
| Runtime | Docker (dev + deploy), single VPS is sufficient at current volume |
| ShipBob order API | `1.0` confirmed working for `/order` reads with `SHIPBOB_API_KEY` |
| ShipBob tracking API | `2026-07` — confirmed working 27 Jul 2026 with a **regenerated** `SHIPBOB_API_KEY`. The prior (Jan-2024-era) PAT returned 401 on Tracking endpoints while still working on `/order` — if this key needs rotating again, re-test both surfaces, not just one |

---

## 2. System overview

```text
┌─────────────┐  poll: orders (15–30m) ┌──────────────────────────────┐
│   ShipBob   │ ──────────────────────►│                              │
│  /1.0/order │                        │   Tracking Hub (Node.js)     │
└─────────────┘                        │                              │
┌─────────────┐  poll: batch tracking  │  • Orders / Shipments store  │
│   ShipBob   │ ◄──────────────────────│  • tracking_events (append)  │
│ Tracking API│  (≤25 ids/call)        │  • Status normaliser         │
│  /2026-07   │ ──────────────────────►│  • Product catalog           │
└─────────────┘                        │  • Klaviyo emitter (deduped) │
┌─────────────┐  poll: shipped orders  │  • BullMQ scheduled jobs     │
│ KLB/Zenvent │ ──────────────────────►│                              │
└─────────────┘                        └───────────┬──────────────────┘
┌─────────────┐  register + poll                   │
│TrackingMore │ ◄──────────────────────────────────┤
└─────────────┘                                     │
                  ┌──────────────────────────────────┼──────────────────┐
                  ▼                                  ▼                  ▼
           Customer tracking                Admin Vue dashboard    RichPanel API
              page + lookup                   (logs / re-sync)       (read-only)
                                                       │
                                                       ▼
                                               Klaviyo Events API
```

---

## 3. Data model (PostgreSQL)

### 3.1 Why three separate logging layers

| Layer | Table | Grain | Retention | Audience |
| :---- | :---- | :---- | :---- | :---- |
| Transport | `api_call_log` | one HTTP exchange | 30 days | debugging an integration |
| Domain | `tracking_events` | one normalised checkpoint | 24 months | customer timeline, status derivation |
| Side effects | `notification_log`, `admin_audit_log` | one outbound event / one human action | 24 months | dedupe, support, compliance |

Storing the timeline as a jsonb array on the shipment row was considered and
rejected: it turns every new event into a full-row rewrite (write
amplification at 5–8 events/shipment × thousands/day), makes "append-only"
unenforceable at the database level, and can't be indexed for the delivery-
performance reporting the brief lists as Phase 2. A dedicated append-only
table with `INSERT`-only permissions (revoke `UPDATE`/`DELETE` from the app
role) gets all three for free.

`api_call_log` is optional-but-recommended infrastructure, not a hard
Phase-0 blocker like in the more elaborate draft this plan reviewed — it can
land as a lightweight table (no partitioning, no per-request-body capture)
in Phase 1 and be hardened later if debugging volume justifies it.

### 3.2 Tables

**`orders`**
- `id` (uuid), `order_number` (unique, customer-facing)
- `customer_email`, `customer_name`, `customer_phone`
- `destination_city`, `destination_country` (no full street on public page)
- `public_token_hash` (sha256 of the token; raw token never stored)
- `ordered_at`, `current_status` (denormalised roll-up across shipments, for list views)
- `anonymised_at` (GDPR erasure marker)
- `created_at`, `updated_at`

**`shipments`**
- `id` (uuid), `order_id` → orders
- `source` (`shipbob` | `klb`), `source_shipment_id`, `source_order_id`
- `carrier_code` → carriers, `carrier_service`, `tracking_number`, `carrier_tracking_url`
- `internal_status`, `status_rank`, `status_source_event_id` (which event produced current status)
- `is_stalled` (bool), `stalled_since`
- `aggregator` (`none` | `trackingmore`), `aggregator_id`
- ShipBob Tracking API fields: `edd`, `edd_source` (`carrier` | `shipbob`), `last_mile_carrier` (jsonb), `delivery_signed_by`, `proof_of_delivery_urls` (text[])
- `shipped_at`, `delivered_at`, `last_event_at`
- `created_at`, `updated_at`
- unique `(source, source_shipment_id)`; unique `(carrier_code, tracking_number)` **where not terminal** (carriers reuse tracking numbers)
- partial index for the poll queue: `WHERE internal_status NOT IN ('DELIVERED','CANCELLED','RETURNED_TO_SENDER')`

**`shipment_items`**
- `shipment_id`, `sku`, `quantity`, `title` (snapshot at ingest), `image_url`

**`tracking_events`** (append-only)
- `id` (bigserial), `order_id` NOT NULL, `shipment_id` (nullable — null for order-level events like `ORDER_RECEIVED` that arrive before any parcel exists)
- `occurred_at` (carrier/ShipBob timestamp — the ordering key), `received_at` (when we ingested it)
- `internal_status`, `status_rank` (copied at write time, for the tiebreak in §4)
- `source` (`shipbob` | `trackingmore` | `system`)
- `raw_status` (Tracking API `status`), `raw_substatus_code` (`substatus_code`, e.g. `InTransit_002`), `raw_substatus` (human label), `description` (`substatus_message` — carrier detail/exception text), `location` (city/state or `address.location`), `latitude`, `longitude`
- `raw_payload` (jsonb, scrubbed after 30 days)
- `event_hash` (unique) — see §5.4 for dedupe key composition
- never `UPDATE`/`DELETE` in normal flow

**`carriers`**
- `code` (pk, our canonical code, e.g. `speedx`), `display_name`, `tracking_url_template`
- `shipbob_aliases` (text[] — ShipBob's `carrier` string varies in case/spacing), `trackingmore_code`
- Seed from the carrier mix observed live (§13): Amazon Shipping, SpeedX, UniUni, OSMWorldwide, Cirro, USPS, OnTrac, BetterTrucks, FedEx, DhlEcs, UPS, ShipBob Freight

**`products`**
- `sku` (pk), `title`, `image_url`, `source`, `updated_at`

**`notification_log`**
- `id`, `order_id`, `shipment_id`, `event_type`, `dedupe_key` (unique)
- `status` (`pending`|`sent`|`failed`|`suppressed`), `payload` (jsonb), `replayed_by` (→ admin_users.id)

**`admin_users`** / **`admin_invites`** / **`admin_audit_log`**
- Standard invite-only admin auth: `admin_users` (`role` admin/staff, `status` pending/active/disabled, lockout fields), `admin_invites` (single-use, hashed token, `purpose` invite/password_reset), `admin_audit_log` (append-only, actor/action/target/metadata)

**`status_mappings`**
- `source`, `raw_status`, `raw_substatus_code` (nullable), `internal_status`, `status_rank`, `notes`, `updated_by`
- Editable from admin (brief §6.2 explicit requirement: mapping must be config, not code). Seeded from §13's live substatus-code table.
- Unmapped raw statuses are **not dropped** — written as an event carrying the shipment's current status, and surfaced on an admin "unmapped statuses" screen. Silent drops hide mapping bugs.

**`data_erasure_requests`** (GDPR trail, brief §8)
- `customer_email`, `requested_at`, `requested_by`, `completed_at`, `orders_affected`, `events_scrubbed`

**`sync_cursors`**
- `job_name` (pk), `cursor_at` (last fully-covered instant), `last_success_at`
- Only advances on a fully successful run; every query re-covers a 15-minute overlap to absorb clock skew (§5.1)

**`ingestion_runs`**
- `job_name`, `started_at`, `finished_at`, `status` (running/success/partial/failed), `records_seen`, `records_upserted`, `events_appended`, `errors`, `cursor_before`, `cursor_after` — one row per job execution, for the admin job-log screen

**`api_call_log`** (lightweight)
- `occurred_at`, `integration`, `operation`, `http_method`, `url` (credentials redacted), `response_status`, `duration_ms`, `error_message`, `shipment_id` (nullable soft link)
- Log headers/status/timing for 100% of calls; full body only for errors and a 10% sample of successes, to keep volume manageable without a partitioning scheme
- 30-day retention via a simple scheduled delete (partitioning is a Phase 5 optimisation if volume justifies it, not a Phase 0 requirement)

### 3.3 Retention

| Data | Retention | Mechanism |
| :---- | :---- | :---- |
| `api_call_log` | 30 days | scheduled delete |
| `tracking_events.raw_payload` | 30 days | nightly scrub (`raw_payload = NULL`) |
| `tracking_events` (row) | 24 months | monthly delete by `occurred_at` |
| `orders` / `shipments` | 24 months after delivery | anonymise (email → hash, name/phone/city → NULL), don't hard-delete — keeps Phase 2 carrier analytics intact |
| `notification_log` | 24 months | monthly delete |
| `admin_audit_log` | indefinite | never purged |

GDPR erasure runs the anonymise path on demand for one email, logged in
`data_erasure_requests`. Build from Phase 1 — requests can arrive on day one.

---

## 4. Internal status set

| Internal status | Rank | Customer-facing label | Triggered by (Tracking API `current_status` / history `status`) |
| :---- | :---- | :---- | :---- |
| `ORDER_RECEIVED` | 10 | Order confirmed | Order created at source |
| `PROCESSING` | 20 | Preparing your order | ShipBob order `Processing`, no tracking yet |
| `LABEL_CREATED` | 30 | Shipment ready | Tracking API `PreTransit` |
| `IN_TRANSIT` | 40 | On its way | Tracking API `InTransit` |
| `OUT_FOR_DELIVERY` | 50 | Out for delivery | Tracking API `OutForDelivery`, `AvailableForPickup` |
| `EXCEPTION` | 55 | There's a delay | Tracking API `DeliveryAttemptFailed`, `DeliveryException`, `Exception` |
| `DELIVERED` | 90 | Delivered | Tracking API `Delivered` |
| `RETURNED_TO_SENDER` | 90 | Returning to us | Carrier return codes (TrackingMore `exception011`/RTS; ShipBob substatus text mentioning return) |
| `CANCELLED` | 90 | Cancelled | Source cancellation |

`is_stalled` is a **flag on `shipments`**, not a status (see §0 item D). A
stalled parcel keeps its real `internal_status` (usually `IN_TRANSIT`); the
customer page keeps saying "On its way", the admin exception dashboard picks
it up separately, and Klaviyo gets a `shipment.stalled` event once.

**Status derivation (brief FR1.4)** — computed from `tracking_events`, never
from "last event processed":

```sql
SELECT internal_status, id
FROM tracking_events
WHERE shipment_id = $1
ORDER BY occurred_at DESC, status_rank DESC, id DESC
LIMIT 1;
```

- **Tiebreak.** Carriers routinely emit checkpoints with identical or
  date-only timestamps (confirmed in live samples — several `InTransit`
  scans land within the same second). `status_rank DESC` resolves it,
  `id DESC` is the deterministic fallback.
- **Terminal statuses are sticky.** Once `DELIVERED`, `CANCELLED`, or
  `RETURNED_TO_SENDER`, a later-arriving in-transit checkpoint (backdated,
  duplicate poll) cannot un-deliver it — enforce in the normaliser, not just
  the query.
- **`EXCEPTION` is not terminal.** A later `InTransit`/`Delivered` clears it
  naturally, which is the whole reason to derive rather than store.

**Distinguish failed-attempt vs generic exception for Klaviyo, even though
both collapse to `EXCEPTION` on the page.** Narvar's live flows split
"Failed Delivery Attempt" from "Delivery Exception" as separate emails —
preserve that by keeping `raw_status` (`DeliveryAttemptFailed` vs
`DeliveryException` vs `Exception`) on the event and branching the Klaviyo
event type off it, not off `internal_status` alone.

---

## 5. Ingestion

### 5.1 ShipBob — two independent jobs, not one

The new batch Tracking API changes the shape of this job from "poll one
timeline per shipment, budget carefully" to "poll every open shipment every
cycle, cheaply." Two jobs, cleanly separated by concern:

**`shipbob.orders.sync`** (15–30 min) — *discovers* orders/shipments and
carries customer/item data. Pulls `GET /1.0/order` filtered by a last-update
watermark (`sync_cursors` row `shipbob.orders`, 15-min overlap), paged at
`Limit=250`. Upserts `orders`, `shipments` (including the `tracking` object
embedded in the order response — carrier + tracking_number, available
before the Tracking API has anything to say), `shipment_items`.

- *Phase 0 check, not a blocker:* re-verify whether `HasTracking` /
  `IsTrackingUploaded` filters work on the **new** PAT (they 500'd in
  earlier discovery against the old one). If they work, they're a nice-to-
  have for finding "just got a tracking number" shipments faster; if not,
  the trailing-window watermark above is sufficient on its own, because…
- …**freshness of this job doesn't gate freshness of tracking status** —
  that's job two.

**`shipbob.tracking.poll`** (15–30 min) — *refreshes status* for shipments
we already know about. Query:

```sql
SELECT source_shipment_id FROM shipments
WHERE source = 'shipbob'
  AND tracking_number IS NOT NULL
  AND internal_status NOT IN ('DELIVERED','CANCELLED','RETURNED_TO_SENDER');
```

Chunk into groups of 25, call:

```text
GET https://api.shipbob.com/2026-07/shipments-tracking?ShipmentIds=id1&ShipmentIds=id2&…
```

**Use repeated query params, not comma-separated** — the live API returns
400 for `ShipmentIds=a,b` despite docs implying otherwise (§0 item F).

For each returned record: upsert `current_status` → `internal_status`
mapping, `edd`/`edd_source`, `tracking_url`, `last_mile_carrier`,
`delivery_signed_by`, `proof_of_delivery_urls` onto `shipments`; walk
`history[]` (newest first) and insert any event whose `event_hash` isn't
already present (§5.4) into `tracking_events`.

**Why this fits comfortably inside ShipBob's rate limit without conditional
fetching.** ShipBob limits to 150 req/min, shared per application. At the
brief's high-volume band (~50k orders/month, ~12,900 open shipments in a
rolling window):

| Volume band | Open shipments | Batch calls/cycle (÷25) | Avg req/min (15-min cycle) | Headroom |
| :---- | ---: | ---: | ---: | :---- |
| 10k orders/mo | ~2,600 | ~104 | ~7 | ~21× |
| 50k orders/mo | ~12,900 | ~516 | ~34 | ~4.4× |

Compare to the old per-shipment `/timeline` approach, which needed
~860 req/min at the same volume — 5.7× **over** budget and the reason the
previous draft of this plan required change-driven polling, conditional
fetches, and a Redis token-bucket governor just to fit. With batching, a
full poll of every open shipment, every cycle, still leaves multiples of
headroom. Keep a lightweight Redis token bucket (cap ~120 req/min) as a
safety net against bugs, not as the load-bearing design element it used to
be.

### 5.2 KLB / Zenventory

`GET /rest/shippingorders?shipped=true&start_date={today−N}&include_shipments=true`
(Legacy API, `SecureKey` auth). No modified-since cursor exists once
`shipped=true` — `start_date` means *ship date*, and there's no paging.
Trailing-window scan, `N = 30` days, run every cycle; re-reading is free
correctness-wise (idempotent upserts, §5.4) and costs bandwidth, not
integrity. `include_shipments=true` is required or the response carries no
tracking numbers.

Once a KLB shipment has a tracking number, its *status* comes from
TrackingMore, never from re-polling KLB — KLB is a source of shipments, not
of tracking events.

### 5.3 TrackingMore

- **Register** new KLB tracking numbers after each `klb.sync` (idempotent).
- **Poll** every 15–30 min for open TrackingMore shipments (simpler than a
  webhook receiver for v1; revisit if TrackingMore's own refresh cadence
  turns out to be much slower than ours, in which case move to webhook +
  daily reconcile).
- **Retrack** available as an admin action from day one — USPS numbers
  needed this in discovery (empty/stale on first poll until refreshed).
- Production TrackingMore plan must be sized to KLB's ~2,300 trackings/month
  before Phase 2 starts (the free tier hit both quota and read-permission
  limits during testing).

### 5.4 Idempotency

```text
event_hash = sha256(
  shipment_id || '|' ||
  occurred_at (ISO-8601 UTC, second precision) || '|' ||
  raw_status || '|' ||
  raw_substatus_code || '|' ||
  coalesce(description, '')
)
```

`INSERT … ON CONFLICT (event_hash) DO NOTHING` — the same history event
returned on consecutive polls (very common, since `history[]` is the full
list every time, not just deltas) collapses to one row. `(source,
source_shipment_id)` unique on `shipments` and `(dedupe_key)` unique on
`notification_log` cover the other two duplication surfaces (brief FR1.3).

### 5.5 Scheduled jobs (BullMQ)

| Job | Interval | Responsibility |
| :---- | :---- | :---- |
| `shipbob.orders.sync` | 15–30 min | Discover orders/shipments/items; capture carrier + tracking_number as soon as ShipBob assigns them |
| `shipbob.tracking.poll` | 15–30 min | Batch-refresh status for all open ShipBob shipments via Tracking API (§5.1) |
| `klb.sync` | 15–30 min | Trailing 30-day scan of shipped KLB shipping-orders |
| `trackingmore.register` | after `klb.sync` | Create TrackingMore trackings for new numbers (idempotent) |
| `trackingmore.poll` | 15–30 min | Refresh timelines for open TrackingMore shipments |
| `status.normalize` | on event write | Map raw → internal; recompute `shipments.internal_status`, `orders.current_status` roll-up |
| `notifications.emit` | on status change | Push Klaviyo events with dedupe |
| `stalled.detect` | daily | Set `is_stalled`; emit `shipment.stalled` once per shipment |
| `reconcile.daily` | daily | Flag shipped-but-missing, stuck statuses, orphan trackings, unmapped statuses |
| `products.sync` | daily / manual | Refresh SKU title/image catalog |
| `retention.scrub` | daily | 30-day `api_call_log` delete, `raw_payload` scrub, delivered-order anonymisation pass |

**Rules**
- Only open shipments are ever polled for tracking (partial index, §3.2).
- Every job writes an `ingestion_runs` row; only advance `sync_cursors` on a
  fully successful run.
- Idempotent upserts throughout; safe to run longer than the interval
  without overlapping (BullMQ lock/repeat with concurrency guard) — peak
  season will stretch run time.
- **Graceful degradation:** if ShipBob, KLB, or TrackingMore is unreachable,
  skip the cycle, mark the run `failed`, leave existing data untouched. The
  tracking page keeps showing last-known status with its timestamp — never
  an error page or blank timeline (brief NFR).

**Volume sizing:** brief estimates 10,000–50,000 orders/month
(~330–1,650/day), ~1.3 shipments/order, 5–8 events/shipment ⇒ roughly
5,000–25,000 inbound events/day in normal trading, with an unconfirmed peak
multiplier. See §5.1's table for why this comfortably fits the batch
Tracking API's call budget.

---

## 6. APIs

### Public (customer)
- `GET /t/:token` — tracking page data (cached; token looked up by
  `sha256(token)`, raw token never stored)
- `POST /lookup` — order number + email (or postcode); **both required**,
  never lookup by order number alone (brief FR4.1)
- Rate-limited per IP + bot protection on all public endpoints (FR4.2)
- Lookup failure returns a **generic error** that does not reveal whether
  the order number exists (FR4.3)
- Response never triggers a live ShipBob/TrackingMore call — reads
  Postgres/cache only

### Internal / admin
- Auth-protected
- Search orders/shipments by order #, email, tracking #
- View event history + raw payload per event; "show HTTP exchange" link
  where `api_call_log` has a matching row
- Trigger re-sync / TrackingMore retrack
- Replay Klaviyo event (audited)
- Job run logs / failures (`ingestion_runs`)
- Status-mapping editor + unmapped-status queue

### RichPanel
- Read-only, API-key auth
- `GET /api/richpanel/orders/:orderNumber` → current status, tracking
  URL(s), carrier, ETA summary

### Klaviyo (outbound)
Events:
- `shipment.shipped` (first `LABEL_CREATED`/tracking assigned)
- `shipment.in_transit` (once when reaching `IN_TRANSIT` / rank ≥ 40 — matches Narvar)
- `shipment.out_for_delivery`
- `shipment.delivered`
- `shipment.delivery_attempt_failed` — kept distinct from generic exception, matching Narvar's live flow split (§4)
- `shipment.exception`
- `shipment.stalled`

Payload includes: email, order number, tracking page URL, carrier, tracking
number/URL, EDD (now available directly from the Tracking API's `edd` field
— previously had to be inferred), item names/images, destination country.

`dedupe_key = {shipment_id}:{event_type}`. Unique constraint on
`notification_log.dedupe_key` means a customer can't get two "shipped"
emails for the same parcel even under concurrent workers.

---

## 7. Front ends

### Customer tracking page
- Mobile-first; signed token in the path, not a query string
- Order #, status, plain-English copy, progress UI (driven by `status_rank`,
  not a hardcoded step list, so a mapping change moves the bar without a
  frontend release), full history
- Split shipments as separate parcels + their items (FR3.5)
- Carrier name, tracking #, link to carrier site, plus ShipBob's own
  `tracking_url` when available
- City/country only (no full address)
- Lookup form for lost links
- Non-alarming copy for exceptions/delays with a support link (FR3.6)
- `noindex` (FR3.7)
- Shows last-known status + timestamp instead of an error if data is stale

### Admin (Vue)

**Dashboard** — sync health per source (last run, last success, error
count), shipment counts by internal status, exceptions/stalled shortlist,
unmapped-status count.

**Shipments list** — the primary CS working view. Filter tabs with live
counts (`All / Exception / Stalled / Out for delivery / In transit /
Delivered / Cancelled`); single search box that infers order #/email/
tracking # (FR6.1); filters for status, carrier, source, destination,
created date. Row shows carrier + tracking number, status pill + latest
event description/location/time, `is_stalled` as a **separate** chip beside
the status pill (never replacing it — the parcel is still `IN_TRANSIT`).

**Shipment detail** (slide-over or page — implementation's choice) —
Timeline (customer-visible events), Raw events (every `tracking_events`
row incl. unmapped, `raw_status`/`raw_substatus_code`/`occurred_at` vs
`received_at`), API calls (if `api_call_log` has matches), Notifications
(`notification_log` + Replay button). Actions: re-sync, TrackingMore
retrack, replay Klaviyo event, copy customer tracking link — all audited.

**Status-mapping editor** — `status_mappings` table + unmapped-status queue
with one-click "map to…" (closes the loop with §3.2's "never silently drop"
rule).

**User management (admin-only)** — invite by email + role, list/disable/
re-enable, role change, self-lockout guard, audit log for every action.

**Version display** — footer shows `v{package.json} · {git SHA} ·
{deployed timestamp}`, from `GET /admin/version`, baked into the Docker
image at build time.

---

## 8. Phased delivery

### Phase 0 — Foundations (week 1)
- Repo scaffold: Node API, Vue admin, Docker Compose (Postgres, Redis, API, worker, admin)
- Migrations for §3.2 schema
- Config/secrets pattern; wrapped HTTP client with basic logging
- Admin auth: login, invite-based creation, roles, audit log — first thing built, everything else sits behind it
- `carriers` + `status_mappings` seed data from §13's live tables
- `GET /admin/version` + version footer wired to CI build args
- CI pipeline: test → build → tag Docker images with git SHA
- Phase 0 check: confirm `HasTracking`/`IsTrackingUploaded` behaviour on the **current** PAT (informational only — §5.1 doesn't depend on the answer)
- **Exit:** `docker compose up` runs API + worker + DB locally; can log into an empty admin shell and invite a second user

### Phase 1 — ShipBob MVP (weeks 2–3)
- `shipbob.orders.sync` + `shipbob.tracking.poll` (§5.1), upsert orders/shipments/items/events
- Status normaliser with tiebreak + sticky terminals (§4)
- Public tracking page by token; order lookup
- Admin search + timeline view
- **Exit:** a domestic ShipBob order shows a live-ish timeline on our own domain (poll lag ≤ 30 min), sourced entirely from the new Tracking API

### Phase 2 — KLB + TrackingMore (weeks 3–4)
- KLB shipping-order poll; register + poll TrackingMore
- Carrier mapping (DHL eCommerce ~88% of KLB volume, USPS/Stamps ~12%, edge cases)
- Retrack from admin
- **Exit:** international KLB order has timeline parity with the Narvar samples tested in discovery

### Phase 3 — Notifications + RichPanel (week 5)
- Klaviyo emitter + dedupe + notification log (including the failed-attempt vs exception split, §6)
- Stalled job
- RichPanel read-only endpoints
- Switch off duplicate shipping emails at cutover checklist
- **Exit:** a status change produces one correct Klaviyo event; RichPanel can fetch tracking links

### Phase 4 — Parallel run + cutover (week 6+)
- Run alongside Narvar; spot-check status accuracy daily
- Point Klaviyo/transactional links to new tracking URLs
- Plan Narvar old-link grace/redirect
- Keep Narvar one billing period as rollback
- **Exit:** Narvar no longer customer-facing; WISMO stable

### Phase 5 — Hardening / analytics (post-cutover)
- Delivery performance reports off `tracking_events`
- Better monitoring/alerts; `api_call_log` partitioning if debugging volume justifies it
- Retention cleanup
- Optional: ShipBob webhooks if polling ever stops being enough headroom (unlikely given §5.1's margins)

---

## 9. Non-functional requirements (build targets)

- Tracking page < 2s on mobile; reads Postgres/cache only
- Status freshness ≤ 30 minutes
- Idempotent jobs; safe to overlap with lock keys
- Structured logs; alert on job failure / lag > 2 intervals / ShipBob remaining-calls header trending low
- PII minimised on public responses; no PII in URL query strings
- All traffic over HTTPS
- GDPR: tracking records deletable/anonymisable on request; retention period and lawful basis documented alongside §3.3
- **Availability target:** the brief implies 99.9%; on a single-VPS deploy (no load balancer, no second host) that's an honest stretch — 43 min/month has to cover patching, restarts, and deploys. Recommend **99.5%** (~3.6h/month) as the stated target unless the hosting decision changes, and use an external uptime check (an internal one tells you nothing when the host itself is down).

---

## 10. Testing plan

- Unit: status mapping, rank tiebreak, sticky terminals, `event_hash`
  stability, dedupe keys, token auth, lookup validation
- Integration: ShipBob Tracking API against real sample IDs (§13); KLB +
  TrackingMore with known sample trackings from discovery
- Cases: split shipments; tracking number changed; delivered-before-
  in-transit ordering; two events with identical timestamps (confirmed to
  occur live); duplicate poll (same `history[]` returned twice); stalled;
  cancelled; USPS lag / retrack; comma-vs-repeated-param batch query
  regression (§5.1)
- Load: public page cache under 2–4 views/order assumption
- Parallel-run diff report vs Narvar for a sample of ShipBob + KLB orders

---

## 11. Ops & ownership

| Area | Notes |
| :---- | :---- |
| Hosting | Single VPS or small container host (API + worker + Postgres + Redis) |
| Secrets | ShipBob, KLB, TrackingMore, Klaviyo, RichPanel, DB |
| On-call | Job failures, sync lag, TrackingMore quota/auth errors |
| Maintenance | Carrier mapping tweaks, stalled threshold, catalog updates — expect light monthly touch after stable |

### 11.1 Git-based deployment
- Single git repo (monorepo: `api`, `worker`, `admin`), `main` deployable at all times
- Semver tags; CI builds + tags Docker images with git SHA on push to `main`
- Deploy = pull tagged image(s), `docker compose up -d`; no build-on-server
- Version/SHA baked into the image at build time so `/admin/version` matches exactly what's running
- Rollback = redeploy previous tag
- `.env`/secrets outside the repo, injected at deploy time
- Migrations run as an explicit pre-start step, not implicit on boot

---

## 12. Open config (not blockers)

| Item | Proposed default |
| :---- | :---- |
| Poll interval | 15 min |
| Stalled threshold | 7 days without new event (brief suggests 5–7, TO CONFIRM) |
| Peak-season poll/queue multiplier | design for 2–3x normal volume until confirmed |
| Public address detail | City + country only |
| Tracking token | random 32+ bytes, stored hashed |
| Tracking token expiry | none initially, or long-lived (12 months) — TO CONFIRM |
| Event retention | 24 months |
| Raw payload retention | 30 days |
| Notification batching | per parcel vs once per order for split shipments — TO CONFIRM (FR5.3) |
| SMS via Klaviyo | in/out of scope — TO CONFIRM (FR5.4) |
| Tracking domain | e.g. `track.ourdomain.com` — TO CONFIRM (FR3.1) |
| Multi-language tracking page | TO CONFIRM which languages, if any (FR3.8) |

---

## 13. Discovery outcomes that shape the plan

- ShipBob: order + recipient email + products (SKU) + **Tracking API**
  (status codes, full history, EDD, tracking URL, last-mile carrier, POD,
  rich exception text) — no aggregator needed for ShipBob parcels.
- KLB: order + customer email + items + tracking/carrier — **no timeline**;
  TrackingMore required.
- KLB carriers ≈ DHL eCommerce (~88%) + Stamps/USPS (~12%); TrackingMore
  covers both (USPS may need retrack/longer first sync).
- WooCommerce can be skipped if a local product catalog supplies titles/images.
- Polling-only is enough for the 30-minute freshness goal, and the batch
  Tracking API makes that true with wide margin (§5.1).

**Live Tracking API sample (5 days, 22–26 Jul 2026, 5,022 tracked ShipBob
shipments, 27,572 history events)** — raw data in
`examples/analysis-summaries/shipbob-tracking-api-5d-*.csv`:

| Current status | Count | % |
| :---- | ---: | ---: |
| Delivered | 2,008 | 40.0% |
| InTransit | 1,577 | 31.4% |
| PreTransit | 1,371 | 27.3% |
| OutForDelivery | 38 | 0.8% |
| DeliveryAttemptFailed | 16 | 0.3% |
| Exception | 6 | 0.1% |
| AvailableForPickup | 4 | 0.1% |
| DeliveryException | 2 | 0.04% |

| History event status | Count | % of events |
| :---- | ---: | ---: |
| InTransit | 17,820 | 64.6% |
| PreTransit | 5,471 | 19.8% |
| OutForDelivery | 2,214 | 8.0% |
| Delivered | 2,008 | 7.3% |
| DeliveryAttemptFailed | 34 | 0.12% |
| DeliveryException | 12 | 0.04% |
| Exception | 8 | 0.03% |
| AvailableForPickup | 5 | 0.02% |

Top substatus codes seen (seed for `status_mappings`): `InTransit_002`
(Arrival scan), `InTransit_004` (Departure Scan), `InTransit_001` (In
Transit), `InTransit_017` (Carrier Picked up), `PreTransit_005` (Info
Received), `OutForDelivery_001`, `Delivered_001`, `DeliveryAttemptFailed_001`,
`DeliveryException_001` (Incomplete/incorrect address), `Exception_005`
(Shipping Exception — no access).

Exception text quality confirmed rich enough for specific Klaviyo copy on a
meaningful subset: SpeedX address issues ("Parcel received but with
incorrect address… contact customer service"), UniUni failed-attempt
return-to-warehouse notices, Amazon Shipping generic `DeliveryAttempted`,
and dated redelivery-schedule messages ("Redelivery is Scheduled on July
28, 2026"). Consistent with the ~half-generic finding in
`docs/klaviyo-event-research.md`.

Carrier mix in the tracked sample: Amazon Shipping 32.7%, SpeedX 20.0%,
UniUni 16.8%, OSMWorldwide 11.4%, Cirro 7.1%, USPS 5.8%, OnTrac 3.7%,
BetterTrucks 2.3%, others (FedEx/DhlEcs/UPS) <0.3%.

---

## 14. Immediate next build steps

1. Create app monorepo / service folders (`api`, `worker`, `admin`).
2. Docker Compose + Postgres schema migrations (§3.2).
3. Implement `shipbob.orders.sync` + `shipbob.tracking.poll` end-to-end with one real order on the tracking page.
4. Add admin list/detail.
5. Then KLB → TrackingMore path.

---

## 15. Risks & assumptions (brief §12 ask)

- **WooCommerce skip (§0.1):** orders that never reach ShipBob/KLB won't appear in the hub. If CS needs those in the same tool, we'd need a thin Woo read for order-status-only, or accept CS uses Woo directly.
- **No product images from warehouses:** ShipBob/KLB give SKU + description only. Local `products` catalog needs a real source — not yet decided.
- **Polling-only latency:** comfortably inside the 30-min SLA with the new batch Tracking API (§5.1); ShipBob webhooks stay a Phase 5 option, not a near-term need.
- **TrackingMore USPS lag:** confirmed working, but first sync can be slow and occasionally needs a manual `retrack`. Build the admin retrack action early.
- **TrackingMore plan limits:** free tier hit both quota and read-permission limits during testing. Production plan must be sized to KLB's ~2,300 trackings/month before Phase 2.
- **ShipBob PAT scope drift:** the Tracking API needed a regenerated PAT — the old key worked for orders but 401'd on tracking. If credentials rotate again, re-test both `/order` and the Tracking API, not just one (§1).
- **Batch query format:** comma-separated `ShipmentIds` returns 400 despite doc wording; must use repeated params. Covered in tests (§10) so a client-library upgrade can't silently regress this.
- **Peak multiplier, retention period, notification batching, SMS scope, tracking domain, and multi-language support are all still `[TO CONFIRM]`** per the brief — defaulted in §12, confirm before Phase 3/4.
- **Historical Narvar data:** brief asks whether historical tracking needs exporting before cancelling Narvar — check contract/export rights before Phase 4.
- **Old Narvar links in customer inboxes:** need a redirect/grace-period plan before cutover, or expect a support-ticket spike.

---

## 16. Success criteria (from brief, mapped)

1. Every ShipBob + KLB order has a branded tracking page on our domain.
2. Status updates visible within 30 minutes.
3. Narvar cancelled with no WISMO spike.
4. CS can look up full history in admin.
5. RichPanel receives tracking links via API.
6. Klaviyo receives correct, deduped shipment events.
