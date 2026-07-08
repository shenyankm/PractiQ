#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

AI_HOST="${AI_HOST:-127.0.0.1}"
AI_PORT="${AI_PORT:-8001}"
OPENWOOK_HOST="${OPENWOOK_HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
VITE_HOST="${VITE_HOST:-127.0.0.1}"
VITE_PORT="${VITE_PORT:-3000}"
POSTGRES_URL="${POSTGRES_URL:-postgres://openwook:openwook@localhost:54322/openwook_app}"
DATABASE_URL="${DATABASE_URL:-$POSTGRES_URL}"
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
AI_SERVICE_URL="${AI_SERVICE_URL:-http://$AI_HOST:$AI_PORT}"
AI_SERVICE_TOKEN="${AI_SERVICE_TOKEN:-dev-ai-token}"
NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL:-http://$VITE_HOST:$VITE_PORT}"
GO_API_URL="${GO_API_URL:-http://$OPENWOOK_HOST:$PORT}"

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

AI_SERVICE_TOKEN="$AI_SERVICE_TOKEN" python -m uvicorn openwook_ai.main:app --app-dir ai --host "$AI_HOST" --port "$AI_PORT" &
pids+=("$!")
AI_SERVICE_TOKEN="$AI_SERVICE_TOKEN" AUTH_SECRET="${AUTH_SECRET:-development-secret}" AI_SERVICE_URL="$AI_SERVICE_URL" NEXT_PUBLIC_APP_URL="$NEXT_PUBLIC_APP_URL" OPENWOOK_HOST="$OPENWOOK_HOST" PORT="$PORT" POSTGRES_URL="$POSTGRES_URL" DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" go run ./cmd/openwook-api &
pids+=("$!")
AI_SERVICE_TOKEN="$AI_SERVICE_TOKEN" AI_SERVICE_URL="$AI_SERVICE_URL" POSTGRES_URL="$POSTGRES_URL" DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" go run ./cmd/openwook-worker &
pids+=("$!")
GO_API_URL="$GO_API_URL" pnpm dev --host "$VITE_HOST" --port "$VITE_PORT" &
pids+=("$!")

for _ in $(seq 1 120); do
  if curl -fsS "http://$VITE_HOST:$VITE_PORT" >/dev/null 2>&1; then
    wait
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for Vite dev server" >&2
exit 1
