import * as SQLite from 'expo-sqlite';

import { SCHEMA } from './schema';
import {
  assertCurrentPractiqSchema,
  assertPractiqSchema,
  MAX_DATABASE_BYTES,
  PRACTIQ_CURRENT_SCHEMA,
  PRACTIQ_REQUIRED_SCHEMA,
} from '../backup';
import { GROUP_LIFECYCLE_MIGRATION_SQL } from '../group-lifecycle';
import { IMPORT_STAGE } from '../import-status';
import {
  PRACTICE_SNAPSHOT_MEDIA_REFS_MIGRATION_SQL,
  PRACTICE_SNAPSHOT_MIGRATION_SQL,
  PRACTICE_SNAPSHOT_VIEW_SQL,
} from '../practice-snapshot';

export const DATABASE_VERSION = 19;

export const QUESTION_IMPORT_SOURCE_MIGRATION_SQL = `
CREATE TEMP TABLE practiq_v11_import_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO practiq_v11_import_guard(valid)
SELECT (SELECT COUNT(*) FROM artifacts) = (SELECT COUNT(*) FROM question_import_jobs)
  AND NOT EXISTS (
    SELECT 1 FROM question_import_jobs j
    WHERE (
      SELECT COUNT(*) FROM artifacts a
      WHERE a.job_id = j.id AND a.kind = 'source' AND a.uri = j.stored_uri
    ) <> 1
  );
DROP TABLE practiq_v11_import_guard;

ALTER TABLE question_import_jobs ADD COLUMN source_mime_type TEXT NOT NULL DEFAULT 'application/octet-stream';
ALTER TABLE question_import_jobs ADD COLUMN source_size INTEGER NOT NULL DEFAULT 0 CHECK (source_size >= 0);
ALTER TABLE question_import_jobs ADD COLUMN source_metadata_json TEXT
  CHECK (source_metadata_json IS NULL OR json_valid(source_metadata_json));
UPDATE question_import_jobs
SET (source_mime_type, source_size, source_metadata_json) = (
  SELECT mime_type, size, metadata_json FROM artifacts
  WHERE job_id = question_import_jobs.id AND kind = 'source'
);
DROP TABLE artifacts;
`;

export const IMPORT_STATUS_CODE_MIGRATION_SQL = `
UPDATE question_import_jobs
SET stage = CASE
  WHEN stage = '等待处理' THEN 'stage:queued'
  WHEN stage = '等待 AI 解析' THEN 'stage:waiting_ai'
  WHEN stage = '等待本地解析' THEN 'stage:queued'
  WHEN stage = '正在验证沙盒文件' THEN 'stage:validating_file'
  WHEN stage = '正在提取 DOCX 内容' THEN 'stage:reading_docx'
  WHEN stage = '正在读取 TXT 内容' THEN 'stage:reading_txt'
  WHEN stage = '正在等待 AI 服务解析' THEN 'stage:waiting_ai_service'
  WHEN stage = '正在识别题目结构' THEN 'stage:recognizing_questions'
  WHEN stage = '已取消' THEN 'stage:cancelled'
  WHEN stage = '导入失败' THEN 'stage:failed'
  WHEN stage = '等待手动重试' THEN 'stage:manual_retry'
  WHEN stage = '应用上次处理中断' THEN 'stage:interrupted'
  WHEN stage = '恢复后需要重新确认 AI 传输' THEN 'stage:restore_ai_confirmation'
  WHEN stage LIKE '正在写入 % 道题'
    THEN 'stage:writing:' || substr(stage, 6, length(stage) - 8)
  WHEN stage LIKE '已导入 % 道题'
    THEN 'stage:completed:' || substr(stage, 5, length(stage) - 7)
  WHEN stage LIKE '失败，% 秒后重试'
    THEN 'stage:retry_wait:' || substr(stage, 4, length(stage) - 8)
  ELSE stage
END;

UPDATE question_import_jobs
SET error = CASE error
  WHEN '应用在导入期间退出，请重试' THEN 'error:interrupted'
  WHEN '备份恢复后请手动重试并重新确认接收方与发送内容' THEN 'error:restore_ai_confirmation'
  ELSE error
END
WHERE error IS NOT NULL;

UPDATE events
SET message = CASE
  WHEN message = '文件已校验并复制到应用沙盒' THEN 'event:file_copied'
  WHEN message = '开始解析导入文档' THEN 'event:started'
  WHEN message = '使用者取消了导入' THEN 'event:cancelled'
  WHEN message = '已安排手动重试' THEN 'event:manual_retry'
  WHEN message = '正在验证沙盒文件' THEN 'stage:validating_file'
  WHEN message = '正在提取 DOCX 内容' THEN 'stage:reading_docx'
  WHEN message = '正在读取 TXT 内容' THEN 'stage:reading_txt'
  WHEN message = '正在等待 AI 服务解析' THEN 'stage:waiting_ai_service'
  WHEN message = '正在识别题目结构' THEN 'stage:recognizing_questions'
  WHEN message LIKE '正在写入 % 道题'
    THEN 'stage:writing:' || substr(message, 6, length(message) - 8)
  WHEN message LIKE '导入完成，共 % 道草稿题'
    THEN 'event:completed:' || substr(message, 8, length(message) - 12)
  ELSE message
END;
`;

