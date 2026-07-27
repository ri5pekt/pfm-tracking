# Warehouse API discovery

Tested against production APIs on 26 July 2026. No customer records or raw API
responses are stored in this repository.

## ShipBob

### Authentication findings

- `SHIPBOB_API_KEY` works as the bearer credential for order reads.
- `SHIPBOB_ACCESS_TOKEN` can read channels and locations, but order requests
  return ShipBob HTTP 500 database errors.
- API version `2026-01` works for order reads.
- Supplying `shipbob_channel_id: 180705` works, but the returned channel is
  named `Privileged Access Token Wednesday, January 10, 2024`. Confirm that this
  is the intended Particle channel before relying on it as a tenant filter.
- The `HasTracking=true` filter consistently returns HTTP 500. Date filtering
  and client-side filtering are viable temporary alternatives.

### Available order data

`GET https://api.shipbob.com/2026-01/order`

Order fields:

- IDs, reference/order number, created and purchase dates
- Order status and type
- Channel and shipping method
- Recipient
- Products, tags and gift message
- Shipments
- Shipping terms, retailer program data and financials

Shipment fields:

- Shipment, order and reference IDs
- Recipient, creation and update timestamps
- `last_tracking_update_at`
- Fulfilment `status` and `status_details`
- Location and shipping option
- Tracking object
- Products assigned to the shipment
- Cartons and measurements
- Estimated/actual fulfilment dates
- Delivery date and zone

Tracking fields:

- Carrier
- Tracking number
- Carrier service
- Carrier tracking URL
- Shipping date
- BOL, PRO number and SCAC where applicable

A seven-day sample returned 100 orders on the first page, including 54 shipments
with tracking. Shipment statuses in that sample were `Completed`, `Processing`
and `OnHold`.

Important: ShipBob shipment `Completed` is a fulfilment status, not proof of
delivery. Use the shipment timeline endpoint below for carrier milestones.

### Shipment timeline (works)

`GET https://api.shipbob.com/2026-01/shipment/{shipmentId}/timeline`

Also available as:

`GET https://api.shipbob.com/2026-01/order/{orderId}/shipment/{shipmentId}/timeline`

Each event includes `log_type_id`, `log_type_name`, `log_type_text`, `timestamp`,
and optional `metadata`.

A delivered SpeedX shipment returned this full sequence:

1. Inserted — Shipment Created
2. Allocated — Inventory was Allocated to the FC
3. Picked
4. Labeled — Label Created
5. Packed
6. Validated — Label Validated
7. Shipped — Order Shipped
8. InTransit — In Transit
9. OutForDelivery — Out For Delivery
10. Delivered

So ShipBob can power a customer-facing progress timeline for domestic ShipBob
orders without a separate carrier aggregator, including post-pickup carrier
milestones.

### New Tracking API (Beta) — **unlocked / preferred**

ShipBob public beta endpoints return structured tracking in one call (status +
substatus codes, geo history, EDD, last-mile carrier, POD, tracking URL),
batched up to 25 IDs:

- `GET /2026-07/shipments-tracking?ShipmentIds=id1&ShipmentIds=id2` (repeated params — comma-separated returns 400)
- `GET /2026-07/tracking?TrackingIds=...`

**Live test 27 Jul 2026:** regenerated PAT in `.env` returns **200** with rich
payloads (Delivered / InTransit / OutForDelivery; exception + failed-attempt
codes in history). Older plugin PAT returned **401**. Full write-up:
`docs/shipbob-tracking-api-beta.md`. Use this as the primary ShipBob poll source;
`/timeline` returned **404** on retest with both keys.

### Shipment logs (operational detail)

`GET https://api.shipbob.com/2026-01/shipment/{shipmentId}/logs`

Richer warehouse/ops events such as label generation, sort-center handoff and
carrier pickup. Useful for CS debugging; mostly too granular for the public
tracking page.

ShipBob still recommends webhooks (`order.shipped`,
`order.shipment.tracking.updated`, `order.shipment.delivered`, etc.) for
near-real-time updates, with timeline polling as reconciliation.

