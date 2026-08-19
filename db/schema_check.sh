#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container="practiq-schema-check-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$container" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=practiq \
  postgres:16 >/dev/null

for attempt in $(seq 1 60); do
  if docker exec "$container" pg_isready -q -U postgres -d practiq; then
    break
  fi
  if [[ $attempt == 60 ]]; then
    docker logs "$container"
    exit 1
  fi
  sleep 1
done

psql=(docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U postgres -d practiq)
"${psql[@]}" <"$root/db/00_schema.sql"

"${psql[@]}" <<'SQL'
INSERT INTO question_types(id,subject_id,display_name,answer_mode)
VALUES ('schema_choice','general','Schema Choice','choice');

DO $$
DECLARE
  admin_id bigint;
  creator_id bigint;
  bank_id bigint;
  root_a bigint;
  child_b bigint;
  question_id bigint;
  task_id bigint;
  job_id bigint;
  order_id bigint;
BEGIN
  INSERT INTO users(display_name,role) VALUES ('Schema Admin','admin') RETURNING id INTO admin_id;
  INSERT INTO users(display_name) VALUES ('Schema Creator') RETURNING id INTO creator_id;
  INSERT INTO question_banks(owner_user_id,subject_id,name)
  VALUES (creator_id,'general','Schema Bank') RETURNING id INTO bank_id;

  INSERT INTO bank_subsets(bank_id,name,sort_order) VALUES (bank_id,'D',1);
  INSERT INTO bank_subsets(bank_id,name,sort_order) VALUES (bank_id,'A',2) RETURNING id INTO root_a;
  INSERT INTO bank_subsets(bank_id,parent_id,name,sort_order) VALUES (bank_id,root_a,'B',1) RETURNING id INTO child_b;
  INSERT INTO bank_subsets(bank_id,parent_id,name,sort_order) VALUES (bank_id,child_b,'C',1);

  INSERT INTO questions(owner_user_id,subject_id,question_type_id,answer_mode,choice_variant,stem)
  VALUES (creator_id,'general','schema_choice','choice','single','Schema question')
  RETURNING id INTO question_id;
  INSERT INTO question_options(question_id,option_label,sort_order,content)
  VALUES (question_id,'A',1,'Wrong'),(question_id,'B',2,'Right');
  INSERT INTO question_answer_keys(question_id,answer_mode,answer_payload)
  VALUES (question_id,'choice','{"correct":["B"]}');
  UPDATE questions SET status='active' WHERE id=question_id;

  INSERT INTO ai_tasks(user_id,kind,status,deadline_at,price_snapshot,estimated_credits,started_at)
  VALUES (admin_id,'answer_generation','running',now()+interval '180 seconds','{"model":"locked"}',1,now());
  INSERT INTO ai_tasks(user_id,kind,status,deadline_at,price_snapshot,estimated_credits,finished_at)
  VALUES (creator_id,'import','failed',now()+interval '180 seconds','{"model":"locked"}',1,now())
  RETURNING id INTO task_id;
  INSERT INTO ai_task_calls(task_id,model_id,input_tokens,output_tokens,input_price_per_1k,output_price_per_1k,call_kind)
  VALUES (task_id,'schema-model',10,5,0.01,0.02,'document_parse');
  INSERT INTO question_import_jobs(
    ai_task_id,created_by,bank_id,source_type,source_file_name,source_storage_path,
    source_size_bytes,status,retry_expires_at,source_deleted_at,completed_at
  ) VALUES (
    task_id,creator_id,bank_id,'pdf','schema.pdf','imports/schema.pdf',1,
    'failed',now()+interval '7 days',now(),now()
  ) RETURNING id INTO job_id;
  INSERT INTO question_import_job_events(job_id,stage,status)
  VALUES (job_id,'extract','failed');

  INSERT INTO payment_orders(
    user_id,kind,merchant_order_no,app_id,mch_id,amount_cents,expires_at,idempotency_key,request_hash
  ) VALUES (
    creator_id,'pro','schema-pro','app','merchant',2990,now()+interval '30 minutes','schema-pro',decode('01','hex')
  ) RETURNING id INTO order_id;
  UPDATE payment_orders SET status='paid',wechat_transaction_id='schema-wx',fulfilled_at=now() WHERE id=order_id;
  UPDATE users SET paid_pro_at=now() WHERE id=creator_id;
  INSERT INTO credit_ledger(user_id,kind,amount,idempotency_key,order_id)
  VALUES (creator_id,'bonus',200,'schema-bonus',order_id);
END
$$;

CREATE FUNCTION schema_refund(refund_credits numeric) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO payment_refunds(order_id,initiated_by,merchant_refund_no,amount_cents)
  SELECT o.id,u.id,'schema-refund',2990 FROM payment_orders o CROSS JOIN users u
  WHERE o.merchant_order_no='schema-pro' AND u.display_name='Schema Admin';
  UPDATE payment_refunds SET status='succeeded',wechat_refund_id='schema-refund-wx',processed_at=now()
  WHERE merchant_refund_no='schema-refund';
  UPDATE payment_orders SET status='refunded' WHERE merchant_order_no='schema-pro';
  UPDATE users SET paid_pro_at=NULL WHERE display_name='Schema Creator';
  INSERT INTO credit_ledger(user_id,kind,amount,idempotency_key,order_id)
  SELECT user_id,'payment_refund',refund_credits,'schema-refund-ledger',id
  FROM payment_orders WHERE merchant_order_no='schema-pro';
END
$$;
SQL

