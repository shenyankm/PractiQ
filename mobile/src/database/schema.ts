export const SCHEMA = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE question_types (
  code TEXT PRIMARY KEY CHECK (code IN ('single_choice','multiple_choice','true_false','fill_blank','short_answer')),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE knowledge_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES knowledge_points(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE question_banks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(subject_id, name)
);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  question_type_code TEXT NOT NULL REFERENCES question_types(code) ON DELETE RESTRICT,
  stem TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  difficulty INTEGER NOT NULL DEFAULT 3 CHECK (difficulty BETWEEN 1 AND 5),
  default_score REAL NOT NULL DEFAULT 1 CHECK (default_score >= 0),
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE bank_question_links (
  bank_id INTEGER NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bank_id, question_id)
);

CREATE TABLE question_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(question_id, label)
);

CREATE TABLE question_answer_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  answer_json TEXT NOT NULL CHECK (json_valid(answer_json)),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(question_id, version)
);

CREATE UNIQUE INDEX one_primary_answer_per_question
ON question_answer_keys(question_id) WHERE is_primary = 1;

CREATE TABLE question_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  stem TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE group_question_links (
  group_id INTEGER NOT NULL REFERENCES question_groups(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, question_id)
);

CREATE TABLE bank_group_links (
  bank_id INTEGER NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES question_groups(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bank_id, group_id)
);

CREATE TABLE question_knowledge_links (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  knowledge_point_id INTEGER NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, knowledge_point_id)
);

CREATE TABLE media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  uri TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  width INTEGER,
  height INTEGER,
  duration REAL,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE question_content_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES question_groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('text','formula','image','table','markdown','html','chart','qrcode','mathml')),
  content TEXT NOT NULL,
  media_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK ((question_id IS NOT NULL) + (group_id IS NOT NULL) = 1)
);

CREATE TABLE media_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_asset_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  option_id INTEGER REFERENCES question_options(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES question_groups(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK ((question_id IS NOT NULL) + (option_id IS NOT NULL) + (group_id IS NOT NULL) = 1),
  UNIQUE(media_asset_id, question_id, option_id, group_id)
);

CREATE INDEX content_blocks_question_order
ON question_content_blocks(question_id, sort_order, id) WHERE question_id IS NOT NULL;
CREATE INDEX content_blocks_group_order
ON question_content_blocks(group_id, sort_order, id) WHERE group_id IS NOT NULL;
CREATE INDEX media_links_question_order
ON media_links(question_id, sort_order, id) WHERE question_id IS NOT NULL;
CREATE INDEX media_links_option_order
ON media_links(option_id, sort_order, id) WHERE option_id IS NOT NULL;
CREATE INDEX media_links_group_order
ON media_links(group_id, sort_order, id) WHERE group_id IS NOT NULL;
CREATE INDEX group_questions_question_order
ON group_question_links(question_id, sort_order, group_id);

CREATE TABLE question_import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('txt','docx')),
  source_uri TEXT NOT NULL,
  stored_uri TEXT NOT NULL,
  parser TEXT NOT NULL CHECK (parser IN ('local','ai')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry_wait','completed','failed','cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  stage TEXT NOT NULL DEFAULT 'stage:queued',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  error TEXT,
  quality_score REAL CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES question_import_jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES question_import_jobs(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('info','warning','error')),
  message TEXT NOT NULL,
  progress INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES question_import_jobs(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  source_index INTEGER NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  needs_review INTEGER NOT NULL CHECK (needs_review IN (0,1)),
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE(job_id, source_index)
);

CREATE TABLE practice_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('all','wrong','type','exam')),
  question_type_code TEXT REFERENCES question_types(code) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  exam_mode INTEGER NOT NULL DEFAULT 0 CHECK (exam_mode IN (0,1)),
  total_questions INTEGER NOT NULL,
  answered_count INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  incorrect_count INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  max_score REAL NOT NULL DEFAULT 0,
  current_index INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE practice_session_questions (
  session_id INTEGER NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  answer_key_id INTEGER NOT NULL REFERENCES question_answer_keys(id) ON DELETE RESTRICT,
  max_score REAL NOT NULL,
  PRIMARY KEY (session_id, question_id),
  UNIQUE(session_id, position)
);

CREATE TABLE question_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  answer_json TEXT NOT NULL CHECK (json_valid(answer_json)),
  is_correct INTEGER CHECK (is_correct IN (0,1) OR is_correct IS NULL),
  score REAL,
  feedback TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, question_id)
);

CREATE TABLE question_stats (
  question_id INTEGER PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  incorrect_count INTEGER NOT NULL DEFAULT 0,
  last_answered_at TEXT
);

