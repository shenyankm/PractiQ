// SQLite 结构化镜像表 DDL(user_version = 2)。
// 列名 snake_case 与 API/PostgreSQL 一致;布尔 → INTEGER 0/1;时间戳 → TEXT(ISO 毫秒 Z 原样存);
// JSON → TEXT;id → INTEGER。
// 列取舍规则:只镜像 API 实际交付的列;不镜像 API 从不返回的服务端运维列
// (link 表 added_by/*_subject、media storage_path/oss/checksum、import jobs 全表)。
// link 表的 PG 自增 id 未在 API 暴露,本地用业务复合主键代替(与 PG 的唯一约束一致)。
// v1 暂不镜像(后续可加):question_content_blocks、option/group 的 media links、
// user_question_stats、user_bank_stats、import jobs、knowledge_points。

export const MIRROR_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS subjects (
    subject_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS question_types (
    type_id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    scope TEXT NOT NULL,
    default_answer_mode TEXT
  );

  CREATE TABLE IF NOT EXISTS question_banks (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    subject TEXT NOT NULL,
    total_count INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    is_public INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS user_bank_links (
    user_id INTEGER NOT NULL,
    bank_id INTEGER NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
    is_owner INTEGER NOT NULL DEFAULT 0,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT,
    PRIMARY KEY (user_id, bank_id)
  );
  CREATE INDEX IF NOT EXISTS user_bank_links_user ON user_bank_links(user_id);

  -- list API 只交付 id/group_type_id/title/instructions/content_mode,其余列由 detail API 补齐,允许 NULL。
  CREATE TABLE IF NOT EXISTS question_groups (
    id INTEGER PRIMARY KEY,
    business_type TEXT,
    subject_id TEXT,
    group_type_id TEXT,
    parent_group_id INTEGER,
    hierarchy_level INTEGER,
    hierarchy_path TEXT,
    chapter_ref TEXT,
    chapter_title TEXT,
    chapter_order INTEGER,
    title TEXT,
    instructions TEXT,
    source_ref TEXT,
    content_mode TEXT,
    detail_payload TEXT,
    imported_by INTEGER,
    source_job_id INTEGER,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS bank_group_links (
    bank_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT,
    updated_at TEXT,
    PRIMARY KEY (bank_id, group_id)
  );
  CREATE INDEX IF NOT EXISTS bank_group_links_bank ON bank_group_links(bank_id, sort_order);

  CREATE TABLE IF NOT EXISTS bank_question_links (
    bank_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 1,
    question_no TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT,
    updated_at TEXT,
    PRIMARY KEY (bank_id, question_id)
  );
  CREATE INDEX IF NOT EXISTS bank_question_links_bank ON bank_question_links(bank_id, sort_order);

  CREATE TABLE IF NOT EXISTS group_question_links (
    group_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 1,
    question_no TEXT,
    created_at TEXT,
    updated_at TEXT,
    PRIMARY KEY (group_id, question_id)
  );
  CREATE INDEX IF NOT EXISTS group_question_links_group ON group_question_links(group_id, sort_order);

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY,
    business_type TEXT,
    subject_id TEXT,
    question_type_id TEXT NOT NULL,
    answer_mode TEXT NOT NULL,
    choice_variant TEXT,
    content_mode TEXT,
    stem TEXT NOT NULL,
    analysis TEXT,
    detail_payload TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS question_options (
    id INTEGER PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    option_label TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    content TEXT NOT NULL,
    is_correct INTEGER,
    created_at TEXT,
    updated_at TEXT,
    UNIQUE(question_id, option_label)
  );
  CREATE INDEX IF NOT EXISTS question_options_question ON question_options(question_id, sort_order);

  CREATE TABLE IF NOT EXISTS question_answer_keys (
    id INTEGER PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    answer_mode TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    is_primary INTEGER NOT NULL DEFAULT 1,
    answer_payload TEXT NOT NULL DEFAULT '{}',
    explanation_payload TEXT NOT NULL DEFAULT '{}',
    score_payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS question_answer_keys_question ON question_answer_keys(question_id);

  CREATE TABLE IF NOT EXISTS media_assets (
    id INTEGER PRIMARY KEY,
    created_by INTEGER,
    external_url TEXT,
    content_url TEXT NOT NULL,
    original_name TEXT,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    size_bytes INTEGER,
    duration_ms INTEGER,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS question_media_links (
    id INTEGER PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    media_kind TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 1,
    created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS question_media_links_question ON question_media_links(question_id, sort_order);

  CREATE TABLE IF NOT EXISTS user_practice_sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    bank_id INTEGER,
    session_type TEXT NOT NULL,
    status TEXT NOT NULL,
    question_count INTEGER NOT NULL DEFAULT 0,
    answered_count INTEGER NOT NULL DEFAULT 0,
    correct_count INTEGER NOT NULL DEFAULT 0,
    wrong_count INTEGER NOT NULL DEFAULT 0,
    score REAL,
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS user_practice_sessions_user ON user_practice_sessions(user_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS user_question_answers (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    session_id INTEGER NOT NULL,
    bank_id INTEGER,
    question_id INTEGER NOT NULL,
    answer_key_id INTEGER,
    answer_payload TEXT NOT NULL DEFAULT '{}',
    is_correct INTEGER,
    score REAL,
    max_score REAL,
    duration_ms INTEGER,
    answered_at TEXT
  );
  CREATE INDEX IF NOT EXISTS user_question_answers_session ON user_question_answers(session_id);

  CREATE TABLE IF NOT EXISTS sync_state (
    scope TEXT PRIMARY KEY,
    synced_at TEXT NOT NULL
  );
`;

// 清库顺序:先子表后父表(foreign_keys = ON 时父表行被引用不可直接删)。
export const MIRROR_TABLES = [
  'user_question_answers',
  'user_practice_sessions',
  'question_media_links',
  'question_answer_keys',
  'question_options',
  'group_question_links',
  'bank_question_links',
  'bank_group_links',
  'user_bank_links',
  'media_assets',
  'question_groups',
  'questions',
  'question_banks',
  'question_types',
  'subjects',
  'sync_state',
] as const;
