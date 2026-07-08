#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUADLET_DIR="${HOME}/.config/containers/systemd"
SERVICE=openwook-postgres.service
APP_DB_NAME=openwook_app
UNITS=(
  "$ROOT/containers/quadlet/openwook.network"
  "$ROOT/containers/quadlet/openwook-postgres.volume"
  "$ROOT/containers/quadlet/openwook-postgres.container"
)

install_units() {
  mkdir -p "$QUADLET_DIR"
  for unit in "${UNITS[@]}"; do
    cp "$unit" "$QUADLET_DIR/"
  done
  systemctl --user daemon-reload
}

wait_for_postgres() {
  for _ in $(seq 1 60); do
    if podman exec openwook-postgres pg_isready -U openwook -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for PostgreSQL" >&2
  exit 1
}

ensure_app_database() {
  local exists
  exists="$(podman exec openwook-postgres psql -U openwook -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${APP_DB_NAME}'")"
  if [[ "${exists//[[:space:]]/}" != "1" ]]; then
    podman exec openwook-postgres psql -U openwook -d postgres -c "CREATE DATABASE ${APP_DB_NAME};"
  fi
}

case "${1:-up}" in
  install)
    install_units
    ;;
  up)
    install_units
    systemctl --user start "$SERVICE"
    wait_for_postgres
    ensure_app_database
    ;;
  down)
    systemctl --user stop "$SERVICE"
    ;;
  restart)
    install_units
    systemctl --user restart "$SERVICE"
    wait_for_postgres
    ensure_app_database
    ;;
  status)
    systemctl --user status "$SERVICE" --no-pager || true
    podman ps -a --filter name=systemd-openwook-postgres
    ;;
  logs)
    journalctl --user -u "$SERVICE" -f
    ;;
  uninstall)
    systemctl --user stop "$SERVICE" 2>/dev/null || true
    rm -f "$QUADLET_DIR/openwook.network" "$QUADLET_DIR/openwook-postgres.volume" "$QUADLET_DIR/openwook-postgres.container"
    systemctl --user daemon-reload
    ;;
  *)
    echo "Usage: $0 {install|up|down|restart|status|logs|uninstall}" >&2
    exit 2
    ;;
esac
