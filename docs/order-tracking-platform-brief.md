# Development Brief: In-House Order Tracking Platform

**Prepared for:** Development team **Status:** Draft v1 — sections marked `[TO CONFIRM]` need a business decision before build starts **Date:** July 2026

---

## 1\. Background and purpose

We currently use Narvar as our post-purchase order tracking platform. We want to replace it with a system we own and operate ourselves.

**Reasons for building in-house:**

- Remove the recurring Narvar subscription cost  
- Full control over branding, layout and messaging on the tracking experience  
- Own our shipment data rather than renting access to it  
- Freedom to add features (upsells, support links, delivery feedback) without vendor limitations

**What Narvar currently does for us that must be replaced:**

| Narvar capability | Must replace in v1? |
| :---- | :---- |
| Branded tracking page customers land on | Yes |
| Order lookup ("where is my order?" form) | Yes |
| Normalised tracking statuses across carriers | Yes |
| Proactive shipping notification emails | Yes — but sent from Klaviyo, not built into this system. See §6.5 |
| SMS notifications | Yes — but sent from Klaviyo, not built into this system. See §6.5 |
| Delivery performance reporting | Phase 2 |

---

## 2\. Goals and success criteria

The project is successful when:

1. Every customer order — domestic and international — has a working, branded tracking page hosted on our own domain.  
2. Tracking status updates appear on that page within **30 minutes** of the carrier event.  
3. Narvar can be cancelled with no gap in customer experience and no increase in "where is my order?" (WISMO) support tickets.  
4. Customer service can look up any shipment's full status history from an internal view.  
5. RP can integrate and receive the tracking links to show on their widget

---

## 3\. The critical decision to resolve first

**Read this section before estimating.**

Our two order flows give us very different quality of tracking data:

**Flow A — ShipBob-fulfilled orders.** ShipBob's API gives us both the tracking number *and* ongoing status updates (`InTransit`, `OutForDelivery`, `Delivered`, exceptions). This flow is largely self-sufficient — we do not need a carrier integration for it.

**Flow B — Foreign orders, tracking pushed into WooCommerce.** Here we typically receive only a **tracking number and a carrier name**. There is no status feed. A tracking number on its own cannot power a tracking page — something has to convert that number into live status events.

There are three options for Flow B. We need the development team to recommend one:

| Option | What it means | Trade-off |
| :---- | :---- | :---- |
| **B1. Link-out only** | Show the tracking number as a clickable link to the carrier's own website. No status timeline on our page. | Free and quick. Poor customer experience; will not fully replace Narvar for international customers. |
| **B2. Direct carrier integrations** | Integrate individually with each carrier's tracking API (Royal Mail, DHL, Australia Post, Canada Post, etc.). | Truly no third party. Significant build and ongoing maintenance; each carrier needs its own account, credentials, and quirks. Realistically only viable if we ship via 2–3 carriers internationally. |
| **B3. Carrier data aggregator** | Use a data-only tracking API (e.g. EasyPost, Shippo, TrackingMore, 17TRACK) that normalises hundreds of carriers behind one endpoint. | Still a third party, but a commodity data supplier at a fraction of Narvar's cost, and it does not own our customer experience or branding. Fastest route to full parity. |

**Recommendation to the dev team:** please assess B2 vs B3 based on how many distinct international carriers appear in our WooCommerce order data over the last 12 months, and come back with a cost and effort comparison. Note that aggregators price **per tracked shipment** — at our volume, model the cost against international shipments only (not total orders), since ShipBob covers the rest. The business's preference is to avoid third parties, but not at the cost of a worse international tracking experience than we have today.

`[TO CONFIRM]` — decision owner: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ / deadline: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_

---

## 4\. Data sources

### 4.1 ShipBob API (primary source for fulfilled orders)

Documentation:There is a specific API we need to confirm and test 

**Ingestion approach: webhooks first, polling as a safety net.** ShipBob explicitly recommends this pattern.

Webhook topics to subscribe to:

- `order.shipped` — fires when the label is created and tracking first becomes available  
- `order.shipment.tracking.updated` — ongoing carrier status changes (`InTransit`, `OutForDelivery`, `Delivered`)  
- `order.shipment.delivered` — final delivery confirmation for a shipment  
- `order.delivered` — order-level confirmation, fires when all shipments on an order are delivered  
- `order.shipment.exception` — shipment in exception state  
- `order.shipment.on_hold` — shipment blocked by missing or invalid data  
- `order.shipment.cancelled`

