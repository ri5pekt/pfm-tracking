# KLB customer email backfill — dev plan

**Status: implemented and deployed 2026-08-11.** Backfill ran clean: `2202/2203` found,
`0` errors, `1` order genuinely not found in `customer-orders`. First live Klaviyo `sent`
(vs `suppressed`) event for a KLB shipment confirmed within the hour.

## Background

Investigated 2026-08-10/11 while debugging order 4049748 (stuck tracking + zero Klaviyo
events). Two independent bugs were found:

1. **`trackingmore.poll` starvation** — fixed, see `009_shipments_last_polled_at.sql` +
   `api/src/integrations/trackingmore/poll.ts` (fair round-robin ordering by
   `last_polled_at`). Already deployed and verified in prod.
2. **KLB orders have no `customer_email`, so every Klaviyo notification for them is
   silently suppressed** — this doc. Confirmed live in prod:
   - `2203 / 2203` orders with a KLB (`aggregator = 'trackingmore'`) shipment have
     `customer_email IS NULL`.
   - `5,526` rows in `notification_log` for KLB shipments, **all** `status = 'suppressed'`,
     `payload->>'suppressReason' = 'missing_email'`. Zero ever sent.

## Root cause

KLB ingestion (`api/src/integrations/klb/client.ts` + `ingest.ts`) only ever calls the
**legacy shipping-orders endpoint**:

```
GET https://app.zenventory.com/services/rest/shippingorders
```

which is the *only* Zenventory resource with shipment/tracking data (tracking number,
carrier, shipped state) — but its response has no customer email field at all (verified:
customer is `{ name, surname }` only; `shippingaddress` has `phone` but no email).

Zenventory has a **second, separate resource**, `customer-orders` (REST API, Basic auth
via `KLB_API_KEY` / `KLB_API_SECRET` — already present in prod `.env`, never wired into
ingestion):

```
GET https://app.zenventory.com/rest/customer-orders?orderNumber=<order_number>
```

Verified live (2026-08-11) against real orders (2490386, 4049748, etc.): returns
`customer.email` directly, plus `orderNumber` matching the same key our `orders` table
already uses.

**This is not a single-endpoint consolidation.** Confirmed the full `customer-orders`
payload for order 4049748 has **no** `shipments` / tracking fields whatsoever — it's the
pre-fulfillment order record (customer, addresses, items, order source), while
`shippingorders` is the post-fulfillment shipment record (tracking number, carrier,
shipped date). Zenventory splits these into two resources; there is no way to get both
tracking data and email from one call. `shippingorders` stays the primary sync source;
`customer-orders` is a secondary, email-only lookup.

## Decisions (confirmed with user 2026-08-11)

- **No replay of the 5,526 historically-suppressed notifications.** Once an order's email
  is backfilled, we do not synthesize catch-up Klaviyo events for its past history —
  notifications only fire for *new* status changes from that point on.
- **Backfill existing orders too**, not just new ones going forward — one-time script for
  the 2203 orders currently missing email.
- **Fetch strategy: only call `customer-orders` when `orders.customer_email IS NULL`.**
  Self-limiting — after the one-time backfill, only genuinely new KLB orders need the
  extra call each `klb.sync` cycle. Confirmed no rate-limit headers and no throttling
  across 5 rapid sequential calls (~340–430ms each), but we still shouldn't call it
  unconditionally on every candidate every 20 minutes forever.

## Implementation

### 1. `KlbClient` — new method

Add to `api/src/integrations/klb/client.ts`:

```ts
async getCustomerOrderEmail(orderNumber: string): Promise<string | null>
```

- `GET {KLB_API_BASE}/customer-orders?orderNumber=<orderNumber>` (note: this hits the
  *modern* `/rest` base directly, not `legacyBase()` — different auth + different path
  than `shippingorders`).
