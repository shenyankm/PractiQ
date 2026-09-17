#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  container="practiq-personal-test-$$"
  trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
  docker run -d --name "$container" -e POSTGRES_USER=practiq -e POSTGRES_PASSWORD=practiq -e POSTGRES_DB=practiq_test -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
  for attempt in $(seq 1 30); do
    if docker exec "$container" pg_isready -U practiq -d practiq_test >/dev/null 2>&1; then break; fi
    if [[ "$attempt" == 30 ]]; then docker logs "$container"; exit 1; fi
    sleep 1
  done
  port=$(docker port "$container" 5432/tcp | sed 's/.*://')
  export TEST_DATABASE_URL="postgresql://practiq:practiq@127.0.0.1:${port}/practiq_test"
fi
"${PYTHON:-python}" -m pytest "$root/backend/tests" -q