## KLB / Zenventory

### Customer orders (REST API)

`GET https://app.zenventory.com/rest/customer-orders`

Basic authentication with the API key and secret works. The account currently
reports 72,684 customer orders, with standard pagination.

Available data includes:

- Order ID, number and reference
- Ordered, created and modified dates
- Open/completed/cancelled/on-hold state and related timestamps
- Customer and client
- Shipping and billing addresses
- Shipping method, packaging and confirmation settings
- Warehouse, order source, notes, tags and custom fields
- Item SKU, description, ordered/allocated/picked quantities, price and kit data

This endpoint contains customer PII and should only be persisted when required
by the platform's retention and privacy design.

### Shipped orders (legacy API)

`GET https://app.zenventory.com/services/rest/shippingorders`

Authentication with `SecureKey` works. A 30-day query returned:

- 2,300 shipping orders
- 2,776 shipments
- 2,769 shipments with a tracking number
- 7 shipments without a tracking number
- 476 orders with multiple shipments

The dominant carriers were DHL eCommerce (2,413 shipments) and Stamps.com
(352 shipments).

Available shipment data includes:

- Shipping-order and customer-order linkage
- Warehouse, customer, shipping and billing details
- Carrier and service
- Shipped state and shipped date
- One or more shipments with tracking number, carrier, service, weight, total,
  cancellation flag and error message

KLB supplies shipment creation/tracking-number data, but this response does not
contain an in-transit event history or normalized delivery status. Probed REST
paths (`/customer-orders/{id}/timeline`, `/events`, `/shipments`) returned 404.
Carrier tracking is therefore still required after dispatch.

## TrackingMore (aggregator for KLB / international)

Tested 26 July 2026 with a trial API key and real KLB tracking numbers.
Auth header is `Tracking-Api-Key` (not `Trackingmore-Api-Key`).

### Flow that works

1. `POST /v4/couriers/detect` with `{ "tracking_number": "..." }`
2. `POST /v4/trackings/create` with `{ "tracking_number": "...", "courier_code": "..." }`
3. Wait briefly while `updating: true` / `delivery_status: pending`
4. `GET /v4/trackings/get?tracking_numbers=...` for status + `origin_info.trackinfo`

### Live results

| Source | Tracking | Detected courier | Result |
| :---- | :---- | :---- | :---- |
| KLB DHL eCommerce | `202607132208XFUV8I` | `dhlglobalmail` | Full timeline — `delivery_status: transit`, 9 checkpoints |
| KLB DHL eCommerce (delivered) | `202606301209ZBMFIP` | `dhlglobalmail` | Full end-to-end timeline — `delivered`, 16 checkpoints (label → customs → delivery, Singapore) |
| KLB DHL eCommerce (delivered) | `202606152313FFQDNA` | `dhlglobalmail` | Full timeline — `delivered`, 14 checkpoints (US → Germany hub → Croatia delivery) |
| KLB Stamps.com / USPS | `9434650106151105211382` | `usps` | `pending001` after ~1 h — USPS returned no scan data |

### KLB carrier mix (90-day scan)

Zenventory KLB shipments use effectively **two** carriers:

- **DHL eCommerce** — ~88% (~6,875 shipments)
- **Stamps.com / USPS** — ~12% (~860 shipments)
- 1 UPS shipment + ~15 blank-carrier rows (DHL-format numbers)

No "exotic" / regional carriers (Amazon, UniUni, OnTrac, etc.) appear in KLB —
those only show up in ShipBob.

### DHL eCommerce works fully; Stamps/USPS failed in TrackingMore (but data exists)

DHL eCommerce numbers return complete, granular international timelines through
TrackingMore (origin processing → export → arrival in country → customs →
out-for-delivery → delivered).

The Stamps.com / USPS slice did **not** return a timeline from TrackingMore.
Every tested number stayed `delivery_status: pending` / `substatus: pending001`
("courier did not return tracking info") even ~1 hour after creation, on
delivered orders. Re-registering under consolidator courier codes
(`globegistics`, `asendia-usa`, `firstmile`, etc.) also returned zero events.