**Split shipments must be handled.** An order can have many shipments, each with its own tracking number, carrier and status, and each containing a different subset of the line items. The customer-facing page must show each parcel separately with the products it contains — this is a common source of WISMO tickets and Narvar handles it today.

We need a **carrier mapping table** in our system rather than displaying ShipBob's raw strings. The full carrier identifier list is published at [https://developer.shipbob.com/guides/tracking](https://developer.shipbob.com/guides/tracking).

### 4.2 WooCommerce (foreign orders)

For international orders, tracking is pushed into WooCommerce by our fulfilment partners.

Requirements:

- `[TO CONFIRM]` Identify exactly **which plugin or process** writes the tracking data into WooCommerce, and **which order meta fields** it uses. The development team should inspect a real international order before designing this. This is a hard blocker for the ingestion design.  
- Ingest via the WooCommerce REST API (orders endpoint, including order meta) and/or WooCommerce webhooks on order update.  
- Handle the case where tracking is added, corrected, or replaced after the fact.  
- Handle orders with multiple tracking numbers.  
- WooCommerce is also our **source of truth for the order itself** — customer email, order number, line items, shipping address country, order date. The tracking system reads this; it must never write back to WooCommerce without explicit sign-off.

### 4.3 Carrier status data

Per the decision in §3.

---

## 5\. Architecture requirements

The system must be built as a **separate service**, not as a WooCommerce plugin. Rationale: tracking traffic (customers refreshing the page, webhook volume) should not put load on the storefront, and the storefront must not be a single point of failure for tracking.

Required components:

1. **Ingestion layer** — webhook receivers (ShipBob, WooCommerce, carrier/aggregator) plus scheduled polling jobs. All inbound events written to a durable queue before processing.  
2. **Event store** — an append-only log of every tracking event received, with source, raw payload, and received timestamp. Never overwrite history; we need this for debugging and for delivery analytics later.  
3. **Unified data model** — see §6.2.  
4. **Public API** — read-only endpoints serving the tracking page.  
5. **Customer-facing web front end** — see §6.3.  
6. **Internal admin view** — see §6.6.

---

## 6\. Functional requirements

### 6.1 Ingestion

- **FR1.1** Ingest ShipBob shipment events via webhook, with polling reconciliation every 15–30 minutes.  
- **FR1.2** Ingest WooCommerce order data and international tracking data.  
- **FR1.3** All event processing must be **idempotent** — the same event received twice must not create a duplicate timeline entry.  
- **FR1.4** Out-of-order events must be resolved by event timestamp. A `Delivered` event arriving before an `InTransit` event must not cause the status to go backwards.  
- **FR1.5** Reconciliation job: daily, compare shipments in our system against ShipBob and WooCommerce and flag any order that has shipped but has no tracking record, or has been in the same status for more than `[TO CONFIRM: 7?]` days.

### 6.2 Unified data model and status normalisation

All shipments, regardless of source, must be normalised into one internal status set. Proposed:

| Internal status | Customer-facing label | Triggered by |
| :---- | :---- | :---- |
| `ORDER_RECEIVED` | Order confirmed | WooCommerce order created |
| `PROCESSING` | Preparing your order | ShipBob `Processing` |
| `LABEL_CREATED` | Shipment ready | ShipBob `LabeledCreated` / `order.shipped` |
| `IN_TRANSIT` | On its way | Carrier `InTransit` |
| `OUT_FOR_DELIVERY` | Out for delivery | Carrier `OutForDelivery` |
| `DELIVERED` | Delivered | Carrier `Delivered` / `order.shipment.delivered` |
| `EXCEPTION` | There's a delay | `order.shipment.exception`, `order.shipment.on_hold`, carrier exception codes |
| `RETURNED_TO_SENDER` | Returning to us | Carrier return codes |
| `CANCELLED` | Cancelled | `order.shipment.cancelled` |

The mapping table between source statuses and internal statuses must be **configuration, not hard-coded**, so it can be updated without a release. ShipBob's own status reference is at [https://developer.shipbob.com/status-reference](https://developer.shipbob.com/status-reference).

Note: ShipBob's `Completed` status means *ShipBob has finished fulfilling* (picked, packed, labelled), **not** that the customer has received the parcel. It must not be mapped to "Delivered".

