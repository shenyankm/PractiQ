-- Apply only to the new single-user database; no legacy schemas or data are changed.
BEGIN;
ALTER TABLE ai_tasks DROP CONSTRAINT ai_tasks_kind_check;
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_kind_check
  CHECK (kind IN ('import', 'answer_generation', 'learning_report', 'bank_metadata'));
COMMIT;
