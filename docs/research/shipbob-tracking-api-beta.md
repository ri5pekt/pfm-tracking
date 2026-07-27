# ShipBob new Tracking API (Beta) — discovery

Researched 27 July 2026. **Live access confirmed** with regenerated PAT in `.env` (`SHIPBOB_API_KEY`).

Official docs:
- [Get Tracking by Shipment Ids](https://developer.shipbob.com/api/tracking/get-tracking-by-shipment-ids)
- [Get Tracking by Tracking Ids](https://developer.shipbob.com/api/tracking/get-tracking-by-tracking-ids)

Raw samples: `examples/analysis-summaries/shipbob-tracking-api-samples.json`  
Normalized fixtures: `examples/shipbob/*.json`

---

## 1. Endpoints

| Method | URL | Query param | Purpose |
| :---- | :---- | :---- | :---- |
| `GET` | `https://api.shipbob.com/2026-07/shipments-tracking` | `ShipmentIds` (1–25 ShipBob shipment IDs) | Preferred for our hub (we already store `source_shipment_id`) |
| `GET` | `https://api.shipbob.com/2026-07/tracking` | `TrackingIds` (carrier tracking numbers) | Lookup by tracking number (useful for RichPanel / CS) |

Auth: `Authorization: Bearer <PAT>` (same style as other ShipBob APIs). No `shipbob_channel_id` required for these endpoints.

Sandbox host also documented: `https://sandbox-api.shipbob.com`.

### Batch query format (important)

Docs say “comma-separated,” but live API rejects that with **400**:

```text
ShipmentIds=388185605,388578015   → 400 (value not valid)
```

Use **repeated query params** instead:

```text
ShipmentIds=388185605&ShipmentIds=388578015   → 200 (array of 2)
TrackingIds=CR…&TrackingIds=CR…              → 200
```

---

## 2. Response shape

Much richer than `/shipment/{id}/timeline`. One object per shipment:

| Field | What it gives us |
| :---- | :---- |
| `shipment_id` | ShipBob shipment ID |
| `tracking_number` | Carrier / ShipBob tracking number |
| `carrier`, `service` | Carrier + service level |
| `current_status` | High-level status (`InTransit`, `Delivered`, …) |
| `current_substatus` | Human-readable granular status |
| `current_substatus_code` | Machine code (e.g. `InTransit_001`) |
| `current_timestamp` | Time of latest event |
| `edd`, `edd_source` | Estimated delivery (`carrier` or `shipbob`) |
| `tracking_url` | Public tracking page link |
| `delivery_signed_by` | Signature name when available |
| `proof_of_delivery_urls` | POD image URLs |
| `last_mile_carrier` | `{ carrier, service, tracking_number, tracking_url }` |
| `history[]` | Full event list (newest first) |

Each `history` item:

| Field | Notes |
| :---- | :---- |
| `timestamp` | Event time |
| `status` | High-level status at that moment |
| `substatus` | Human label |
| `substatus_code` | Machine code |
| `substatus_message` | Carrier detail / exception reason text |
| `address` | `{ city, state, country, postal_code, location, latitude, longitude }` |

---

## 3. Live test results (unlocked)

Previous PAT (plugin / Jan 2024-era) → **401** on Tracking Beta.
**Regenerated PAT** (27 Jul 2026) → **200** on both endpoints. Same key still works for `/1.0/order`.

| Call | Result |
| :---- | :---- |
| `GET /1.0/order?Limit=2` | **200 OK** |
| `GET /2026-07/shipments-tracking?ShipmentIds=388185605` | **200 OK** |
| `GET /2026-07/tracking?TrackingIds=CR010921689329` | **200 OK** |
| Batch via repeated `ShipmentIds=` / `TrackingIds=` | **200 OK** |
| Comma-separated `ShipmentIds=` | **400** validation error |
| `GET /1.0/shipment/{id}/timeline` (old + new PAT) | **404** on retest (use Tracking API instead) |

### Sample shipments (27 Jul 2026)

| shipment_id | current_status | code | carrier | notes |
| :---- | :---- | :---- | :---- | :---- |
| 388185605 | Delivered | `Delivered_001` | Cirro | 6 history events; EDD + tracking URL |
| 388578015 | InTransit | `InTransit_002` | Cirro | Arrival scan; EDD present |
| 388136344 | InTransit | `InTransit_002` | Amazon Shipping | History includes `DeliveryAttemptFailed_001` |
| 388398902 | InTransit | `InTransit_001` | SpeedX | History includes rich `DeliveryException_001` address text |
| 388383366 | OutForDelivery | `OutForDelivery_001` | Cirro | 7 history events |

### Exception / attempt quality (confirmed in history)

**Failed attempt** (Amazon `388136344`):

```text
DeliveryAttemptFailed / DeliveryAttemptFailed_001
substatus: Failed Attempt
substatus_message: DeliveryAttempted
```

**Delivery exception** (SpeedX `388398902`):

```text
DeliveryException / DeliveryException_001
substatus: Incomplete/incorrect address
substatus_message: Parcel received but with incorrect address.
  Note: Please contact with customer service directly and schedule delivery.
```

So Klaviyo mapping can use:
- `current_status` / history `status` for high-level transitions
- `substatus_code` for stable machine keys (`DeliveryException_001`, `DeliveryAttemptFailed_001`, …)
- `substatus` + `substatus_message` for customer-facing exception copy / classifiers

---

## 4. Why this replaces `/timeline`

| Need | Old `/timeline` | New Tracking API |
| :---- | :---- | :---- |
| Current status | Derive from latest event / `status_details` | `current_status` + substatus codes |
| Full history | Yes | Yes, with geo |
| Exception reason text | Sometimes in `log_type_text` | `substatus` / `substatus_message` / codes |
| Failed attempt vs exception | Mixed | Distinct status + codes |
| EDD | Separate / incomplete | `edd` + `edd_source` |
| Tracking URL | Carrier URL only | `tracking_url` |
| POD / signature | No | `proof_of_delivery_urls`, `delivery_signed_by` |
| Last-mile handoff | No | `last_mile_carrier` |
| Batch | 1 shipment per call | **Up to 25 per call** (repeated params) |

---

## 5. Hub poll pattern (adopt now)

```text
every 15 min:
  open_shipments = shipments where source=shipbob and status not in (DELIVERED, CANCELLED) older than retention
  for each chunk of 25 shipment_ids:
    GET /2026-07/shipments-tracking?ShipmentIds=id1&ShipmentIds=id2&...
    upsert current_* fields, edd, tracking_url, last_mile, POD
    append new history[] events (dedupe by timestamp + substatus_code)
    emit Klaviyo on status / substatus_code transitions
```

Fallback: keep `/timeline` client only if Tracking API regresses; as of 27 Jul it returned 404 while Tracking API returned rich data.

---

## 6. Credential note

- Old plugin PAT: orders/timeline worked historically; Tracking Beta → **401**.
- New PAT: orders + Tracking Beta → **200**. Store as `SHIPBOB_API_KEY` in `.env` (do not commit).
- Channel list still includes `180705` with `tracking_read` among scopes; Tracking endpoints did not need the channel header.
