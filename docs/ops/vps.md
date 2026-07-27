# PFM Tracking — VPS

| Field | Value |
| :--- | :--- |
| Provider | Hostinger VPS |
| Hostname | `pfm` |
| IPv4 | `2.24.104.137` |
| IPv6 | `2a02:4780:75:e3c5::1` |
| SSH | `ssh root@2.24.104.137` |
| Public domain | **`tracking.particleformen.com`** |
| Deploy path | `/var/www/pfm-tracking` |
| Edge | Caddy → `admin` (nginx) → `api` |
| Compose | `docker-compose.prod.yml` |

## Quick access

```bash
ssh root@2.24.104.137
cd /var/www/pfm-tracking
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f worker
```

## Fresh-start ingest

| Setting | Value | Effect |
| :--- | :--- | :--- |
| `shipbob.orders.sync` cursor | `now()` (via `seed-fresh-cursors`) | Only new ShipBob orders (+15m overlap) |
| `SHIPBOB_ORDERS_LOOKBACK_HOURS` | `1` | Fallback if cursor missing |
| `KLB_WINDOW_DAYS` | `0` | Today UTC only |

**Do not** run `seed:samples` / `seed:more` on this host.

Catalog seed (`seed-catalog`) loads product titles/images only — no shipments.

## Intervals (adjust after watching logs)

| Job | Interval |
| :--- | :--- |
| `shipbob.sync` | 20 min |
| `klb.sync` | 20 min |
| `trackingmore.poll` | 15 min |
| stalled / retention / reconcile | daily |

## Notes

- Never commit `.env` or root passwords.
- UFW: **22 / 80 / 443** only.
- Bootstrap: [`deploy/bootstrap.sh`](../../deploy/bootstrap.sh)
