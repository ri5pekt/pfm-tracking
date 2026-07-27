# Klaviyo notification events — current state, available data, and expansion options

Researched 27 July 2026. Based on: current live Klaviyo flows (screenshot from
Klaviyo dashboard), and a live ShipBob data pull of **17,752 shipments across
13 consecutive days** (15–26 Jul 2026), plus full timeline text for all **113
exception-flagged** shipments in that set, and a 100-shipment timeline lifecycle
sub-sample from earlier testing.

---

## 1. Currently live Klaviyo flows (today, via Narvar)

From the Klaviyo flow list provided:

| Flow | Likely maps to |
| :---- | :---- |
| Narvar - Received Delivery (2025) | `DELIVERED` (naming is Narvar's; confirm exact trigger before rebuilding — could mean "delivered" or an order-received confirmation) |
| Narvar - Out for Delivery (2025) | `OUT_FOR_DELIVERY` |
| Narvar - In Transit (2025) | `IN_TRANSIT` |
| Narvar - Failed Delivery Attempt (2025) | Carrier delivery-attempt-failed event |
| Narvar - Delivery Exception (2025) | Generic carrier/delivery exception |

So today there are **5 live flows**, and they already split "exception" into two buckets (failed attempt vs. generic exception) rather than treating all problems as one email — worth preserving that distinction in the new system.

This is a superset of the brief's FR5.1 list (`shipped`, `out_for_delivery`, `delivered`, `exception`, `stalled`) — Narvar doesn't appear to send a "shipped" (label created) email today, and the brief's `stalled` doesn't have a Narvar equivalent live flow. **Failed Delivery Attempt** is live in Klaviyo today but isn't in the brief's FR5.1 list at all — worth adding it explicitly as its own event rather than folding it into generic `exception`.

---

## 2. What event types ShipBob actually gives us

Three different granularities exist in the ShipBob API, each useful for a different purpose:

### 2a. Top-level shipment `status` (coarse — order list endpoint)

Sample: **17,752 shipments**, 13 consecutive days (15–26 Jul 2026).

| Status | Count | % |
| :---- | ----: | ----: |
| Completed | 16,410 | 92.4% |
| Processing | 1,083 | 6.1% |
| LabeledCreated | 194 | 1.1% |
| Cancelled | 58 | 0.3% |
| OnHold | 7 | 0.04% |

Too coarse for notifications — `Completed` just means "ShipBob finished fulfilling," not delivered.

### 2b. `status_details` (fine-grained current state — same order pull, no extra calls)

Same **17,752-shipment** sample:

| `status_details.name` | Description | Count | % of sample |
| :---- | :---- | ----: | ----: |
| Delivered | Shipment Delivered | 13,149 | 74.1% |
| InTransit | Shipment In Transit | 1,794 | 10.1% |
| Processing | Waiting For Carrier Pickup | 1,269 | 7.2% |
| *(none)* | — | 1,005 | 5.7% |
| Picked | Picking Completed | 330 | 1.9% |
| OutForDelivery | Shipment Out For Delivery | 84 | 0.5% |
| **DeliveryAttemptFailed** | Delivery Attempt Failed | **66** | **0.37%** |
| **DeliveryException** | OrderTracking contains CatchAll date | **47** | **0.26%** |
| Manual | Manual | 7 | 0.04% |
| Packed | Packing Completed | 1 | 0.01% |

Exception rate combined: **113 / 17,752 ≈ 0.64%**.

This field is essentially free (comes back on the same order-list call) and is the cheapest way to detect "this shipment currently has a problem" across a large volume without calling `/timeline` on everything.

Carrier mix in the same sample (for context):

| Carrier | Shipments |
| :---- | ----: |
| Amazon Shipping | 4,884 |
| SpeedX | 3,624 |
| UniUni | 2,826 |
| OSMWorldwide | 1,733 |
| Cirro | 1,580 |
| *(no tracking yet)* | 1,148 |
| USPS | 894 |
| OnTrac | 645 |
| BetterTrucks | 358 |
| Other (DHL ECS, FedEx, UPS, freight) | 60 |

### 2c. `/shipment/{id}/timeline` (full event history — one call per shipment)

Sample: 100 randomly selected `Completed` shipments, full lifecycle, 962 events total:

| Event (`log_type_name`) | Seen in sample | % of the 100 shipments |
| :---- | ----: | ----: |
| Inserted (Shipment Created) | 100 | 100% |
| Allocated (Inventory Allocated to FC) | 100 | 100% |
| Labeled (Label Created) | 100 | 100% |
| Packed (Packaged) | 100 | 100% |
| Validated (Label Validated) | 100 | 100% |
| Picked | 100 | 100% |
| InTransit | 93 | 93% |
| Shipped (Order Shipped) | 92 | 92% |
| Delivered | 89 | 89% |
| OutForDelivery | 88 | 88% |

(The gaps below 100% are shipments still in flight or where the carrier feed skipped a discrete scan — e.g. some carriers don't emit a separate `InTransit`/`OutForDelivery` scan before `Delivered`.)

### 2d. `/shipment/{id}/logs` (operational detail — richer than timeline, includes metadata)

Not in the brief, but directly relevant to your root-cause question. On the two
exception shipments inspected, `/logs` included events `/timeline` doesn't
surface at all:

- **`AddressChangeDetail`** — full before/after address, e.g. `from: "1805 Copley Place..."` → `to: "1805 Copley Pl..."` — shows exactly what was corrected and by whom (`user_name: "System User"` for auto-normalization). **Contains customer PII (name, email, phone) — internal/CS use only, never surface on the public tracking page or in a Klaviyo payload.**
- **`OrderMovedToPending`** — "Order moved from Exception to Pending" — reveals a **pre-shipment** fulfillment exception (e.g. address had to be corrected before ShipBob could even ship it), distinct from the post-shipment carrier exception. Both of the address-correction cases we found also later hit a *carrier-side* delivery exception — suggesting address-quality issues are a real recurring root cause worth flagging to customers/ops before shipment, not just after.
- **`SlaExtended`** — has a structured `reason` field (e.g. `"Holiday"`).

**Recommendation:** admin/CS view should pull `/logs` in addition to `/timeline` for any shipment currently in `EXCEPTION`/`STALLED` — it's the only place the address-correction history and structured SLA reasons live.

---

## 3. Can we tell customers *why* an exception happened instead of a generic message?

**Yes for a meaningful subset — with a pattern matcher on timeline text.**
Larger sample: all **113** exception-flagged shipments from the 17,752 set had
their `/timeline` exception/failed-attempt texts pulled.

### 3a. Exception category frequency

| `status_details.name` | Count | % of all shipments | % of exceptions |
| :---- | ----: | ----: | ----: |
| DeliveryAttemptFailed | 66 | 0.37% | 58% |
| DeliveryException | 47 | 0.26% | 42% |
| **Total** | **113** | **0.64%** | 100% |

By carrier (exception-flagged only):

| Carrier | AttemptFailed | Exception | Total |
| :---- | ----: | ----: | ----: |
| UniUni | 32 | 0 | 32 |
| SpeedX | 12 | 21 | 33 |
| OSMWorldwide | 4 | 10 | 14 |
| Amazon Shipping | 8 | 3 | 11 |
| Cirro | 0 | 7 | 7 |
| USPS | 4 | 4 | 8 |
| OnTrac | 4 | 2 | 6 |
| BetterTrucks / UPS | 2 | 0 | 2 |

### 3b. Exact timeline texts (all exception events found)

| Count | Event | Exact `log_type_text` | Suggested customer email bucket |
| ----: | :---- | :---- | :---- |
| 24 | DeliveryException | *Shipment Delivery Exception* | Generic delay |
| 18 | DeliveryAttemptFailed | *The delivery attempt failed will be returned to the UniUni warehouse* | Failed attempt / may return |
| 8 | DeliveryAttemptFailed | *Undeliverable* | Generic undeliverable |
| 7 | DeliveryAttemptFailed | *Attempted Delivery: No access. The package is undeliverable and schedule to redelivery* | **Access issue — contact us** |
| 7 | DeliveryAttemptFailed | *DeliveryAttempted* | Failed attempt (generic) |
| 6 | DeliveryAttemptFailed | *Delivery rescheduled for 2nd delivery attempt* | Reattempt scheduled |
| 4 | DeliveryAttemptFailed | *Delivery attempted* | Failed attempt (generic) |
| 3 | DeliveryAttemptFailed | *Attempted Delivery: Building Closed/Weekend/Holiday... Redelivery is Scheduled on …* | **Business closed / holiday — reattempt** |
| 2 | DeliveryAttemptFailed | *The driver tried to deliver… business was closed… reattempt up to 3 times* | **Business closed — reattempt** |
| 2 | DeliveryAttemptFailed | *Redelivery Scheduled for Next Business Day* | Reattempt scheduled |
| 1 | DeliveryAttemptFailed | *Attempted Delivery: Invalid Address. Missing Apartment# / Suite#…* | **Wrong/incomplete address — confirm** |
| 1 | DeliveryAttemptFailed | *…lack of an access code. Please contact us…* | **Access code needed — contact us** |
| 1 | DeliveryAttemptFailed | *Notice Left (Receptacle Full/Item Oversized)* | Receptacle full / oversized |
| 1 | DeliveryAttemptFailed | *Attempted Delivery: Vehicle breakdown… Redelivery is Scheduled…* | Carrier delay / reattempt |
| 1 | DeliveryAttemptFailed | *Rejected* | Rejected |
| 1 | DeliveryAttemptFailed | *Reminder to Schedule Redelivery of your item* | Action needed: schedule redelivery |
| 1 | DeliveryAttemptFailed | *We're sorry but we were unable to complete your delivery…* | Generic failed attempt |
| 1 | DeliveryAttemptFailed | *We tried to deliver to the business, but it was closed…* | **Business closed — reattempt** |
| 1 | DeliveryAttemptFailed | *Package Delivery Attempted* | Failed attempt (generic) |

### 3c. Actionable buckets we can actually email on

Grouping the specific texts into customer-facing reasons:

| Proposed email reason | Approx. count in sample | Example carrier text |
| :---- | ----: | :---- |
| Generic exception / delay | 24 | *Shipment Delivery Exception* (always this exact string) |
| Failed attempt — returning to warehouse | 18 | UniUni warehouse return |
| Failed attempt — generic / undeliverable | ~20 | *Undeliverable*, *DeliveryAttempted*, *Delivery attempted* |
| **No access / access code needed** | 8 | *No access*, *lack of an access code* |
| **Business closed / weekend / holiday** | 6 | *Building Closed/Weekend/Holiday*, *business was closed* |
| Reattempt already scheduled | 8 | *2nd delivery attempt*, *Redelivery Scheduled* |
| **Wrong / incomplete address** | 1 | *Invalid Address. Missing Apartment# / Suite#* |
| Receptacle full / oversized | 1 | *Notice Left (Receptacle Full/Item Oversized)* |
| Action needed: schedule redelivery | 1 | *Reminder to Schedule Redelivery* |
| Rejected | 1 | *Rejected* |
| Carrier operational (vehicle breakdown) | 1 | *Vehicle breakdown* |

### Conclusion
- **`DeliveryException`** is still always the identical generic string (*Shipment Delivery Exception*) — never a root cause. Keep as generic "there's a delay."
- **`DeliveryAttemptFailed`** often has usable free-text — enough to support several specific emails beyond generic exception:
  1. **No access / access code** (~8 in this window)
  2. **Business closed** (~6)
  3. **Wrong/incomplete address** (rare but real — 1 clear hit)
  4. **Reattempt scheduled** (~8) — reassuring, different tone
  5. **Returning to warehouse** (UniUni pattern, 18) — different customer action
- Build a **text-pattern classifier** on `log_type_text` (config table, not hardcoded) that upgrades to a specific Klaviyo event when matched, else falls back to generic failed-attempt / exception.
- Don't promise a reason on every exception — roughly **~half** of exception timeline texts in this sample are still generic.
- For KLB/TrackingMore (USPS), earlier testing already showed specific reasons like *Insufficient Address* → return to sender — keep that path in the same classifier.

---

## 4. Proposed event set (superset of brief's FR5.1 + what's live today + what's newly possible)

| Event | Status today | Source | Notes |
| :---- | :---- | :---- | :---- |
| `shipment.shipped` | In brief, not confirmed live in Klaviyo screenshot | ShipBob `Shipped` / KLB ship date | Add if not already live |
| `shipment.in_transit` | Live today (Narvar - In Transit) | ShipBob `InTransit` / TrackingMore | Keep |
| `shipment.out_for_delivery` | Live today | ShipBob `OutForDelivery` / TrackingMore | Keep |
| `shipment.delivered` | Live today (as "Received Delivery"?) | ShipBob `Delivered` / TrackingMore | Confirm naming/trigger with Klaviyo flow owner |
| `shipment.delivery_attempt_failed` | **Live today, not in brief's FR5.1 list** | ShipBob `DeliveryAttemptFailed` | Keep as its own event — don't merge into generic exception |
| `shipment.exception` | Live today | ShipBob `DeliveryException`, TrackingMore exception | Generic fallback copy |
| `shipment.exception.address` | **New, proposed** | Text match: invalid/missing apartment, insufficient address | "Please confirm your address" |
| `shipment.exception.no_access` | **New, proposed** | Text match: no access, access code | "Please provide access / gate code" |
| `shipment.exception.business_closed` | **New, proposed** | Text match: business closed, weekend/holiday | "We'll reattempt next business day" |
| `shipment.exception.returning` | **New, proposed** | Text match: returned to warehouse / RTS | "Package returning — contact us" |
| `shipment.reattempt_scheduled` | **New, proposed** | Text match: redelivery scheduled / 2nd attempt | Reassuring, different tone |
| `shipment.returned_to_sender` | **New, proposed** | TrackingMore RTS events | Distinct end-state |
| `shipment.stalled` | Not live; in brief | System-derived (no event N days) | New, system-computed |

---

## 5. Data files

Raw sampled data saved for reuse:
- `analysis/shipbob-large-shipments.jsonl` — **17,752** shipments (15–26 Jul 2026), status + status_details + carrier
- `analysis/shipbob-large-exceptions.jsonl` — **113** exception-flagged rows from that set
- `analysis/shipbob-large-exception-texts.json` — timeline exception/failed-attempt texts for those 113
- `analysis/shipbob-large-summary.json` — aggregated counts
- `analysis/shipbob-clean-events.json` — 962 timeline events from 100 completed shipments (lifecycle mix)
- `analysis/shipbob-sample-shipments.json` — earlier smaller 2,640-shipment stratified sample (superseded for frequencies)

Sample size note: 17.7k shipments over ~2 weeks is enough for stable status-mix
and exception-rate estimates (~0.64%). Exception *reason* buckets with only 1–8
hits (address, receptacle full, etc.) are directionally useful but still thin —
treat those specific email flows as v1 experiments, not high-volume paths.
