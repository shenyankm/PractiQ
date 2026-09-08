#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container="practiq-api-schema-smoke-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$container" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=practiq postgres:16 >/dev/null
for attempt in $(seq 1 60); do
  docker exec "$container" psql -q -U postgres -d practiq -c 'select 1' >/dev/null 2>&1 && break
  [[ $attempt == 60 ]] && {
    docker logs "$container"
    exit 1
  }
  sleep 1
done
psql=(docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U postgres -d practiq)
"${psql[@]}" <"$root/db/00_schema.sql"
port=$(docker port "$container" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/')
POSTGRES_URL="jdbc:postgresql://127.0.0.1:$port/practiq" POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres \
  mvn -q -f "$root/backend/pom.xml" -Dtest=SchemaIntegrationSmokeTest,InternalAiMigrationTest test
printf 'Java API schema smoke passed.\n'
