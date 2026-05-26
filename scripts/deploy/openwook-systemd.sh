#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${OPENWOOK_ROOT:-/home/ubuntu/projects/openwook}"
PORTS_CSV="${OPENWOOK_PORTS:-3000,3001,3002,3003}"
INSTALL_SYSTEMD="${OPENWOOK_INSTALL_SYSTEMD:-1}"
RUN_BUILD="${OPENWOOK_RUN_BUILD:-1}"
SYSTEMD_DIR="${OPENWOOK_SYSTEMD_DIR:-/etc/systemd/system}"
CADDY_CONFIG_DIR="${OPENWOOK_CADDY_CONFIG_DIR:-/etc/caddy}"
CADDY_SERVICE="${OPENWOOK_CADDY_SERVICE:-caddy-openwook}"

IFS=',' read -r -a PORTS <<< "$PORTS_CSV"
if [ "${#PORTS[@]}" -eq 0 ]; then
  echo "OPENWOOK_PORTS must contain at least one port" >&2
  exit 2
fi

cd "$ROOT_DIR"

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

for port in "${PORTS[@]}"; do
  port="${port//[[:space:]]/}"
  [ -n "$port" ] || continue
  systemctl enable --now "openwook@$port"
done

systemctl enable --now openwook-import-worker.service
systemctl enable --now "$CADDY_SERVICE"
if systemctl is-active --quiet "$CADDY_SERVICE"; then
  systemctl reload "$CADDY_SERVICE" || systemctl restart "$CADDY_SERVICE"
fi

systemctl --no-pager --full status $(printf 'openwook@%s ' "${PORTS[@]}") openwook-import-worker.service "$CADDY_SERVICE" || true
