#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${OPENWOOK_ROOT:-/home/ubuntu/projects/openwook}"
PORTS_CSV="${OPENWOOK_PORTS:-3000,3001,3002,3003}"
INSTALL_SYSTEMD="${OPENWOOK_INSTALL_SYSTEMD:-1}"
RUN_BUILD="${OPENWOOK_RUN_BUILD:-1}"
SYSTEMD_DIR="${OPENWOOK_SYSTEMD_DIR:-/etc/systemd/system}"
CADDY_CONFIG_DIR="${OPENWOOK_CADDY_CONFIG_DIR:-/etc/caddy}"
CADDY_SERVICE="${OPENWOOK_CADDY_SERVICE:-caddy-openwook}"
START_SERVICES="${OPENWOOK_START_SERVICES:-1}"

IFS=',' read -r -a PORTS <<< "$PORTS_CSV"
NORMALIZED_PORTS=()
for port in "${PORTS[@]}"; do
  port="${port//[[:space:]]/}"
  [ -n "$port" ] || continue
  if ! [[ "$port" =~ ^[0-9]+$ ]]; then
    echo "OPENWOOK_PORTS contains a non-numeric port: $port" >&2
    exit 2
  fi
  NORMALIZED_PORTS+=("$port")
done
if [ "${#NORMALIZED_PORTS[@]}" -eq 0 ]; then
  echo "OPENWOOK_PORTS must contain at least one port" >&2
  exit 2
fi

cd "$ROOT_DIR"

mapfile -t CADDY_PORTS < <(grep -oE '127\.0\.0\.1:[0-9]+' Caddyfile.openwook | sed 's/.*://' | sort -nu)
mapfile -t DEPLOY_PORTS < <(printf '%s\n' "${NORMALIZED_PORTS[@]}" | sort -nu)
if [ "${CADDY_PORTS[*]}" != "${DEPLOY_PORTS[*]}" ]; then
  echo "OPENWOOK_PORTS must match Caddyfile.openwook upstream ports" >&2
  echo "  OPENWOOK_PORTS: ${DEPLOY_PORTS[*]}" >&2
  echo "  Caddyfile:      ${CADDY_PORTS[*]}" >&2
  exit 2
fi

if [ "$RUN_BUILD" = "1" ]; then
  pnpm build
fi

if [ "$INSTALL_SYSTEMD" = "1" ]; then
  install -m 0644 openwook@.service "$SYSTEMD_DIR/openwook@.service"
  install -m 0644 openwook-import-worker.service "$SYSTEMD_DIR/openwook-import-worker.service"
  install -m 0644 caddy-openwook.service "$SYSTEMD_DIR/caddy-openwook.service"
  install -m 0644 Caddyfile.openwook "$CADDY_CONFIG_DIR/Caddyfile.openwook"
  systemctl daemon-reload
fi

if [ "$START_SERVICES" != "1" ]; then
  echo "Validated OpenWook deployment inputs; skipping systemd changes because OPENWOOK_START_SERVICES=$START_SERVICES"
  exit 0
fi

if systemctl list-unit-files openwook.service >/dev/null 2>&1; then
  systemctl disable --now openwook.service >/dev/null 2>&1 || true
fi

for port in "${NORMALIZED_PORTS[@]}"; do
  systemctl enable --now "openwook@$port"
done

systemctl enable --now openwook-import-worker.service
systemctl enable --now "$CADDY_SERVICE"
if systemctl is-active --quiet "$CADDY_SERVICE"; then
  systemctl reload "$CADDY_SERVICE" || systemctl restart "$CADDY_SERVICE"
fi

systemctl --no-pager --full status $(printf 'openwook@%s ' "${NORMALIZED_PORTS[@]}") openwook-import-worker.service "$CADDY_SERVICE" || true
