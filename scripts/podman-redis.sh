#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUADLET_DIR="${HOME}/.config/containers/systemd"
UNITS=(
  "$ROOT/containers/quadlet/openwook.network"
  "$ROOT/containers/quadlet/openwook-redis.volume"
  "$ROOT/containers/quadlet/openwook-redis.container"
)
SERVICE=openwook-redis.service

install_units() {
  mkdir -p "$QUADLET_DIR"
  for unit in "${UNITS[@]}"; do
    cp "$unit" "$QUADLET_DIR/"
  done
  systemctl --user daemon-reload
}

case "${1:-up}" in
  install)
    install_units
    ;;
  up)
    install_units
    systemctl --user start "$SERVICE"
    ;;
  down)
    systemctl --user stop "$SERVICE"
    ;;
  restart)
    install_units
    systemctl --user restart "$SERVICE"
    ;;
  status)
    systemctl --user status "$SERVICE" --no-pager || true
    podman ps -a --filter name=systemd-openwook-redis
    ;;
  logs)
    journalctl --user -u "$SERVICE" -f
    ;;
  uninstall)
    systemctl --user stop "$SERVICE" 2>/dev/null || true
    rm -f "$QUADLET_DIR/openwook.network" "$QUADLET_DIR/openwook-redis.volume" "$QUADLET_DIR/openwook-redis.container"
    systemctl --user daemon-reload
    ;;
  *)
    echo "Usage: $0 {install|up|down|restart|status|logs|uninstall}" >&2
    exit 2
    ;;
esac
