#!/usr/bin/env bash
# Fresh production bootstrap on the VPS (no historical shipment seed).
# Run from /var/www/pfm-tracking after .env is in place.
set -euo pipefail

COMPOSE=(docker compose -f docker-compose.prod.yml)

echo "== stop old caddy-only stack if present =="
if [[ -f deploy/docker-compose.caddy.yml ]]; then
  (cd deploy && docker compose -f docker-compose.caddy.yml down) || true
fi

echo "== build =="
"${COMPOSE[@]}" build

echo "== postgres + redis =="
"${COMPOSE[@]}" up -d postgres redis

echo "== migrate =="
"${COMPOSE[@]}" --profile tools run --rm migrate

echo "== seed catalog (products only, no shipments) =="
"${COMPOSE[@]}" --profile tools run --rm jobs scripts/seed-catalog.ts

echo "== seed fresh sync cursors (ShipBob orders from now) =="
"${COMPOSE[@]}" --profile tools run --rm jobs scripts/seed-fresh-cursors.ts

echo "== start api / admin / caddy / worker =="
"${COMPOSE[@]}" up -d api admin caddy worker

echo "== status =="
"${COMPOSE[@]}" ps
echo
echo "HTTPS: https://tracking.particleformen.com/"
echo "Logs:  docker compose -f docker-compose.prod.yml logs -f worker"
echo "Fresh-start: SHIPBOB cursor=now, KLB_WINDOW_DAYS should be 0 or 1 in .env"
