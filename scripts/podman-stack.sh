#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUADLET_DIR="${HOME}/.config/containers/systemd"
STACK_ENV_DIR="${HOME}/.config/practiq"
STACK_ENV_FILE="${STACK_ENV_DIR}/practiq-stack.env"
APP_DB_NAME=practiq_app
INFRA_SERVICES=(
  practiq-postgres.service
  practiq-redis.service
  practiq-ai.service
)
APP_SERVICES=(
  practiq-api.service
  practiq-worker.service
)
SERVICES=(
  "${INFRA_SERVICES[@]}"
  "${APP_SERVICES[@]}"
)
UNITS=(
  "$ROOT/containers/quadlet/practiq.network"
  "$ROOT/containers/quadlet/practiq-postgres.volume"
  "$ROOT/containers/quadlet/practiq-postgres.container"
  "$ROOT/containers/quadlet/practiq-redis.volume"
  "$ROOT/containers/quadlet/practiq-redis.container"
  "$ROOT/containers/quadlet/practiq-ai.container"
  "$ROOT/containers/quadlet/practiq-api.container"
  "$ROOT/containers/quadlet/practiq-worker.container"
)

random_hex() {
  local bytes="$1"
  od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
}

ensure_stack_env_file() {
  mkdir -p "$STACK_ENV_DIR"
  if [[ ! -f "$STACK_ENV_FILE" ]]; then
    cat >"$STACK_ENV_FILE" <<EOF
AUTH_SECRET=$(random_hex 32)
AI_SERVICE_TOKEN=ai-$(random_hex 24)
EOF
  fi
  chmod 600 "$STACK_ENV_FILE"
}

install_units() {
  mkdir -p "$QUADLET_DIR"
  ensure_stack_env_file
  for unit in "${UNITS[@]}"; do
    cp "$unit" "$QUADLET_DIR/"
  done
  systemctl --user daemon-reload
}

build_images() {
  podman build -f "$ROOT/Containerfile.ai" -t localhost/practiq-ai:latest "$ROOT"
  podman build -f "$ROOT/Containerfile.api" -t localhost/practiq-api:latest "$ROOT"
}

wait_for_postgres() {
  for _ in $(seq 1 60); do
    if podman exec practiq-postgres pg_isready -U practiq -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for PostgreSQL" >&2
  exit 1
}

ensure_app_database() {
  local exists
  exists="$(podman exec practiq-postgres psql -U practiq -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${APP_DB_NAME}'")"
  if [[ "${exists//[[:space:]]/}" != "1" ]]; then
    podman exec practiq-postgres psql -U practiq -d postgres -c "CREATE DATABASE ${APP_DB_NAME};"
  fi
}

start_stack() {
  systemctl --user start "${INFRA_SERVICES[@]}"
  wait_for_postgres
  ensure_app_database
  systemctl --user reset-failed "${APP_SERVICES[@]}" >/dev/null 2>&1 || true
  systemctl --user start "${APP_SERVICES[@]}"
}

case "${1:-status}" in
  build)
    build_images
    ;;
  install)
    install_units
    ;;
  up)
    build_images
    install_units
    start_stack
    ;;
  down)
    systemctl --user stop "${SERVICES[@]}"
    ;;
  restart)
    build_images
    systemctl --user stop "${SERVICES[@]}" 2>/dev/null || true
    install_units
    start_stack
    ;;
  status)
    systemctl --user status "${SERVICES[@]}" --no-pager || true
    podman ps -a --filter name=practiq
    ;;
  logs)
    journalctl --user -u practiq-api.service -u practiq-worker.service -u practiq-ai.service -u practiq-postgres.service -u practiq-redis.service -f
    ;;
  uninstall)
    systemctl --user stop "${SERVICES[@]}" 2>/dev/null || true
    rm -f \
      "$QUADLET_DIR/practiq.network" \
      "$QUADLET_DIR/practiq-postgres.volume" \
      "$QUADLET_DIR/practiq-postgres.container" \
      "$QUADLET_DIR/practiq-redis.volume" \
      "$QUADLET_DIR/practiq-redis.container" \
      "$QUADLET_DIR/practiq-ai.container" \
      "$QUADLET_DIR/practiq-api.container" \
      "$QUADLET_DIR/practiq-worker.container"
    systemctl --user daemon-reload
    ;;
  *)
    echo "Usage: $0 {build|install|up|down|restart|status|logs|uninstall}" >&2
    exit 2
    ;;
esac
