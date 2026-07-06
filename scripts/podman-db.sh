#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNITS=(
  "$ROOT/containers/quadlet/openwook-postgres.volume"
  "$ROOT/containers/quadlet/openwook-postgres.container"
)
SERVICE=openwook-postgres.service

case "${1:-up}" in
  install)
    podman quadlet install --replace "${UNITS[@]}"
    ;;
  up)
    podman quadlet install --replace "${UNITS[@]}"
    systemctl --user start "$SERVICE"
    ;;
  down)
    systemctl --user stop "$SERVICE"
    ;;
  restart)
    podman quadlet install --replace "${UNITS[@]}"
    systemctl --user restart "$SERVICE"
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
    podman quadlet rm --ignore openwook-postgres.container openwook-postgres.volume
    ;;
  *)
    echo "Usage: $0 {install|up|down|restart|status|logs|uninstall}" >&2
    exit 2
    ;;
esac