**However, cross-checking the same numbers against Narvar (current platform,
via `tracking.narvar.com` page payload) proved the USPS data exists.** Narvar
returned full USPS timelines for all 6 tested numbers — label created →
accepted → facility scans → out for delivery → delivered (and one
return-to-sender exception with "Insufficient Address"). Examples:

| Order | Tracking | Narvar status | Narvar events |
| :---- | :---- | :---- | :---- |
| 3890530 | `9400150106151256666749` | DELIVERED (Parcel Locker) | 9 |
| 3946123 | `9400150106151271967258` | DELIVERED (PO Box) | 20 |
| 3946139 | `9434650106151090872902` | DELIVERED (Parcel Locker) | 20 |
| 4006668 | `9434650106151105211382` | EXCEPTION (return to sender, insufficient address) | 14 |
| 4006690 | `9434650106151105211399` | INTRANSIT | 3 |
| 3945435 | `9434650106151095455605` | INTRANSIT (stalled since 29 Jun, San Francisco) | 9 |

**Resolved (same day):** after a manual **Refresh** in the TrackingMore
dashboard, these USPS trackings populated. After upgrading off the free plan,
`GET /trackings/get` returned full timelines matching Narvar for 6/7 numbers
(statuses: delivered ×3, transit ×2, exception/return-to-sender ×1). One
number (`999010667` / `9434650206217238364414`) was still `pending001` on
API re-check and may need retrack. USPS is supported; initial sync can lag
and may need an explicit dashboard refresh or `retrack` call.

Side finding: the Narvar orders API (`GET /api/v1/orders/{order_number}/`)
returned "No Order Information found" for all of these order numbers — the
site's Narvar push doesn't cover them — yet the Narvar tracking page still
tracks by carrier + tracking number alone.

DHL sample milestones returned in `origin_info.trackinfo`:

- LABEL CREATED
- EN ROUTE TO DHL ECOMMERCE DISTRIBUTION CENTER
- PACKAGE RECEIVED AT DHL ECOMMERCE DISTRIBUTION CENTER
- PROCESSED / PROCESSING COMPLETED AT ORIGIN
- ARRIVED AT TRANSIT FACILITY
- PROCESSED AT EXPORT FACILITY
- DEPARTED FROM TRANSIT FACILITY

Each checkpoint includes `checkpoint_date`, `checkpoint_delivery_status`,
`checkpoint_delivery_substatus`, `tracking_detail`, and `location`. The payload
also includes origin/destination geography, product type, weight, transit time,
and milestone dates (pickup, out-for-delivery, delivery).

### Implication

TrackingMore can fill the KLB / international timeline gap that Zenventory
itself cannot. Pattern for the platform:

- ShipBob parcels → ShipBob Tracking API (`/2026-07/shipments-tracking`)
- KLB / other international parcels → register tracking number with TrackingMore,
  store normalized `trackinfo` events, refresh via webhook or polling

## Implication for the tracking platform

| Source | Parcel identity | Progress timeline |
| :---- | :---- | :---- |
| ShipBob | Yes — orders/shipments with tracking | Yes — Tracking API (`/2026-07/shipments-tracking`): status codes, history, EDD, exception text |
| KLB / Zenventory (DHL eCommerce, ~88%) | Yes | Yes — full TrackingMore timeline (label → customs → delivered) confirmed |
| KLB / Zenventory (Stamps/USPS, ~12%) | Yes | Yes — Narvar has full timelines; TrackingMore also populated after dashboard Refresh (initial API poll was empty / laggy) |
| TrackingMore | N/A — needs tracking number from warehouse | Yes for DHL eCommerce and USPS (USPS may need retrack / longer sync); free-tier GET later returned 401 once quota was exhausted |

- ShipBob MVP: poll Tracking API in batches of ≤25; webhooks optional later for
  freshness.
- KLB / international: create TrackingMore trackings when KLB ships, map
  `delivery_status` / `trackinfo` into the internal status set, and prefer
  webhooks over constant polling.
