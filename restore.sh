#!/usr/bin/env bash
# Restore a backup made by backup.sh. DESTROYS the current database contents.
set -euo pipefail
cd "$(dirname "$0")"
f="${1:-}"; [ -f "$f" ] || { echo "usage: ./restore.sh backups/monitoring-XXXX.sql.gz"; exit 1; }
read -r -p "This replaces ALL current data with $f. Type 'yes' to continue: " a; [ "$a" = yes ] || exit 1
docker compose stop backend
docker compose exec -T postgres psql -U haze -d haze -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
gunzip -c "$f" | docker compose exec -T postgres psql -U haze -d haze -v ON_ERROR_STOP=1 >/dev/null
docker compose up -d
echo "✓ Restored from $f"