- `Authorization: Basic base64(KLB_API_KEY:KLB_API_SECRET)`.
- Parse `body.customerOrders?.[0]?.customer?.email`, trim, return `null` if empty/absent.
- Route through `loggedFetch` (`integration: 'klb'`, `operation: 'get_customer_order_email'`)
  like the existing method — `api_call_log` doesn't persist bodies, so no extra PII
  exposure risk from logging.
- Treat non-200 / network errors as a soft failure (return `null`, don't throw) — this is
  an enrichment lookup, must never break the main `klb.sync` shipment ingestion path.

### 2. Wire into `klb.sync` ingestion

In `api/src/integrations/klb/ingest.ts` (`ingestKlbShipment`), after the existing
`upsertOrder` call:

- Only if the order is newly created *or* its `customer_email` is still `NULL` (need a
  cheap check — either read back from `upsertOrder`'s result, or add an optional
  `needsEmail` flag to its return value, or just re-check when `created === true` /
  do a targeted `SELECT customer_email FROM orders WHERE id = $1` for existing orders
  before deciding to call out).
- Call `klb.getCustomerOrderEmail(orderNumber)`.
- If it returns an email, call `upsertOrder` again (or a lighter dedicated
  `UPDATE orders SET customer_email = COALESCE(customer_email, $2) WHERE id = $1`) —
  `COALESCE` already makes this safe/idempotent against concurrent writes.
- Failures are non-fatal — log and continue; a `NULL` email just means we retry next
  cycle since the row still qualifies as "missing".

Keep this on the "candidates" path only (not the TrackingMore enrichment path) — it's an
order-level, not shipment-level, concern.

### 3. One-time backfill script

New `scripts/backfill-klb-emails.ts`:

- `SELECT DISTINCT o.id, o.order_number FROM orders o JOIN shipments s ON s.order_id = o.id WHERE s.source = 'klb' AND o.customer_email IS NULL`
- Loop with modest concurrency (e.g. concurrency 5, or serial — 2203 orders × ~350ms
  serial ≈ 13 minutes, acceptable for a one-off; keep serial unless that's too slow, to
  stay conservative against an undocumented rate limit).
- For each: call `getCustomerOrderEmail`, `UPDATE orders SET customer_email = $2 WHERE id = $1 AND customer_email IS NULL` when found.
- Log a summary: `{ total, found, notFound, errors }`.
- Run manually on prod once (`docker compose -f docker-compose.prod.yml run --rm jobs scripts/backfill-klb-emails.ts`), not scheduled.

### 4. Tests

- `KlbClient.getCustomerOrderEmail` — unit test with mocked `fetch` (found / not-found /
  malformed / error cases).
- `ingestKlbShipment` — test that email lookup is skipped when `customer_email` already
  set, and populated when missing (mock the client).

### 5. Deploy checklist

- No schema migration needed (`orders.customer_email` already exists).
- Ship code changes → rebuild `api` + `worker` images → restart.
- Run the one-time backfill script on prod.
- Verify: re-run the same production queries from the 2026-08-10 investigation
  (`orders` with KLB shipment × `customer_email IS NULL` count should drop from 2203
  toward 0; new `notification_log` rows for KLB shipments should start showing
  `status = 'sent'` instead of 100% `suppressed`).

## Open follow-ups (not blocking this plan)

- `shipbob.tracking.poll` is currently `lagging` in `/health/ops` due to ShipBob's v1
  `listOrders` API returning `410 api_version_deprecated` (hard cutoff **2026-08-31**) —
  separate, unrelated issue surfaced during this investigation; needs its own plan before
  the cutoff.
- Consider recording *where* an order's email came from (ShipBob vs KLB `customer-orders`
  backfill) if that's ever useful for support/debugging — not required for v1 of this fix.

## References

- `docs/research/warehouse-api-discovery.md` — original KLB/Zenventory endpoint discovery
  (documents `customer-orders` existed but was never wired in)
- `api/src/integrations/klb/client.ts`, `ingest.ts`
- `api/src/domain/notifications.ts` (`missing_email` suppression path)
- `plans/phase-2-klb-trackingmore.md`