Minimum fields per shipment: internal order ID, WooCommerce order number, shipment ID, carrier (mapped display name), carrier service, tracking number, carrier tracking URL, current internal status, full status history with timestamps, estimated delivery date (if available), line items in this shipment, destination country.

### 6.3 Customer tracking page

- **FR3.1** Hosted on our own domain (`[TO CONFIRM: track.ourdomain.com or ourdomain.com/track]`), using our brand styling.  
- **FR3.2** Mobile-first. The large majority of tracking page traffic is mobile.  
- **FR3.3** Accessible via a unique, unguessable link (a signed token, not a sequential ID) that we can include in emails, so the customer does not have to log in.  
- **FR3.4** Displays: order number, current status, plain-English status description, estimated delivery date where available, visual progress timeline, full event history, carrier name, tracking number, and a link to the carrier's own tracking page.  
- **FR3.5** Multiple shipments per order shown as separate parcels, each with its own timeline and the items it contains.  
- **FR3.6** Clear, non-alarming messaging for exceptions and delays, with a link to contact support.  
- **FR3.7** Page must not be indexed by search engines (`noindex`).  
- **FR3.8** `[TO CONFIRM]` Multi-language support for international orders — languages required: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_.  
- **FR3.9** `[TO CONFIRM]` Any additional modules: product recommendations, review request, support links, referral offer.

### 6.4 Order lookup

- **FR4.1** A lookup form for customers who no longer have the link: **order number \+ email address** (or postcode). Both fields required — never allow lookup by order number alone.  
- **FR4.2** Rate-limited per IP, with bot protection, to prevent order data enumeration.  
- **FR4.3** Generic error message on failed lookup that does not reveal whether the order number exists.

### 6.5 Notifications

**Decided: all customer notifications are sent from Klaviyo.** This system does not send email. It is an event source only — Klaviyo owns templating, sending, unsubscribes, send-time rules and deliverability.

- **FR5.1** The tracking system pushes events to Klaviyo (`shipment.shipped`, `shipment.out_for_delivery`, `shipment.delivered`, `shipment.exception`, `shipment.stalled`) via the Klaviyo Events API, with the customer's email as the profile identifier.  
- **FR5.1a** Each event payload must carry everything Klaviyo needs to render the email without a second lookup: order number, tracking page URL (the signed token link), carrier display name, tracking number, carrier tracking URL, estimated delivery date, item names and images, and destination country.  
- **FR5.1b** Any WooCommerce or plugin-generated shipping emails currently going out must be identified and switched off at cutover, or customers will receive duplicates.  
- **FR5.2** Deduplication: a customer must never receive two "shipped" emails for the same parcel.  
- **FR5.3** Batching: for split shipments, `[TO CONFIRM]` do we notify per parcel or once per order?  
- **FR5.4** SMS: `[TO CONFIRM]` in or out of scope.

### 6.6 Internal / customer service view

- **FR6.1** Authenticated internal tool to search any order by order number, email, or tracking number.  
- **FR6.2** Shows full raw event history including source and payload, for debugging.  
- **FR6.3** Exception dashboard: all shipments currently in an exception state, or stalled (no carrier movement for `[TO CONFIRM: 5?]` days).  
- **FR6.4** `[TO CONFIRM]` Should this surface inside our helpdesk rather than as a standalone tool?

### 6.7 Analytics (Phase 2\)

Average and median delivery time by carrier, service, and destination country; exception and failed-delivery rates by carrier; tracking page visits per order (a proxy for customer anxiety and WISMO risk).

---

## 7\. Non-functional requirements

- **Availability:** 99.9% for the customer tracking page. It is a public-facing page linked from emails; downtime generates support tickets.  
- **Latency:** tracking page loads in under 2 seconds on mobile.  
- **Freshness:** carrier status change visible on the page within 30 minutes.  
- **Scale:** **10,000–50,000 orders per month** (\~330–1,650 orders/day). Assume an average of 1.3 shipments per order and 5–8 tracking events per shipment: budget for roughly **5,000–25,000 inbound events per day** in normal trading. Peak-season multiplier `[TO CONFIRM: 2x? 3x?]` — design headroom accordingly.  
- **Tracking page traffic:** expect 2–4 page views per order. Responses must be cached; the page must never hit ShipBob or a carrier API on page load, only our own datastore.  
- **Data retention:** `[TO CONFIRM: 24 months?]` of tracking history.  
- **Monitoring and alerting:** webhook failure rate, queue depth, polling job failures, ingestion lag, ShipBob API error rates. Alerts must route to `[TO CONFIRM: who]`.  
- **Logging:** all inbound payloads retained for `[TO CONFIRM: 30 days]` for debugging.  
- **Graceful degradation:** if a data source is unavailable, the page shows the last known status with a timestamp — never an error page and never a blank timeline.

