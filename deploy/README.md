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

## Redeploying after code changes

Don't re-run `bootstrap.sh` for routine changes — it re-seeds sync cursors to "now" and would drop the sync window. Instead rebuild + recreate just the affected service:

```bash
ssh root@2.24.104.137
cd /var/www/pfm-tracking
git pull
docker compose -f docker-compose.prod.yml build <api|worker|admin>
docker compose -f docker-compose.prod.yml up -d <api|worker|admin>
```

One-off scripts (`scripts/*.ts`) run via the `jobs` profile, built from `worker/Dockerfile`:

```bash
docker compose -f docker-compose.prod.yml --profile tools build jobs
docker compose -f docker-compose.prod.yml --profile tools run --rm jobs scripts/<name>.ts [args...]
```

Full details, plus the Docker build bugs hit during the first fresh-start deploy (invalid Compose key, npm-workspace `node_modules` hoisting, missing `tsconfig.base.json` in `admin/Dockerfile`) and how to tell "stuck" apart from "silently failed", are in [`docs/ops/vps.md`](../docs/ops/vps.md#deploying-code-changes-after-initial-bootstrap).
