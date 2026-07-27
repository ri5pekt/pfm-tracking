---
name: shipbob-tracking-api
description: >-
  Call and normalize ShipBob Tracking API (2026-07 shipments-tracking /
  tracking). Use when writing ShipBob sync/poll clients, parsing history,
  EDD, locations, or exception substatus codes.
---

# ShipBob Tracking API

## Endpoints

| Purpose | Method / URL |
| :--- | :--- |
| By shipment IDs (preferred) | `GET https://api.shipbob.com/2026-07/shipments-tracking` |
| By tracking numbers | `GET https://api.shipbob.com/2026-07/tracking` |

Auth: `Authorization: Bearer <SHIPBOB_API_KEY>`  
No `shipbob_channel_id` required for these endpoints.

## Batching (critical)

```http
GET /2026-07/shipments-tracking?ShipmentIds=388185605&ShipmentIds=388578015
```

- Max **25** IDs per request
- **Repeated** query params only
- `ShipmentIds=a,b` → **400** validation error (docs are wrong)

Same rule for `TrackingIds`.

## Response fields to persist

Top-level: `shipment_id`, `tracking_number`, `carrier`, `service`,  
`current_status`, `current_substatus`, `current_substatus_code`,  
`current_timestamp`, `edd`, `edd_source`, `tracking_url`,  
`last_mile_carrier`, `delivery_signed_by`, `proof_of_delivery_urls`, `history[]`

Each history item: `timestamp`, `status`, `substatus`, `substatus_code`,  
`substatus_message`, `address{location,city,state,postal_code,country,latitude,longitude}`

History is **newest first**. Current location ≈ `history[0].address`.

## Status mapping seeds

| API status | Internal |
| :--- | :--- |
| PreTransit | LABEL_CREATED |
| InTransit | IN_TRANSIT |
| OutForDelivery / AvailableForPickup | OUT_FOR_DELIVERY |
| DeliveryAttemptFailed / DeliveryException / Exception | EXCEPTION |
| Delivered | DELIVERED |

Klaviyo: treat `DeliveryAttemptFailed` separately from generic exception.

## Examples

- `examples/shipbob/tracking-delivered.json`
- `examples/shipbob/tracking-in-transit.json`
- `examples/shipbob/tracking-out-for-delivery.json`
- `examples/shipbob/tracking-with-exception-history.json`

## Orders (identity)

`GET https://api.shipbob.com/1.0/order` + header `shipbob_channel_id: 180705`  
Example shape: `examples/shipbob/order-with-shipment.json`

## Do not use

`GET /1.0/shipment/{id}/timeline` — returns 404 as of 2026-07-27.
