# Deploy

| Piece | Path |
| :--- | :--- |
| Prod compose | [`../docker-compose.prod.yml`](../docker-compose.prod.yml) |
| Caddy (TLS + reverse proxy → admin) | [`Caddyfile`](Caddyfile) |
| Bootstrap script | [`bootstrap.sh`](bootstrap.sh) |
| Temporary welcome (unused once app is up) | [`welcome/`](welcome/) |

## Fresh-start (no historical shipments)

1. Clone / pull repo to `/var/www/pfm-tracking`
2. Create `.env` (API keys + `POSTGRES_PASSWORD` + `PUBLIC_BASE_URL=https://tracking.particleformen.com`)
3. Set `SHIPBOB_ORDERS_LOOKBACK_HOURS=1` and `KLB_WINDOW_DAYS=0` (or `1`)
4. Run `bash deploy/bootstrap.sh`

That migrates, seeds **catalog only** (carriers/status mappings come from SQL migrations; admin from bootstrap env), sets ShipBob order cursor to **now**, then starts the stack.

Do **not** run `seed:samples` / `seed:more` on prod.

## Watch sync tomorrow

```bash
ssh root@2.24.104.137
cd /var/www/pfm-tracking
docker compose -f docker-compose.prod.yml logs -f worker
docker compose -f docker-compose.prod.yml logs --since 24h worker | less
```

Intervals (worker): ShipBob/KLB every **20m**, TrackingMore every **15m**. Adjust in `worker/src/index.ts` after reviewing lag.
