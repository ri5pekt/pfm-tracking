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

## Deploying code changes (after initial bootstrap)

The stack doesn't auto-deploy — pull + rebuild the affected service(s), then recreate them. No build-server/registry yet; images are built on the VPS itself.

```bash
ssh root@2.24.104.137
cd /var/www/pfm-tracking
git pull

# Rebuild + recreate only what changed (faster than a full bootstrap re-run):
docker compose -f docker-compose.prod.yml build api        # static assets / API code changes
docker compose -f docker-compose.prod.yml up -d api

docker compose -f docker-compose.prod.yml build worker     # worker/sync script changes
docker compose -f docker-compose.prod.yml up -d worker

docker compose -f docker-compose.prod.yml build admin      # admin UI changes
docker compose -f docker-compose.prod.yml up -d admin

# One-off scripts (e.g. scripts/*.ts) live in the `jobs` image (built from worker/Dockerfile):
docker compose -f docker-compose.prod.yml --profile tools build jobs
docker compose -f docker-compose.prod.yml --profile tools run --rm jobs scripts/<name>.ts [args...]
```

Only re-run the full `deploy/bootstrap.sh` for a true first-time bootstrap (it re-seeds cursors/catalog) — not for routine code updates, since it would reset the ShipBob sync cursor to "now" again.

## Creating admin users (no invite emails)

Admin users are created directly via a script instead of the email-invite flow — see [`scripts/create-admin-user.ts`](../../scripts/create-admin-user.ts). Idempotent by email (re-running resets password/role/status).

```bash
docker compose -f docker-compose.prod.yml --profile tools run --rm jobs \
  scripts/create-admin-user.ts <email> <password> [admin|staff]
```

Requires the `jobs` image to include the script — rebuild it first if it was added/changed since the last image build (see above).

## Known deploy issues we hit (2026-07-27 fresh-start deploy)

`deploy/bootstrap.sh` runs with `set -euo pipefail`, so a failed build step just **exits the script silently** — backgrounding it with `nohup ... &` made this look like a hang ("looks like its stuck?") when it had actually already failed. If a backgrounded bootstrap run seems stuck, always check first:

```bash
pgrep -af bootstrap.sh                 # still running at all?
tail -n 80 /root/bootstrap.log         # what did it actually stop on?
docker compose -f docker-compose.prod.yml ps -a
```

Three Docker build bugs were found and fixed this way, in order:

1. **`docker-compose.prod.yml` — invalid Compose key.** The `jobs` service used `working_directory: /app`, which isn't a valid Compose property (validation error, not a hang: `services.jobs additional properties 'working_directory' not allowed`). Fixed to `working_dir: /app`.
2. **`api/Dockerfile` — copying a nonexistent nested `node_modules`.** The final stage did `COPY --from=deps /app/api/node_modules ./api/node_modules`, but this is an npm-workspaces monorepo — `npm install --workspace=@pfm/api` hoists everything to the root `/app/node_modules`; there is no `api/node_modules` to copy (`"/app/api/node_modules": not found`). Removed that line; the root `node_modules` copy is sufficient (Node's module resolution walks up directories).
3. **`admin/Dockerfile` — missing `tsconfig.base.json` in the build context.** `admin/tsconfig.json` has `"extends": "../tsconfig.base.json"`, but the Dockerfile never copied that file in before `RUN npm run build`, so Vite's build failed (`failed to resolve "extends":"../tsconfig.base.json"`). Fixed by adding `COPY tsconfig.base.json ./` before `COPY admin ./admin` (matching what `api/Dockerfile` and `worker/Dockerfile` already did).

Lesson: when adding/editing a Dockerfile in this monorepo, double-check (a) Compose keys against the schema (`docker compose config -q` validates without building), and (b) that every `tsconfig.json extends` target and every workspace's hoisted-vs-nested `node_modules` assumption is actually copied into the stage that needs it.

## Notes

- Never commit `.env` or root passwords.
- UFW: **22 / 80 / 443** only.
- Bootstrap: [`deploy/bootstrap.sh`](../../deploy/bootstrap.sh)
