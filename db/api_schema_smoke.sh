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
# Reconstruct the immediately pre-P1 shape ONLY inside this script's fresh disposable container.
# This destructive test setup is never part of the operator migration.
"${psql[@]}" <<'SQL'
DROP TABLE ai_report_sources;
ALTER TABLE ai_tasks DROP COLUMN source_question_id;
SQL
"${psql[@]}" <"$root/db/migrations/001_ai_task_worker.sql"
"${psql[@]}" <<'SQL'
INSERT INTO users(display_name) VALUES ('P1 migration preserved user') RETURNING id AS user_id \gset
INSERT INTO question_banks(owner_user_id,subject_id,name) VALUES (:user_id,'general','P1 migration preserved bank');
INSERT INTO ai_tasks(user_id,kind,status,deadline_at,price_snapshot,estimated_credits,finished_at,result)
 VALUES (:user_id,'answer_generation','succeeded',now()+interval '180 seconds','{}',1,now(),'{"text":"legacy result retained, never unscoped-readable"}');
INSERT INTO ai_tasks(user_id,kind,deadline_at,price_snapshot,estimated_credits)
 VALUES (:user_id,'answer_generation',now()+interval '180 seconds','{}',1);
INSERT INTO request_idempotency(user_id,route,idempotency_key,request_hash,expires_at)
 VALUES (:user_id,'PATCH /api/v1/users/me','preserved',decode('01','hex'),now()+interval '24 hours');
CREATE TABLE p1_upgrade_snapshot AS SELECT
 (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u) users,
 (SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM question_banks b) banks,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ai_tasks t) tasks,
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY user_id,route,idempotency_key) FROM request_idempotency r) requests;
SQL
"${psql[@]}" <"$root/db/migrations/002_p1_result_provenance.sql"
"${psql[@]}" <"$root/db/migrations/002_p1_result_provenance.sql"
"${psql[@]}" <<'SQL'
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM p1_upgrade_snapshot old WHERE
  old.users IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u) OR
  old.banks IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM question_banks b) OR
  old.tasks IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(t)-'source_question_id' ORDER BY id) FROM ai_tasks t) OR
  old.requests IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(r) ORDER BY user_id,route,idempotency_key) FROM request_idempotency r))
 THEN RAISE EXCEPTION 'P1 migration changed existing data'; END IF;
 IF EXISTS(SELECT 1 FROM ai_tasks WHERE source_question_id IS NOT NULL) OR EXISTS(SELECT 1 FROM ai_report_sources)
 THEN RAISE EXCEPTION 'P1 migration guessed legacy provenance'; END IF;
 BEGIN
  UPDATE ai_tasks SET source_question_id=1 WHERE status='queued';
  RAISE EXCEPTION 'P1 source provenance is mutable';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
DROP TABLE p1_upgrade_snapshot;
-- Retire only the synthetic queued fixture so it cannot be claimed by the worker HTTP regression.
UPDATE ai_tasks SET status='cancelled',finished_at=now()
 WHERE status='queued' AND user_id=(SELECT id FROM users WHERE display_name='P1 migration preserved user');
SQL
printf 'P1 additive migration and repeat-run preservation check passed.\n'
port=$(docker port "$container" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/')
PRACTIQ_DISPOSABLE_DB=true POSTGRES_URL="jdbc:postgresql://127.0.0.1:$port/practiq" POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres \
 mvn -q -f "$root/backend/pom.xml" -Dtest=SchemaIntegrationSmokeTest,InternalAiMigrationTest,P1HttpSchemaTest,IdempotencyPoolSchemaTest test
printf 'Java API schema smoke passed.\n'