const MIGRATIONS = [
  {
    version: 2,
    sql: `
DROP TRIGGER questions_fts_insert;
DROP TRIGGER questions_fts_delete;
DROP TRIGGER questions_fts_update;
DROP TABLE questions_fts;
CREATE VIRTUAL TABLE questions_fts USING fts5(
  stem,
  content='questions',
  content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER questions_fts_insert AFTER INSERT ON questions BEGIN
  INSERT INTO questions_fts(rowid, stem) VALUES (new.id, new.stem);
END;
CREATE TRIGGER questions_fts_delete AFTER DELETE ON questions BEGIN
  INSERT INTO questions_fts(questions_fts, rowid, stem) VALUES ('delete', old.id, old.stem);
END;
CREATE TRIGGER questions_fts_update AFTER UPDATE OF stem ON questions BEGIN
  INSERT INTO questions_fts(questions_fts, rowid, stem) VALUES ('delete', old.id, old.stem);
  INSERT INTO questions_fts(rowid, stem) VALUES (new.id, new.stem);
END;
INSERT INTO questions_fts(questions_fts) VALUES ('rebuild');

DROP TRIGGER active_question_requires_answer;
CREATE TRIGGER question_starts_as_draft
BEFORE INSERT ON questions
WHEN new.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'question must be created as draft');
END;
CREATE TRIGGER question_status_moves_forward
BEFORE UPDATE OF status ON questions
WHEN NOT (
  (old.status = 'draft' AND new.status IN ('draft', 'active')) OR
  (old.status = 'active' AND new.status IN ('active', 'archived')) OR
  (old.status = 'archived' AND new.status = 'archived')
)
BEGIN
  SELECT RAISE(ABORT, 'question status can only move draft to active to archived');
END;
CREATE TRIGGER active_question_requires_answer_update
BEFORE UPDATE OF status ON questions
WHEN new.status = 'active' AND NOT EXISTS (
  SELECT 1 FROM question_answer_keys WHERE question_id = new.id AND is_primary = 1
)
BEGIN
  SELECT RAISE(ABORT, 'active question requires a primary answer key');
END;

DELETE FROM media_links
WHERE id NOT IN (
  SELECT MIN(id) FROM media_links
  GROUP BY media_asset_id, question_id, option_id, group_id
);
CREATE UNIQUE INDEX unique_media_question
ON media_links(media_asset_id, question_id) WHERE question_id IS NOT NULL;
CREATE UNIQUE INDEX unique_media_option
ON media_links(media_asset_id, option_id) WHERE option_id IS NOT NULL;
CREATE UNIQUE INDEX unique_media_group
ON media_links(media_asset_id, group_id) WHERE group_id IS NOT NULL;
`,
  },
  {
    version: 3,
    sql: `
CREATE TRIGGER group_starts_as_draft
BEFORE INSERT ON question_groups
WHEN new.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'question group must be created as draft');
END;
CREATE TRIGGER group_status_moves_forward
BEFORE UPDATE OF status ON question_groups
WHEN NOT (
  (old.status = 'draft' AND new.status IN ('draft', 'active')) OR
  (old.status = 'active' AND new.status IN ('active', 'archived')) OR
  (old.status = 'archived' AND new.status = 'archived')
)
BEGIN
  SELECT RAISE(ABORT, 'question group status can only move draft to active to archived');
END;
CREATE TRIGGER active_group_requires_question
BEFORE UPDATE OF status ON question_groups
WHEN new.status = 'active' AND NOT EXISTS (
  SELECT 1 FROM group_question_links WHERE group_id = new.id
)
BEGIN
  SELECT RAISE(ABORT, 'active question group requires at least one question');
END;
CREATE TRIGGER group_archive_requires_inactive_questions
BEFORE UPDATE OF status ON question_groups
WHEN new.status = 'archived' AND EXISTS (
  SELECT 1 FROM group_question_links gql
  JOIN questions q ON q.id = gql.question_id
  WHERE gql.group_id = new.id AND q.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'archive active child questions before archiving their group');
END;
CREATE TRIGGER active_question_requires_active_group
BEFORE UPDATE OF status ON questions
WHEN new.status = 'active' AND EXISTS (
  SELECT 1 FROM group_question_links gql
  JOIN question_groups qg ON qg.id = gql.group_id
  WHERE gql.question_id = new.id AND qg.status <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'active question requires an active question group');
END;
CREATE TRIGGER active_question_group_link_requires_active_group
BEFORE INSERT ON group_question_links
WHEN EXISTS (SELECT 1 FROM questions q WHERE q.id = new.question_id AND q.status = 'active')
  AND EXISTS (SELECT 1 FROM question_groups qg WHERE qg.id = new.group_id AND qg.status <> 'active')
BEGIN
  SELECT RAISE(ABORT, 'active question requires an active question group');
END;
`,
  },
  {
    version: 4,
    sql: `
CREATE TRIGGER bank_question_subject_must_match
BEFORE INSERT ON bank_question_links
WHEN (SELECT subject_id FROM question_banks WHERE id = new.bank_id)
  <> (SELECT subject_id FROM questions WHERE id = new.question_id)
BEGIN
  SELECT RAISE(ABORT, 'question subject must match question bank');
END;
CREATE TRIGGER bank_group_subject_must_match
BEFORE INSERT ON bank_group_links
WHEN (SELECT subject_id FROM question_banks WHERE id = new.bank_id)
  <> (SELECT subject_id FROM question_groups WHERE id = new.group_id)
BEGIN
  SELECT RAISE(ABORT, 'question group subject must match question bank');
END;
CREATE TRIGGER group_question_subject_must_match
BEFORE INSERT ON group_question_links
WHEN (SELECT subject_id FROM question_groups WHERE id = new.group_id)
  <> (SELECT subject_id FROM questions WHERE id = new.question_id)
BEGIN
  SELECT RAISE(ABORT, 'question subject must match question group');
END;
CREATE TRIGGER linked_question_subject_is_immutable
BEFORE UPDATE OF subject_id ON questions
WHEN EXISTS (
  SELECT 1 FROM bank_question_links bql JOIN question_banks qb ON qb.id = bql.bank_id
  WHERE bql.question_id = old.id AND qb.subject_id <> new.subject_id
) OR EXISTS (
  SELECT 1 FROM group_question_links gql JOIN question_groups qg ON qg.id = gql.group_id
  WHERE gql.question_id = old.id AND qg.subject_id <> new.subject_id
)
BEGIN
  SELECT RAISE(ABORT, 'linked question subject must match its bank and group');
END;
CREATE TRIGGER linked_group_subject_is_immutable
BEFORE UPDATE OF subject_id ON question_groups
WHEN EXISTS (
  SELECT 1 FROM bank_group_links bgl JOIN question_banks qb ON qb.id = bgl.bank_id
  WHERE bgl.group_id = old.id AND qb.subject_id <> new.subject_id
) OR EXISTS (
  SELECT 1 FROM group_question_links gql JOIN questions q ON q.id = gql.question_id
  WHERE gql.group_id = old.id AND q.subject_id <> new.subject_id
)
BEGIN
  SELECT RAISE(ABORT, 'linked question group subject must match its bank and questions');
END;
CREATE TRIGGER populated_bank_subject_is_immutable
BEFORE UPDATE OF subject_id ON question_banks
WHEN EXISTS (SELECT 1 FROM bank_question_links WHERE bank_id = old.id)
  OR EXISTS (SELECT 1 FROM bank_group_links WHERE bank_id = old.id)
BEGIN
  SELECT RAISE(ABORT, 'question bank subject cannot change after content is added');
END;
`,
  },
  {
    version: 5,
    sql: `
CREATE INDEX IF NOT EXISTS content_blocks_question_order
ON question_content_blocks(question_id, sort_order, id) WHERE question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_blocks_group_order
ON question_content_blocks(group_id, sort_order, id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_links_question_order
ON media_links(question_id, sort_order, id) WHERE question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_links_option_order
ON media_links(option_id, sort_order, id) WHERE option_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_links_group_order
ON media_links(group_id, sort_order, id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_questions_question_order
ON group_question_links(question_id, sort_order, group_id);
`,
  },
  {
    version: 6,
    sql: PRACTICE_SNAPSHOT_MIGRATION_SQL,
  },
  {
    version: 7,
    sql: GROUP_LIFECYCLE_MIGRATION_SQL,
  },
  {
    version: 8,
    sql: `
DROP VIEW practice_question_snapshot_source;
${PRACTICE_SNAPSHOT_VIEW_SQL}
`,
  },
  {
    version: 9,
    sql: `
ALTER TABLE ai_consents ADD COLUMN model TEXT NOT NULL DEFAULT '';
DELETE FROM ai_consents;
`,
  },
  {
    version: 10,
    sql: `
ALTER TABLE question_import_jobs ADD COLUMN ai_profile TEXT CHECK (ai_profile IN ('cloud', 'local'));
ALTER TABLE question_import_jobs ADD COLUMN ai_profile_revision INTEGER CHECK (ai_profile_revision > 0);
UPDATE question_import_jobs SET ai_profile = 'cloud', ai_profile_revision = 1 WHERE parser = 'ai';
ALTER TABLE ai_consents ADD COLUMN ai_profile TEXT NOT NULL DEFAULT 'cloud' CHECK (ai_profile IN ('cloud', 'local'));
INSERT OR IGNORE INTO app_settings(key, value) VALUES
  ('ai_cloud_revision', '1'),
  ('ai_local_endpoint', ''),
  ('ai_local_model', ''),
  ('ai_local_provider_name', 'Local AI service'),
  ('ai_local_revision', '1');
`,
  },
  {
    version: 11,
    sql: QUESTION_IMPORT_SOURCE_MIGRATION_SQL,
  },
  {
    version: 12,
    sql: IMPORT_STATUS_CODE_MIGRATION_SQL,
  },
  {
    version: 13,
    sql: `
${IMPORT_STATUS_CODE_MIGRATION_SQL}
${PRACTICE_SNAPSHOT_MEDIA_REFS_MIGRATION_SQL}
CREATE INDEX idx_qkl_knowledge_question
ON question_knowledge_links(knowledge_point_id, question_id);
CREATE INDEX idx_answers_submitted
ON question_answers(submitted_at);
CREATE INDEX idx_sessions_status_started
ON practice_sessions(status, started_at DESC);
CREATE INDEX idx_content_blocks_media
ON question_content_blocks(media_asset_id) WHERE media_asset_id IS NOT NULL;
UPDATE bank_stats
SET sessions = (
  SELECT COUNT(*) FROM practice_sessions
  WHERE practice_sessions.bank_id = bank_stats.bank_id
    AND practice_sessions.status = 'completed'
);
`,
  },
  {
    version: 14,
    sql: `
CREATE INDEX idx_bank_groups_order
ON bank_group_links(bank_id, sort_order, group_id);
CREATE INDEX idx_group_questions_order
ON group_question_links(group_id, sort_order, question_id);
`,
  },
  {
    version: 15,
    sql: `
DROP TABLE events;
DROP TABLE practice_snapshot_media_refs;
DROP TABLE question_stats;
DROP TABLE bank_stats;

-- ponytail: aggregate local answer history on read; materialize only after measured UI latency.
CREATE VIEW question_stats AS
SELECT question_id,
  COUNT(*) AS attempts,
  COUNT(CASE WHEN is_correct = 1 THEN 1 END) AS correct_count,
  COUNT(CASE WHEN is_correct = 0 THEN 1 END) AS incorrect_count,
  MAX(submitted_at) AS last_answered_at
FROM question_answers
GROUP BY question_id;

CREATE VIEW bank_stats AS
WITH answer_stats AS (
  SELECT ps.bank_id,
    COUNT(*) AS answers,
    COUNT(CASE WHEN qa.is_correct = 1 THEN 1 END) AS correct_count,
    COUNT(CASE WHEN qa.is_correct = 0 THEN 1 END) AS incorrect_count,
    COALESCE(SUM(qa.score), 0) AS total_score,
    MAX(qa.submitted_at) AS last_answered_at
  FROM practice_sessions ps
  JOIN question_answers qa ON qa.session_id = ps.id
  GROUP BY ps.bank_id
), session_stats AS (
  SELECT bank_id,
    COUNT(CASE WHEN status = 'completed' THEN 1 END) AS sessions,
    MAX(completed_at) AS last_finished_at
  FROM practice_sessions
  WHERE status IN ('completed', 'abandoned')
  GROUP BY bank_id
)
SELECT qb.id AS bank_id,
  COALESCE(ss.sessions, 0) AS sessions,
  COALESCE(ans.answers, 0) AS answers,
  COALESCE(ans.correct_count, 0) AS correct_count,
  COALESCE(ans.incorrect_count, 0) AS incorrect_count,
  COALESCE(ans.total_score, 0) AS total_score,
  NULLIF(MAX(
    COALESCE(ans.last_answered_at, ''),
    COALESCE(ss.last_finished_at, '')
  ), '') AS last_practiced_at
FROM question_banks qb
LEFT JOIN answer_stats ans ON ans.bank_id = qb.id
LEFT JOIN session_stats ss ON ss.bank_id = qb.id;

CREATE TABLE latest_learning_report (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  report TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO latest_learning_report(id, report, created_at)
SELECT 1, report, created_at
FROM learning_reports
WHERE bank_id IS NULL
ORDER BY id DESC
LIMIT 1;
DROP TABLE learning_reports;
ALTER TABLE latest_learning_report RENAME TO learning_reports;
`,
  },
  {
    version: 16,
    sql: `
CREATE TEMP TABLE practiq_v16_integrity_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO practiq_v16_integrity_guard(valid)
SELECT
  NOT EXISTS (
    SELECT 1 FROM bank_question_links bql
    JOIN question_banks qb ON qb.id = bql.bank_id
    JOIN questions q ON q.id = bql.question_id
    WHERE qb.subject_id <> q.subject_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM bank_group_links bgl
    JOIN question_banks qb ON qb.id = bgl.bank_id
    JOIN question_groups qg ON qg.id = bgl.group_id
    WHERE qb.subject_id <> qg.subject_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM group_question_links gql
    JOIN question_groups qg ON qg.id = gql.group_id
    JOIN questions q ON q.id = gql.question_id
    WHERE qg.subject_id <> q.subject_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM question_knowledge_links qkl
    JOIN questions q ON q.id = qkl.question_id
    JOIN knowledge_points kp ON kp.id = qkl.knowledge_point_id
    WHERE q.subject_id <> kp.subject_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM practice_session_questions
    WHERE snapshot_json IS NULL OR json_type(snapshot_json) <> 'object'
  );
DROP TABLE practiq_v16_integrity_guard;

CREATE TRIGGER bank_question_subject_update_must_match
BEFORE UPDATE OF bank_id, question_id ON bank_question_links
WHEN (SELECT subject_id FROM question_banks WHERE id = new.bank_id)
  <> (SELECT subject_id FROM questions WHERE id = new.question_id)
BEGIN
  SELECT RAISE(ABORT, 'question subject must match question bank');
END;
CREATE TRIGGER bank_group_subject_update_must_match
BEFORE UPDATE OF bank_id, group_id ON bank_group_links
WHEN (SELECT subject_id FROM question_banks WHERE id = new.bank_id)
  <> (SELECT subject_id FROM question_groups WHERE id = new.group_id)
BEGIN
  SELECT RAISE(ABORT, 'question group subject must match question bank');
END;
CREATE TRIGGER group_question_subject_update_must_match
BEFORE UPDATE OF group_id, question_id ON group_question_links
WHEN (SELECT subject_id FROM question_groups WHERE id = new.group_id)
  <> (SELECT subject_id FROM questions WHERE id = new.question_id)
BEGIN
  SELECT RAISE(ABORT, 'question subject must match question group');
END;
CREATE TRIGGER question_knowledge_subject_must_match
BEFORE INSERT ON question_knowledge_links
WHEN (SELECT subject_id FROM questions WHERE id = new.question_id)
  <> (SELECT subject_id FROM knowledge_points WHERE id = new.knowledge_point_id)
BEGIN
  SELECT RAISE(ABORT, 'question subject must match knowledge point');
END;
CREATE TRIGGER question_knowledge_subject_update_must_match
BEFORE UPDATE OF question_id, knowledge_point_id ON question_knowledge_links
WHEN (SELECT subject_id FROM questions WHERE id = new.question_id)
  <> (SELECT subject_id FROM knowledge_points WHERE id = new.knowledge_point_id)
BEGIN
  SELECT RAISE(ABORT, 'question subject must match knowledge point');
END;
CREATE TRIGGER linked_question_knowledge_subject_is_immutable
BEFORE UPDATE OF subject_id ON questions
WHEN EXISTS (
  SELECT 1 FROM question_knowledge_links qkl
  JOIN knowledge_points kp ON kp.id = qkl.knowledge_point_id
  WHERE qkl.question_id = old.id AND kp.subject_id <> new.subject_id
)
BEGIN
  SELECT RAISE(ABORT, 'linked question subject must match its knowledge points');
END;
CREATE TRIGGER linked_knowledge_point_subject_is_immutable
BEFORE UPDATE OF subject_id ON knowledge_points
WHEN EXISTS (
  SELECT 1 FROM question_knowledge_links qkl
  JOIN questions q ON q.id = qkl.question_id
  WHERE qkl.knowledge_point_id = old.id AND q.subject_id <> new.subject_id
)
BEGIN
  SELECT RAISE(ABORT, 'linked knowledge point subject must match its questions');
END;
`,
  },
  {
    version: 17,
    sql: `
CREATE INDEX idx_questions_status ON questions(status);
CREATE INDEX idx_banks_recent ON question_banks(updated_at DESC, id DESC);
`,
  },
  {
    version: 18,
    sql: `
CREATE INDEX IF NOT EXISTS idx_answers_question_stats
ON question_answers(question_id, is_correct, submitted_at);
CREATE INDEX IF NOT EXISTS idx_answers_session_stats
ON question_answers(session_id, is_correct, score);
`,
  },
  {
    // AI moved to the PractiQ cloud service: local AI configuration and the
    // per-request consent log are gone. question_import_jobs keeps its
    // ai_profile columns for historical rows.
    version: 19,
    sql: `
DROP TABLE IF EXISTS ai_consents;
DELETE FROM app_settings WHERE key IN (
  'ai_endpoint', 'ai_model', 'ai_provider_name', 'ai_cloud_revision',
  'ai_local_endpoint', 'ai_local_model', 'ai_local_provider_name', 'ai_local_revision'
);
`,
  },
] as const;

