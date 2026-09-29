#!/usr/bin/env bash
# Haze Monitor probe installer.
#   curl -fsSL https://<backend>/install.sh | PROBE_TOKEN=<token> bash
# The token is created in the Telegram bot (Settings -> Probes -> Add). No secrets live in this script.
set -euo pipefail

BACKEND_URL="${BACKEND_URL:-__BACKEND_URL__}"
PROBE_IMAGE="${PROBE_IMAGE:-__PROBE_IMAGE__}"
INSTALL_DIR="${INSTALL_DIR:-/opt/haze-probe}"

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

printf '\nHaze Monitoring Probe\n\n'

[ -n "${PROBE_TOKEN:-}" ] || fail "PROBE_TOKEN is not set. Create a probe in the bot and run:  curl -fsSL $BACKEND_URL/install.sh | PROBE_TOKEN=<token> bash"
case "$BACKEND_URL" in __*|"") fail "BACKEND_URL is not set (run: BACKEND_URL=https://... PROBE_TOKEN=... ./install.sh)";; esac

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install it first:  curl -fsSL https://get.docker.com | sh"
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is missing (https://docs.docker.com/compose/install/)"
ok "Docker detected"

SUDO=""; docker info >/dev/null 2>&1 || SUDO="sudo"
$SUDO docker info >/dev/null 2>&1 || fail "Cannot talk to the Docker daemon (is it running? are you root?)"

$SUDO mkdir -p "$INSTALL_DIR"
$SUDO tee "$INSTALL_DIR/docker-compose.yml" >/dev/null <<YAML
name: haze-probe
services:
  probe:
    image: \${PROBE_IMAGE}
    container_name: monitor-probe
    restart: unless-stopped
    env_file: .env
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
YAML
( umask 077; $SUDO tee "$INSTALL_DIR/.env" >/dev/null <<ENV
BACKEND_URL=$BACKEND_URL
PROBE_TOKEN=$PROBE_TOKEN
PROBE_IMAGE=$PROBE_IMAGE
ENV
)
ok "Configuration created ($INSTALL_DIR)"

cd "$INSTALL_DIR"
$SUDO docker compose pull --quiet 2>/dev/null || $SUDO docker image inspect "$PROBE_IMAGE" >/dev/null 2>&1 \
  || fail "Could not pull $PROBE_IMAGE (is PROBE_IMAGE correct and public?)"
ok "Image downloaded"
$SUDO docker compose up -d >/dev/null
ok "Container started"

printf 'Waiting for the probe to connect'
for _ in $(seq 1 45); do
  health="$($SUDO docker inspect -f '{{.State.Health.Status}}' monitor-probe 2>/dev/null || echo starting)"
  [ "$health" = healthy ] && break
  printf '.'; sleep 2
done
printf '\n'
if [ "$health" != healthy ]; then
  $SUDO docker compose logs --tail 20 probe || true
  fail "Probe did not become healthy. Check BACKEND_URL reachability, the token and the server clock (logs above)."
fi

NAME="$($SUDO docker exec monitor-probe cat /tmp/probe-status.json 2>/dev/null | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')"
ok "Backend connected"
ok "Probe registered"
ok "Heartbeat active"
printf '\nProbe:\n%s\n\nStatus:\nONLINE\n\nInstallation completed successfully.\n' "${NAME:-unknown}"