CREATE TABLE bank_stats (
  bank_id INTEGER PRIMARY KEY REFERENCES question_banks(id) ON DELETE CASCADE,
  sessions INTEGER NOT NULL DEFAULT 0,
  answers INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  incorrect_count INTEGER NOT NULL DEFAULT 0,
  total_score REAL NOT NULL DEFAULT 0,
  last_practiced_at TEXT
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  purpose TEXT NOT NULL,
  payload_summary TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE learning_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER REFERENCES question_banks(id) ON DELETE CASCADE,
  report TEXT NOT NULL,
  stats_json TEXT NOT NULL CHECK (json_valid(stats_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_knowledge_subject ON knowledge_points(subject_id, parent_id, sort_order);
CREATE INDEX idx_banks_subject_favorite ON question_banks(subject_id, is_favorite, updated_at DESC);
CREATE INDEX idx_bank_questions_order ON bank_question_links(bank_id, sort_order, question_id);
CREATE INDEX idx_questions_subject_type_status ON questions(subject_id, question_type_code, status, updated_at DESC);
CREATE INDEX idx_question_answers_session ON question_answers(session_id, submitted_at);
CREATE INDEX idx_import_jobs_status ON question_import_jobs(status, created_at);
CREATE INDEX idx_events_job ON events(job_id, id);
CREATE INDEX idx_outputs_job_review ON outputs(job_id, needs_review);
CREATE INDEX idx_sessions_bank_started ON practice_sessions(bank_id, started_at DESC);
CREATE INDEX idx_answers_question_stats ON question_answers(question_id, is_correct, submitted_at);
CREATE INDEX idx_answers_session_stats ON question_answers(session_id, is_correct, score);

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

CREATE TRIGGER active_question_requires_answer
BEFORE UPDATE OF status ON questions
WHEN new.status = 'active' AND NOT EXISTS (
  SELECT 1 FROM question_answer_keys WHERE question_id = new.id AND is_primary = 1
)
BEGIN
  SELECT RAISE(ABORT, 'active question requires a primary answer key');
END;

INSERT INTO question_types(code, name, sort_order) VALUES
  ('single_choice', '单选题', 1),
  ('multiple_choice', '多选题', 2),
  ('true_false', '判断题', 3),
  ('fill_blank', '填空题', 4),
  ('short_answer', '简答题', 5);

INSERT INTO subjects(id, name) VALUES (1, '数学'), (2, '语文'), (3, '英语'), (4, '物理'), (5, '化学');
INSERT INTO knowledge_points(id, subject_id, name, sort_order) VALUES
  (1, 1, '数与代数', 1),
  (2, 1, '几何', 2),
  (3, 1, '逻辑推理', 3);
INSERT INTO question_banks(id, subject_id, name, description, is_favorite) VALUES
  (1, 1, '离线示例题库', '用于体验题库、练习与学习分析的内置示例。', 1);

INSERT INTO questions(id, subject_id, question_type_code, stem, explanation, difficulty, default_score, source) VALUES
  (1, 1, 'single_choice', '计算 2 + 3 × 4 的结果。', '先乘除后加减：3 × 4 = 12，2 + 12 = 14。', 1, 2, 'sample'),
  (2, 1, 'multiple_choice', '下列哪些数是质数？', '质数只有 1 和它本身两个正因数。', 2, 3, 'sample'),
  (3, 1, 'true_false', '任意两个奇数的和都是偶数。', '奇数可写为 2k+1，两个奇数之和可写为 2(k+m+1)。', 2, 2, 'sample'),
  (4, 1, 'fill_blank', '正方形边长为 2 cm，其面积为 ____ cm²。', '正方形面积等于边长的平方。', 1, 2, 'sample'),
  (5, 1, 'short_answer', '简述勾股定理。', '在直角三角形中，两条直角边平方和等于斜边平方。', 2, 4, 'sample');

INSERT INTO question_options(question_id, label, content, sort_order) VALUES
  (1, 'A', '20', 0), (1, 'B', '14', 1), (1, 'C', '24', 2), (1, 'D', '18', 3),
  (2, 'A', '2', 0), (2, 'B', '4', 1), (2, 'C', '5', 2), (2, 'D', '9', 3);

INSERT INTO question_answer_keys(question_id, version, answer_json, is_primary) VALUES
  (1, 1, '{"values":["B"]}', 1),
  (2, 1, '{"values":["A","C"]}', 1),
  (3, 1, '{"values":["true"]}', 1),
  (4, 1, '{"blanks":[["4","四"]]}', 1),
  (5, 1, '{"reference":"在直角三角形中，两直角边平方和等于斜边平方，即 a²+b²=c²。"}', 1);

UPDATE questions SET status = 'active';
INSERT INTO bank_question_links(bank_id, question_id, sort_order)
  SELECT 1, id, id FROM questions WHERE id BETWEEN 1 AND 5;
INSERT INTO question_knowledge_links(question_id, knowledge_point_id) VALUES
  (1, 1), (2, 1), (3, 3), (4, 2), (5, 2);
INSERT INTO question_content_blocks(question_id, kind, content, sort_order) VALUES
  (5, 'formula', 'a² + b² = c²', 0);
INSERT INTO question_groups(id, subject_id, stem, explanation, status) VALUES
  (1, 1, '基础数学综合题组', '包含计算与数论基础题。', 'active');
INSERT INTO group_question_links(group_id, question_id, sort_order) VALUES (1, 1, 0), (1, 2, 1);
INSERT INTO bank_group_links(bank_id, group_id, sort_order) VALUES (1, 1, 0);
INSERT INTO bank_stats(bank_id) VALUES (1);
INSERT INTO app_settings(key, value) VALUES
  ('ai_endpoint', ''), ('ai_model', ''), ('ai_provider_name', 'Custom AI service');
INSERT INTO schema_migrations(version) VALUES (1);
`;