export async function migrateDatabase(
  db: SQLite.SQLiteDatabase,
  options: { targetVersion?: number } = {},
) {
  const targetVersion = options.targetVersion ?? DATABASE_VERSION;
  if (!Number.isInteger(targetVersion) || targetVersion < 1 || targetVersion > DATABASE_VERSION) {
    throw new Error('数据库目标版本无效');
  }
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let currentVersion = row?.user_version ?? 0;
  let schemaChanged = false;
  if (currentVersion > targetVersion) {
    throw new Error('数据库版本高于当前应用版本，请更新 PractiQ。');
  }
  if (currentVersion === 0) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(SCHEMA);
      await db.execAsync('PRAGMA user_version = 1');
    });
    currentVersion = 1;
    schemaChanged = true;
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion || migration.version > targetVersion) continue;
    await db.withTransactionAsync(async () => {
      await db.execAsync(migration.sql);
      await db.runAsync('INSERT INTO schema_migrations(version) VALUES (?)', migration.version);
      await db.execAsync(`PRAGMA user_version = ${migration.version}`);
    });
    currentVersion = migration.version;
    schemaChanged = true;
  }
  const migrationVersions = new Set((await db.getAllAsync<{ version: number }>(
    'SELECT version FROM schema_migrations',
  )).map((migration) => migration.version));
  for (let version = 1; version <= targetVersion; version += 1) {
    if (!migrationVersions.has(version)) throw new Error('数据库迁移记录不完整');
  }
  if (targetVersion === DATABASE_VERSION) {
    const currentSchema: Record<string, string[]> = {};
    const tables = [...new Set([
      ...Object.keys(PRACTIQ_REQUIRED_SCHEMA),
      ...Object.keys(PRACTIQ_CURRENT_SCHEMA),
    ])];
    for (const table of tables) currentSchema[table] = [];
    for (const column of await db.getAllAsync<{ table_name: string; column_name: string }>(
      `SELECT schema.name AS table_name, columns.name AS column_name
       FROM sqlite_schema schema, pragma_table_info(schema.name) columns
       WHERE schema.type = 'table'
         AND schema.name IN (${tables.map(() => '?').join(',')})
       ORDER BY schema.name, columns.cid`,
      tables,
    )) {
      currentSchema[column.table_name]?.push(column.column_name);
    }
    const currentObjects: Record<string, string[]> = {};
    for (const object of await db.getAllAsync<{ type: string; name: string }>(
      "SELECT type, name FROM sqlite_schema WHERE type IN ('view', 'trigger', 'index')",
    )) (currentObjects[object.type] ??= []).push(object.name);
    assertPractiqSchema(currentSchema);
    assertCurrentPractiqSchema(currentSchema, currentObjects);
    const pageSize = (await db.getFirstAsync<{ page_size: number }>('PRAGMA page_size'))?.page_size ?? 4096;
    const maxPageCount = Math.floor(MAX_DATABASE_BYTES / pageSize);
    await db.execAsync(`PRAGMA max_page_count = ${maxPageCount}`);
  }
  await db.runAsync(
    `UPDATE question_import_jobs
     SET status = 'failed', stage = ?, error = 'error:interrupted', finished_at = CURRENT_TIMESTAMP
     WHERE status = 'running'`,
    IMPORT_STAGE.interrupted,
  );
  const cleanShutdown = !schemaChanged && Boolean(
    (await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'clean_shutdown'",
    ))?.value === '1',
  );
  await db.runAsync(
    `INSERT INTO app_settings(key, value) VALUES ('clean_shutdown', '0')
     ON CONFLICT(key) DO UPDATE SET value = '0', updated_at = CURRENT_TIMESTAMP`,
  );
  const integrityPragma = schemaChanged ? 'integrity_check' : 'quick_check';
  const integrity = await db.getFirstAsync<Record<string, string>>(`PRAGMA ${integrityPragma}`);
  const integrityResult = integrity?.[integrityPragma];
  if (integrityResult !== 'ok') {
    throw new Error(`数据库完整性检查失败：${integrityResult ?? '未知错误'}`);
  }
  if (!cleanShutdown) {
    const foreignKeyErrors = await db.getAllAsync('PRAGMA foreign_key_check');
    if (foreignKeyErrors.length) throw new Error(`数据库外键检查失败：${foreignKeyErrors.length} 项`);
  }
}

/** Call when the app transitions to background to mark a clean shutdown for next startup. */
export async function markCleanShutdown(db: SQLite.SQLiteDatabase) {
  await db.runAsync(
    `INSERT INTO app_settings(key, value) VALUES ('clean_shutdown', '1')
     ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = CURRENT_TIMESTAMP`,
  ).catch(() => undefined);
}
