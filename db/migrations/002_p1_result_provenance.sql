-- Non-destructive P1 upgrade after 001_ai_task_worker.sql. Safe to repeat.
-- Stop API/workers first; do not infer or backfill sensitive legacy result sources.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS source_question_id bigint;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='ai_tasks'::regclass AND conname='ai_tasks_source_question_id_check') THEN
  ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_source_question_id_check
   CHECK(source_question_id IS NULL OR (source_question_id>0 AND kind='answer_generation'));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS ai_report_sources (
 task_id bigint NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
 bank_id bigint NOT NULL, question_id bigint NOT NULL,
 PRIMARY KEY(task_id,bank_id,question_id)
);
CREATE OR REPLACE FUNCTION validate_ai_task_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retrying boolean;
BEGIN
 retrying := OLD.status='failed' AND NEW.status='queued' AND OLD.kind='import'
   AND NEW.result IS NULL AND NEW.error IS NULL
   AND EXISTS(SELECT 1 FROM question_import_jobs j WHERE j.ai_task_id=OLD.id AND j.status='failed'
              AND j.source_deleted_at IS NULL AND j.source_storage_path IS NOT NULL AND j.retry_expires_at>now());
 IF (OLD.status IN ('succeeded','failed','cancelled','timed_out') AND NOT retrying)
    OR NEW.user_id<>OLD.user_id OR NEW.kind<>OLD.kind OR NEW.source_question_id IS DISTINCT FROM OLD.source_question_id
    OR ((NEW.deadline_at IS DISTINCT FROM OLD.deadline_at OR NEW.attempt_started_at IS DISTINCT FROM OLD.attempt_started_at) AND NOT retrying)
    OR (retrying AND (NEW.deadline_at<=OLD.deadline_at OR NEW.attempt_started_at<=OLD.attempt_started_at OR NEW.attempt_started_at>clock_timestamp() OR NEW.deadline_at<=clock_timestamp() OR NEW.deadline_at>clock_timestamp()+interval '180 seconds'))
    OR NEW.price_snapshot IS DISTINCT FROM OLD.price_snapshot OR NEW.request_payload IS DISTINCT FROM OLD.request_payload OR NEW.estimated_credits<>OLD.estimated_credits
    OR NEW.created_at<>OLD.created_at
    OR (OLD.status='queued' AND NEW.status NOT IN ('queued','running','failed','cancelled','timed_out'))
    OR (OLD.status='running' AND NEW.status NOT IN ('running','succeeded','failed','cancelled','timed_out'))
    OR (OLD.status='running' AND NEW.started_at IS DISTINCT FROM OLD.started_at)
 THEN RAISE EXCEPTION 'invalid AI task change' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
COMMIT;
