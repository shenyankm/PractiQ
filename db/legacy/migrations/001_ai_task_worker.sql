BEGIN;
ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS request_payload jsonb NOT NULL DEFAULT '{}';
ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS worker_id uuid;
ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS worker_lease_until timestamptz;
CREATE OR REPLACE FUNCTION validate_ai_task_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retrying boolean;
BEGIN
 retrying := OLD.status='failed' AND NEW.status='queued' AND OLD.kind='import'
   AND NEW.result IS NULL AND NEW.error IS NULL
   AND EXISTS(SELECT 1 FROM question_import_jobs j WHERE j.ai_task_id=OLD.id AND j.status='failed'
              AND j.source_deleted_at IS NULL AND j.source_storage_path IS NOT NULL AND j.retry_expires_at>now());
 IF (OLD.status IN ('succeeded','failed','cancelled','timed_out') AND NOT retrying)
    OR NEW.user_id<>OLD.user_id OR NEW.kind<>OLD.kind
    OR ((NEW.deadline_at IS DISTINCT FROM OLD.deadline_at OR NEW.attempt_started_at IS DISTINCT FROM OLD.attempt_started_at) AND NOT retrying)
    OR (retrying AND (NEW.deadline_at<=OLD.deadline_at OR NEW.attempt_started_at<=OLD.attempt_started_at OR NEW.attempt_started_at>clock_timestamp() OR NEW.deadline_at<=clock_timestamp() OR NEW.deadline_at>clock_timestamp()+interval '180 seconds'))
    OR NEW.price_snapshot IS DISTINCT FROM OLD.price_snapshot OR NEW.request_payload IS DISTINCT FROM OLD.request_payload OR NEW.estimated_credits<>OLD.estimated_credits
    OR NEW.created_at<>OLD.created_at
    OR (OLD.status='queued' AND NEW.status NOT IN ('queued','running','failed','cancelled','timed_out'))
    OR (OLD.status='running' AND NEW.status NOT IN ('running','succeeded','failed','cancelled','timed_out'))
    OR (OLD.status='running' AND NEW.started_at IS DISTINCT FROM OLD.started_at)
 THEN RAISE EXCEPTION 'invalid AI task change' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
COMMIT;
