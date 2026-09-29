#!/usr/bin/env bash
# Update the central server: new code/images -> restart changed containers -> migrations -> healthcheck.
# Data is never touched (no `down -v`). Set PREBUILT=1 in .env to pull registry images instead of building locally.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "No .env — copy .env.example first"; exit 1; }

[ -d .git ] && git pull --ff-only
if [ "${PREBUILT:-}" = 1 ] || grep -q '^PREBUILT=1' .env; then docker compose pull; else docker compose build --pull; fi
docker compose up -d --remove-orphans   # `migrate` runs prisma migrate deploy before backend starts

printf 'Waiting for backend to become healthy'
for _ in $(seq 1 60); do
  s="$(docker inspect -f '{{.State.Health.Status}}' monitor-backend 2>/dev/null || echo starting)"
  [ "$s" = healthy ] && { printf '\n'; docker compose ps; echo "✓ Update completed"; exit 0; }
  printf '.'; sleep 2
done
printf '\n'; docker compose ps; docker compose logs --tail 40 migrate backend
echo "✗ Backend is not healthy" >&2; exit 1
