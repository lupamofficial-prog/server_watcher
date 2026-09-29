#!/usr/bin/env bash
# PostgreSQL backup through Docker (no pg_dump needed on the host) -> ./backups/monitoring-YYYY-MM-DD-HHMMSS.sql.gz
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
f="backups/monitoring-$(date +%Y-%m-%d-%H%M%S).sql.gz"
docker compose exec -T postgres pg_dump -U haze --no-owner haze | gzip > "$f"
echo "✓ Backup written: $f ($(du -h "$f" | cut -f1))"
# keep the newest 30 backups
ls -1t backups/monitoring-*.sql.gz | tail -n +31 | xargs -r rm -f
