#!/usr/bin/env bash
# ./logs.sh [service]   e.g. ./logs.sh backend
cd "$(dirname "$0")" && exec docker compose logs -f --tail 200 "$@"
