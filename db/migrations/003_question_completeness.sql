-- Run once on the existing personal database after migrations 001 and 002.
-- Preserves records and answer versions; incomplete published questions become drafts.
BEGIN;
ALTER TABLE questions ALTER COLUMN question_type_id DROP NOT NULL, ALTER COLUMN answer_mode DROP NOT NULL, ALTER COLUMN stem DROP NOT NULL;
ALTER TABLE questions ADD COLUMN source_text text, ADD COLUMN draft_answer_payload jsonb, ADD COLUMN draft_items jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN missing_fields text[] NOT NULL DEFAULT '{}',
 ADD COLUMN missing_dependencies text[] NOT NULL DEFAULT '{}' CHECK(missing_dependencies <@ ARRAY['media','material']::text[]);
-- The original fresh schema and migration 002 used different shape-constraint names.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='questions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%IS NOT NULL%'
 LOOP EXECUTE format('ALTER TABLE questions DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE questions ADD CHECK(choice_variant IS NULL OR answer_mode IS NULL OR answer_mode='choice'),
 ADD CHECK(matching_variant IS NULL OR answer_mode IS NULL OR answer_mode='matching'),
 ADD CHECK(answer_mode IN ('choice','true_false','fill_blank','short_answer','ordering','matching'));
ALTER TABLE question_options ALTER COLUMN option_label DROP NOT NULL, ALTER COLUMN content DROP NOT NULL;
ALTER TABLE question_ordering_items ALTER COLUMN content DROP NOT NULL;
ALTER TABLE question_matching_items ALTER COLUMN content DROP NOT NULL, ALTER COLUMN side DROP NOT NULL;
-- Recover only source text actually retained in successful import task results.
UPDATE questions q SET source_text=nullif(btrim(t.result->'questions'->o.item_index->>'sourceText'),'')
 FROM question_import_job_outputs o JOIN question_import_jobs j ON j.id=o.job_id JOIN ai_tasks t ON t.id=j.ai_task_id
 WHERE q.id=o.question_id AND jsonb_typeof(t.result->'questions'->o.item_index->'sourceText')='string';

-- Completeness is derived inside the same transaction as every content mutation.
CREATE FUNCTION question_missing_fields(q questions) RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE missing text[] := '{}'; mode text := q.answer_mode;
BEGIN
 IF nullif(btrim(q.stem),'') IS NULL THEN missing := array_append(missing,'stem'); END IF;
 IF q.question_type_id IS NULL THEN missing := array_append(missing,'questionTypeId'); END IF;
 IF mode IS NULL THEN missing := array_append(missing,'answerMode'); END IF;
 IF mode='choice' THEN
  IF q.choice_variant IS NULL THEN missing := array_append(missing,'choiceVariant'); END IF;
  IF (SELECT count(*) FROM question_options WHERE question_id=q.id)<2 OR EXISTS(SELECT 1 FROM question_options WHERE question_id=q.id AND (option_label IS NULL OR content IS NULL)) THEN missing := array_append(missing,'options'); END IF;
 ELSIF mode='ordering' THEN
  IF (SELECT count(*) FROM question_ordering_items WHERE question_id=q.id)<2 OR EXISTS(SELECT 1 FROM question_ordering_items WHERE question_id=q.id AND content IS NULL) THEN missing := array_append(missing,'items'); END IF;
 ELSIF mode='matching' THEN
  IF q.matching_variant IS NULL THEN missing := array_append(missing,'matchingVariant'); END IF;
  IF (SELECT count(*) FROM question_matching_items WHERE question_id=q.id AND side='left')<2 OR (SELECT count(*) FROM question_matching_items WHERE question_id=q.id AND side='right')<2 OR EXISTS(SELECT 1 FROM question_matching_items WHERE question_id=q.id AND (side IS NULL OR content IS NULL)) THEN missing := array_append(missing,'items'); END IF;
 END IF;
 IF q.draft_answer_payload IS NOT NULL OR mode IS NULL OR NOT EXISTS(SELECT 1 FROM question_answer_keys WHERE question_id=q.id AND is_primary) THEN missing := array_append(missing,'answerPayload'); END IF;
 IF nullif(btrim(q.analysis),'') IS NULL THEN missing := array_append(missing,'analysis'); END IF;
 IF nullif(btrim(q.source_text),'') IS NULL THEN missing := array_append(missing,'sourceText'); END IF;
 IF 'media'=ANY(q.missing_dependencies) AND NOT EXISTS(
  SELECT 1 FROM media_links l JOIN media_assets a ON a.id=l.media_id
  WHERE a.deleted_at IS NULL AND a.media_type='image' AND (l.question_id=q.id OR l.group_id=q.group_id OR l.option_id IN (SELECT id FROM question_options WHERE question_id=q.id))
 ) THEN missing := array_append(missing,'media'); END IF;
 IF 'material'=ANY(q.missing_dependencies) AND NOT EXISTS(
  SELECT 1 FROM question_groups g WHERE g.id=q.group_id AND
  (nullif(btrim(g.instructions),'') IS NOT NULL OR EXISTS(SELECT 1 FROM question_content_blocks WHERE group_id=g.id))
 ) THEN missing := array_append(missing,'material'); END IF;
 RETURN missing;
END $$;
CREATE FUNCTION maintain_question_completeness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.missing_fields := question_missing_fields(NEW);
 IF cardinality(NEW.missing_fields)>0 AND NEW.status='active' THEN NEW.status := 'draft'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER question_completeness BEFORE INSERT OR UPDATE ON questions FOR EACH ROW EXECUTE FUNCTION maintain_question_completeness();

CREATE FUNCTION refresh_related_question_completeness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_row jsonb := CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb := CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
BEGIN
 UPDATE questions SET updated_at=now() WHERE id IN (
  SELECT (v->>'question_id')::bigint FROM (VALUES(before_row),(after_row)) AS t(v)
  UNION SELECT id FROM questions WHERE group_id IN ((before_row->>'group_id')::bigint,(after_row->>'group_id')::bigint)
  UNION SELECT question_id FROM question_options WHERE id IN ((before_row->>'option_id')::bigint,(after_row->>'option_id')::bigint)
  UNION SELECT id FROM questions WHERE TG_TABLE_NAME='question_groups' AND group_id IN ((before_row->>'id')::bigint,(after_row->>'id')::bigint)
 );
 RETURN NULL;
END $$;
CREATE TRIGGER option_completeness AFTER INSERT OR UPDATE OR DELETE ON question_options FOR EACH ROW EXECUTE FUNCTION refresh_related_question_completeness();
CREATE TRIGGER ordering_completeness AFTER INSERT OR UPDATE OR DELETE ON question_ordering_items FOR EACH ROW EXECUTE FUNCTION refresh_related_question_completeness();
CREATE TRIGGER matching_completeness AFTER INSERT OR UPDATE OR DELETE ON question_matching_items FOR EACH ROW EXECUTE FUNCTION refresh_related_question_completeness();
CREATE TRIGGER answer_completeness AFTER INSERT OR UPDATE OR DELETE ON question_answer_keys FOR EACH ROW EXECUTE FUNCTION refresh_related_question_completeness();
CREATE TRIGGER material_completeness AFTER INSERT OR UPDATE OR DELETE ON question_groups FOR EACH ROW EXECUTE FUNCTION refresh_related_question_completeness();
CREATE TRIGGER block_completeness AFTER INSERT OR UPDATE OR DELETE ON question_content_blocks FOR EACH ROW EXECUTE FUNCTION refresh_related_question_completeness();
CREATE TRIGGER media_completeness AFTER INSERT OR UPDATE OR DELETE ON media_links FOR EACH ROW EXECUTE FUNCTION refresh_related_question_completeness();

UPDATE questions SET updated_at=now();
COMMIT;
