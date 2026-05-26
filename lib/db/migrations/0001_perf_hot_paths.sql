CREATE INDEX IF NOT EXISTS idx_bank_question_links_bank_status_sort
    ON bank_question_links (bank_id, status, sort_order, question_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_group_links_bank_status_sort
    ON bank_group_links (bank_id, status, sort_order, group_id);
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_questions_stem_trgm
    ON questions USING GIN (stem gin_trgm_ops);
--> statement-breakpoint
DROP INDEX IF EXISTS idx_questions_stem_fts;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_questions_stem_fts
    ON questions USING GIN (to_tsvector('simple', COALESCE(stem, '')));