---

## 8\. Security and privacy

- Tracking links use unguessable signed tokens with `[TO CONFIRM]` expiry.  
- No personal data in URL query strings.  
- The tracking page shows the minimum necessary personal data. Recommend: **no full delivery address** — city and country only.  
- API credentials (ShipBob PAT/OAuth, WooCommerce keys, aggregator keys) stored in a secrets manager, never in code or config files in the repository.  
- All traffic over HTTPS.  
- GDPR: tracking records must be deletable on a data subject request; document the retention period and lawful basis.  
- Rate limiting and bot protection on all public endpoints.

---

## 9\. Testing

- ShipBob provides a **sandbox environment** with a shipment simulation endpoint (`POST /2026-01/simulate/shipment`) that triggers shipment state transitions so webhooks and the full order lifecycle can be tested end to end. Build against sandbox first.  
- Test cases must include: split shipments; tracking number changed after being issued; delivered event arriving before in-transit; duplicate webhook delivery; webhook delivery failure and recovery; international order with carrier not in our mapping table; order with no tracking 5 days after shipping; cancelled shipment.  
- Parallel run against live Narvar data for `[TO CONFIRM: 2–4 weeks]` before cutover, comparing statuses to catch mapping errors.

---

## 10\. Migration and cutover

1. Build and run in parallel with Narvar — both systems ingesting, only Narvar customer-facing.  
2. Compare status accuracy daily during the parallel period; fix mapping discrepancies.  
3. Switch tracking links in transactional emails to the new domain.  
4. **Existing Narvar tracking links already sitting in customers' inboxes will keep being clicked for months.** Confirm with Narvar what happens to those URLs after cancellation and plan a redirect or a grace period. This is frequently missed and generates a wave of support tickets.  
5. `[TO CONFIRM]` Do we need historical tracking data exported from Narvar before cancelling? Check the contract for data export rights and notice period.  
6. Rollback plan: keep the Narvar contract live for one full billing period after cutover.

---

## 11\. Suggested phasing

| Phase | Contents |
| :---- | :---- |
| **Phase 0 — Discovery** | Inspect real WooCommerce international orders to confirm tracking data structure. Audit international carrier mix. Resolve the §3 decision. Deliverable: technical approach document and estimate. |
| **Phase 1 — MVP** | ShipBob ingestion, unified data model, branded tracking page, order lookup, internal CS view. Domestic orders only. |
| **Phase 2 — International** | WooCommerce ingestion plus chosen carrier status approach. Multi-language if required. |
| **Phase 3 — Notifications** | Event emission to ESP, dedupe logic, cutover of transactional emails. |
| **Phase 4 — Cutover** | Parallel run, link migration, Narvar cancellation. |
| **Phase 5 — Analytics** | Delivery performance reporting. |

---

## 12\. What we need back from the development team

1. Confirmation of the technical approach for international carrier status (§3), with cost and effort comparison.  
2. Findings from inspecting real WooCommerce international order data (§4.2).  
3. Effort estimate and timeline per phase.  
4. Hosting and infrastructure recommendation, with estimated monthly running cost, so we can compare against the Narvar subscription.  
5. A view on ongoing maintenance burden — who owns this once it is live, and roughly how much time per month it will take.  
6. Any risks or assumptions we have not covered here.

---

## Appendix: reference links

- ShipBob tracking guide — [https://developer.shipbob.com/guides/tracking](https://developer.shipbob.com/guides/tracking)  
- ShipBob webhooks — [https://developer.shipbob.com/webhooks](https://developer.shipbob.com/webhooks)  
- ShipBob status reference — [https://developer.shipbob.com/status-reference](https://developer.shipbob.com/status-reference)  
- ShipBob orders integration guide — [https://developer.shipbob.com/2026-01/guides/build-orders-integration](https://developer.shipbob.com/2026-01/guides/build-orders-integration)  
- ShipBob sandbox and simulations — [https://developer.shipbob.com/sandbox/simulations](https://developer.shipbob.com/sandbox/simulations)

