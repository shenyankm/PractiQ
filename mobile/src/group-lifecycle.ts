export const GROUP_LIFECYCLE_MIGRATION_SQL = `
DROP TRIGGER IF EXISTS active_question_group_link_requires_active_group;

CREATE TRIGGER active_question_group_link_rejects_archived_group
BEFORE INSERT ON group_question_links
WHEN EXISTS (SELECT 1 FROM questions q WHERE q.id = new.question_id AND q.status = 'active')
  AND EXISTS (SELECT 1 FROM question_groups qg WHERE qg.id = new.group_id AND qg.status = 'archived')
BEGIN
  SELECT RAISE(ABORT, 'active question cannot join an archived question group');
END;

CREATE TRIGGER active_question_activates_draft_group
AFTER INSERT ON group_question_links
WHEN EXISTS (SELECT 1 FROM questions q WHERE q.id = new.question_id AND q.status = 'active')
  AND EXISTS (SELECT 1 FROM question_groups qg WHERE qg.id = new.group_id AND qg.status = 'draft')
BEGIN
  UPDATE question_groups SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = new.group_id;
END;

CREATE TRIGGER empty_active_group_is_archived
AFTER DELETE ON group_question_links
WHEN EXISTS (SELECT 1 FROM question_groups qg WHERE qg.id = old.group_id AND qg.status = 'active')
  AND NOT EXISTS (SELECT 1 FROM group_question_links WHERE group_id = old.group_id)
BEGIN
  UPDATE question_groups SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = old.group_id;
END;
`;