expect_failure() {
  local name=$1 expected=$2 output
  if output=$("${psql[@]}" 2>&1); then
    printf 'Expected failure was accepted: %s\n' "$name" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" <<<"$output"; then
    printf 'Unexpected failure for %s:\n%s\n' "$name" "$output" >&2
    exit 1
  fi
}

expect_failure "last active admin" "cannot remove last active admin" <<'SQL'
UPDATE users SET status='inactive' WHERE display_name='Schema Admin';
SQL

expect_failure "four-level subset tree" "invalid subset tree" <<'SQL'
UPDATE bank_subsets
SET parent_id=(SELECT id FROM bank_subsets WHERE name='D')
WHERE name='A';
SQL

expect_failure "incomplete active answer" "active question has incomplete answer" <<'SQL'
BEGIN;
INSERT INTO questions(owner_user_id,subject_id,question_type_id,answer_mode,stem)
SELECT id,'general','generic','short_answer','Empty answer' FROM users WHERE display_name='Schema Creator';
INSERT INTO question_answer_keys(question_id,answer_mode,answer_payload)
SELECT id,'short_answer','{"wrong":true}' FROM questions WHERE stem='Empty answer';
UPDATE questions SET status='active' WHERE stem='Empty answer';
COMMIT;
SQL

expect_failure "active choice option deletion" "active question has incomplete answer" <<'SQL'
DELETE FROM question_options WHERE option_label='A';
SQL

expect_failure "terminal AI task regression" "invalid AI task change" <<'SQL'
UPDATE ai_tasks SET status='queued',started_at=NULL,finished_at=NULL WHERE kind='import';
SQL

expect_failure "locked AI price mutation" "invalid AI task change" <<'SQL'
UPDATE ai_tasks SET price_snapshot='{"model":"rewritten"}' WHERE kind='answer_generation';
SQL

expect_failure "deleted source retry" "invalid import job change" <<'SQL'
UPDATE question_import_jobs
SET status='queued',completed_at=NULL,retry_count=retry_count+1
WHERE source_deleted_at IS NOT NULL;
SQL

expect_failure "AI usage mutation" "ai_task_calls is immutable" <<'SQL'
UPDATE ai_task_calls SET input_tokens=0;
SQL

expect_failure "import event deletion" "question_import_job_events is immutable" <<'SQL'
DELETE FROM question_import_job_events;
SQL

expect_failure "unfulfilled paid order" "paid Pro order requires entitlement and bonus" <<'SQL'
BEGIN;
INSERT INTO users(display_name) VALUES ('Unfulfilled Buyer');
INSERT INTO payment_orders(
  user_id,kind,merchant_order_no,app_id,mch_id,amount_cents,expires_at,idempotency_key,request_hash
)
SELECT id,'pro','unfulfilled-pro','app','merchant',2990,now()+interval '30 minutes','unfulfilled-pro',decode('02','hex')
FROM users WHERE display_name='Unfulfilled Buyer';
UPDATE payment_orders SET status='paid',wechat_transaction_id='unfulfilled-wx',fulfilled_at=now()
WHERE merchant_order_no='unfulfilled-pro';
COMMIT;
SQL

expect_failure "unfulfilled succeeded refund" "succeeded refund requires refunded order" <<'SQL'
BEGIN;
INSERT INTO payment_refunds(order_id,initiated_by,merchant_refund_no,amount_cents)
SELECT o.id,u.id,'orphan-refund',2990 FROM payment_orders o CROSS JOIN users u
WHERE o.merchant_order_no='schema-pro' AND u.display_name='Schema Admin';
UPDATE payment_refunds SET status='succeeded',wechat_refund_id='orphan-refund-wx',processed_at=now()
WHERE merchant_refund_no='orphan-refund';
COMMIT;
SQL

expect_failure "incorrect refund reversal" "invalid credit ledger direction or reference" <<'SQL'
SELECT schema_refund(-1);
SQL

"${psql[@]}" <<'SQL'
DO $$
DECLARE retry_user_id bigint; retry_bank_id bigint; retry_task_id bigint;
BEGIN
  INSERT INTO users(display_name) VALUES ('Retry User') RETURNING id INTO retry_user_id;
  INSERT INTO question_banks(owner_user_id,subject_id,name)
  VALUES (retry_user_id,'general','Retry Bank') RETURNING id INTO retry_bank_id;
  INSERT INTO ai_tasks(user_id,kind,status,deadline_at,price_snapshot,estimated_credits,finished_at,error)
  VALUES (retry_user_id,'import','failed',now()+interval '180 seconds','{"model":"locked"}',1,now(),'{"code":"FAILED"}')
  RETURNING id INTO retry_task_id;
  INSERT INTO question_import_jobs(
    ai_task_id,created_by,bank_id,source_type,source_file_name,source_storage_path,
    source_size_bytes,status,retry_expires_at,completed_at
  ) VALUES (
    retry_task_id,retry_user_id,retry_bank_id,'pdf','retry.pdf','imports/retry.pdf',1,
    'failed',now()+interval '7 days',now()
  );
  UPDATE ai_tasks SET status='queued',started_at=NULL,finished_at=NULL,error=NULL WHERE id=retry_task_id;
  UPDATE question_import_jobs
  SET status='queued',completed_at=NULL,retry_expires_at=NULL,retry_count=retry_count+1
  WHERE ai_task_id=retry_task_id;
END
$$;
SQL

"${psql[@]}" <<'SQL'
DO $$ BEGIN PERFORM schema_refund(-200); END $$;
SQL

printf 'Schema check passed.\n'
