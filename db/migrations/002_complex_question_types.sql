-- db/migrations/002_complex_question_types.sql
-- 扩展题型：新增排序题（ordering）与连线题（matching），增强填空/简答判分，自评回写。
-- 作用于现有个人库，一次性执行；00_schema.sql 已同步等价内容用于全新库。
-- 全部为加法式变更：新增表、新增可空列、放宽 CHECK 枚举，不改不删既有列与数据。
BEGIN;

-- 1) 放宽题型注册表门闩，注册新题型 --------------------------------------------
ALTER TABLE question_types DROP CONSTRAINT question_types_answer_mode_check;
ALTER TABLE question_types ADD CONSTRAINT question_types_answer_mode_check
  CHECK (answer_mode IN ('choice','true_false','fill_blank','short_answer','ordering','matching'));

INSERT INTO question_types (id, subject_id, display_name, answer_mode) VALUES
  ('ordering', 'general', '排序题', 'ordering'),
  ('matching', 'general', '连线题', 'matching');

-- 2) 排序题条目表 ---------------------------------------------------------------
CREATE TABLE question_ordering_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id bigint  NOT NULL REFERENCES questions,
  content     text    NOT NULL CHECK (btrim(content) <> ''),
  sort_order  integer NOT NULL CHECK (sort_order > 0),
  UNIQUE (question_id, sort_order)
);

-- 3) 连线题条目表（左右统一存一张表，side 区分）-----------------------------------
CREATE TABLE question_matching_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id bigint  NOT NULL REFERENCES questions,
  side        text    NOT NULL CHECK (side IN ('left','right')),
  content     text    NOT NULL CHECK (btrim(content) <> ''),
  sort_order  integer NOT NULL CHECK (sort_order > 0),
  UNIQUE (question_id, side, sort_order)
);

-- 4) 连线题变体列（镜像 choice_variant 模式）--------------------------------------
ALTER TABLE questions ADD COLUMN matching_variant text
  CHECK (matching_variant IN ('one_to_one','many_to_one'));
ALTER TABLE questions ADD CONSTRAINT questions_matching_variant_shape
  CHECK ((answer_mode = 'matching') = (matching_variant IS NOT NULL));

-- 5) 自评回写时间戳 ---------------------------------------------------------------
ALTER TABLE practice_answers ADD COLUMN reviewed_at timestamptz;

-- 6) 组合题支撑索引 ----------------------------------------------------------------
CREATE INDEX questions_group ON questions (group_id)
  WHERE deleted_at IS NULL AND group_id IS NOT NULL;

COMMIT;
