#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUADLET_DIR="${HOME}/.config/containers/systemd"
STACK_ENV_DIR="${HOME}/.config/openwook"
STACK_ENV_FILE="${STACK_ENV_DIR}/openwook-stack.env"
APP_DB_NAME=openwook_app
INFRA_SERVICES=(
  openwook-postgres.service
  openwook-redis.service
  openwook-ai.service
)
APP_SERVICES=(
  openwook-api.service
  openwook-worker.service
)
SERVICES=(
  "${INFRA_SERVICES[@]}"
  "${APP_SERVICES[@]}"
)
UNITS=(
  "$ROOT/containers/quadlet/openwook.network"
  "$ROOT/containers/quadlet/openwook-postgres.volume"
  "$ROOT/containers/quadlet/openwook-postgres.container"
  "$ROOT/containers/quadlet/openwook-redis.volume"
  "$ROOT/containers/quadlet/openwook-redis.container"
  "$ROOT/containers/quadlet/openwook-ai.container"
  "$ROOT/containers/quadlet/openwook-api.container"
  "$ROOT/containers/quadlet/openwook-worker.container"
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

  if [[ -z "$(read_stack_env_value AI_POSTGRES_URL)" ]]; then
    local ai_db_password
    ai_db_password="$(random_hex 24)"
    cat >>"$STACK_ENV_FILE" <<EOF
AI_DB_PASSWORD=$ai_db_password
AI_POSTGRES_URL=postgres://openwook_ai:$ai_db_password@openwook-postgres:5432/openwook_app
EOF
  fi
  chmod 600 "$STACK_ENV_FILE"
}

read_stack_env_value() {
  local wanted="$1"
  local key value found=""
  [[ -f "$STACK_ENV_FILE" ]] || return 0
  while IFS='=' read -r key value; do
    if [[ "$key" == "$wanted" ]]; then
      found="$value"
    fi
  done <"$STACK_ENV_FILE"
  printf '%s' "$found"
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
  podman build -f "$ROOT/Containerfile.ai" -t localhost/openwook-ai:latest "$ROOT"
  podman build -f "$ROOT/Containerfile.api" -t localhost/openwook-api:latest "$ROOT"
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

ensure_ai_database_role() {
  local password
  password="$(read_stack_env_value AI_DB_PASSWORD)"
  if [[ -z "$password" ]]; then
    return
  fi

  podman exec -i openwook-postgres psql \
    -v ON_ERROR_STOP=1 \
    -v ai_password="$password" \
    -U openwook \
    -d "$APP_DB_NAME" <<'SQL'
SELECT 'CREATE ROLE openwook_ai LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openwook_ai')
\gexec
SELECT format('ALTER ROLE openwook_ai LOGIN PASSWORD %L', :'ai_password')
\gexec
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO openwook_ai', current_database());
  GRANT USAGE ON SCHEMA public TO openwook_ai;
  IF to_regclass('public.question_import_jobs') IS NOT NULL THEN
    GRANT SELECT (id, created_by, bank_id) ON question_import_jobs TO openwook_ai;
  END IF;
  IF to_regclass('public.ai_artifacts') IS NOT NULL THEN
    GRANT INSERT, SELECT (id) ON ai_artifacts TO openwook_ai;
    GRANT USAGE, SELECT ON SEQUENCE ai_artifacts_id_seq TO openwook_ai;
  END IF;
END
$$;
SQL
}

start_stack() {
  systemctl --user start "${INFRA_SERVICES[@]}"
  wait_for_postgres
  ensure_app_database
  ensure_ai_database_role
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
    podman ps -a --filter name=openwook
    ;;
  logs)
    journalctl --user -u openwook-api.service -u openwook-worker.service -u openwook-ai.service -u openwook-postgres.service -u openwook-redis.service -f
    ;;
  uninstall)
    systemctl --user stop "${SERVICES[@]}" 2>/dev/null || true
    rm -f \
      "$QUADLET_DIR/openwook.network" \
      "$QUADLET_DIR/openwook-postgres.volume" \
      "$QUADLET_DIR/openwook-postgres.container" \
      "$QUADLET_DIR/openwook-redis.volume" \
      "$QUADLET_DIR/openwook-redis.container" \
      "$QUADLET_DIR/openwook-ai.container" \
      "$QUADLET_DIR/openwook-api.container" \
      "$QUADLET_DIR/openwook-worker.container"
    systemctl --user daemon-reload
    ;;
  *)
    echo "Usage: $0 {build|install|up|down|restart|status|logs|uninstall}" >&2
    exit 2
    ;;
esac
