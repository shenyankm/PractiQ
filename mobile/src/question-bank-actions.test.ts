import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  deleteQuestionBank,
  saveGroupContentBlocks,
  saveQuestion,
  saveQuestionBank,
  setPrimaryAnswerKey,
  type QuestionDraft,
} from './features/question-bank/actions';
import { expoDatabase } from './test-database';
import { CONTENT_BLOCK_TYPES } from './types';

function questionDraft(overrides: Partial<QuestionDraft> = {}): QuestionDraft {
  return {
    id: 1,
    bankId: 1,
    subjectId: 1,
    type: 'single_choice',
    stem: '新题干',
    explanation: '',
    status: 'active',
    difficulty: 2,
    score: 1,
    options: [
      { id: 10, label: 'A', content: '新 A', sort_order: 0 },
      { id: 11, label: 'B', content: '新 B', sort_order: 1 },
    ],
    answer: { values: ['b'] },
    knowledgePointIds: [],
    groupId: 1,
    blocks: [],
    ...overrides,
  };
}

test('question and group saves preserve media associations and block order', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY, subject_id INTEGER, question_type_code TEXT, stem TEXT,
      explanation TEXT, status TEXT, difficulty INTEGER, default_score REAL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE question_banks (
      id INTEGER PRIMARY KEY, subject_id INTEGER, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE question_import_jobs (
      id INTEGER PRIMARY KEY, bank_id INTEGER REFERENCES question_banks(id) ON DELETE CASCADE,
      stored_uri TEXT, status TEXT
    );
    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY, job_id INTEGER REFERENCES question_import_jobs(id) ON DELETE CASCADE,
      kind TEXT, uri TEXT
    );
    CREATE TABLE bank_question_links (bank_id INTEGER, question_id INTEGER, sort_order INTEGER, PRIMARY KEY(bank_id, question_id));
    CREATE TABLE question_options (
      id INTEGER PRIMARY KEY, question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
      label TEXT, content TEXT, sort_order INTEGER, UNIQUE(question_id, label)
    );
    CREATE TABLE question_answer_keys (
      id INTEGER PRIMARY KEY, question_id INTEGER, version INTEGER, answer_json TEXT, is_primary INTEGER,
      UNIQUE(question_id, version)
    );
    CREATE TABLE knowledge_points (id INTEGER PRIMARY KEY, subject_id INTEGER);
    CREATE TABLE question_knowledge_links (question_id INTEGER, knowledge_point_id INTEGER);
    CREATE TABLE group_question_links (
      group_id INTEGER, question_id INTEGER, sort_order INTEGER,
      PRIMARY KEY(group_id, question_id)
    );
    CREATE TABLE question_groups (id INTEGER PRIMARY KEY, status TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE bank_group_links (bank_id INTEGER, group_id INTEGER, sort_order INTEGER);
    CREATE TABLE question_content_blocks (
      id INTEGER PRIMARY KEY, question_id INTEGER, group_id INTEGER, kind TEXT, content TEXT, media_asset_id INTEGER,
      metadata_json TEXT, sort_order INTEGER
    );
    CREATE TABLE media_assets (id INTEGER PRIMARY KEY);
    CREATE TABLE media_links (
      id INTEGER PRIMARY KEY, media_asset_id INTEGER REFERENCES media_assets(id),
      question_id INTEGER, option_id INTEGER REFERENCES question_options(id) ON DELETE CASCADE, group_id INTEGER
    );
    INSERT INTO question_banks(id, subject_id, name) VALUES (1, 1, '题库一'), (2, 1, '题库二');
    INSERT INTO knowledge_points(id, subject_id) VALUES (1, 1), (2, 2);
    INSERT INTO question_import_jobs VALUES (1, 1, 'file:///imports/source.docx', 'completed');
    INSERT INTO artifacts VALUES (1, 1, 'source', 'file:///imports/source.docx');
    INSERT INTO questions(id, subject_id, question_type_code, stem, explanation, status, difficulty, default_score)
      VALUES (1, 1, 'single_choice', '旧题干', '', 'active', 2, 1);
    INSERT INTO bank_question_links VALUES (1, 1, 0);
    INSERT INTO question_options VALUES (10, 1, 'A', '旧 A', 0), (11, 1, 'B', '旧 B', 1);
    INSERT INTO question_answer_keys VALUES (1, 1, 1, '{"values":["B"]}', 1);
    INSERT INTO media_assets VALUES (1), (2);
    INSERT INTO media_links(id, media_asset_id, option_id) VALUES (1, 1, 10);
    CREATE TRIGGER empty_active_group_is_archived
    AFTER DELETE ON group_question_links
    WHEN EXISTS (SELECT 1 FROM question_groups WHERE id = old.group_id AND status = 'active')
      AND NOT EXISTS (SELECT 1 FROM group_question_links WHERE group_id = old.group_id)
    BEGIN
      UPDATE question_groups SET status = 'archived' WHERE id = old.group_id;
    END;
    INSERT INTO question_groups(id, status) VALUES (1, 'active'), (2, 'active');
    INSERT INTO bank_group_links VALUES (1, 1, 0), (2, 2, 0);
    INSERT INTO group_question_links VALUES (1, 1, 0), (2, 1, 0);
    INSERT INTO media_links(id, media_asset_id, group_id) VALUES (2, 2, 1);
  `);
  const database = expoDatabase(sqlite);

  const bankId = await saveQuestionBank(database, 0, 1, '新题库', '');
  assert.equal(sqlite.prepare('SELECT name FROM question_banks WHERE id = ?').get(bankId)?.name, '新题库');

  await saveQuestion(database, questionDraft());

  assert.equal(sqlite.prepare('SELECT option_id FROM media_links').get()?.option_id, 10);
  assert.deepEqual(
    sqlite.prepare('SELECT id, content FROM question_options ORDER BY id').all().map((row) => [row.id, row.content]),
    [[10, '新 A'], [11, '新 B']],
  );
  assert.equal(sqlite.prepare('SELECT answer_json FROM question_answer_keys WHERE is_primary = 1').get()?.answer_json, '{"values":["b"]}');
  assert.deepEqual(
    sqlite.prepare('SELECT group_id FROM group_question_links WHERE question_id = 1 ORDER BY group_id').all()
      .map((row) => row.group_id),
    [1, 2],
  );
  assert.equal(sqlite.prepare('SELECT status FROM question_groups WHERE id = 1').get()?.status, 'active');

  sqlite.exec("UPDATE questions SET status = 'archived' WHERE id = 1; UPDATE question_groups SET status = 'archived' WHERE id = 1;");
  await saveQuestion(database, questionDraft({
    stem: '归档后修订题干',
    status: 'archived',
  }));
  assert.equal(sqlite.prepare('SELECT stem FROM questions WHERE id = 1').get()?.stem, '归档后修订题干');
  assert.equal(sqlite.prepare('SELECT status FROM question_groups WHERE id = 1').get()?.status, 'archived');
  sqlite.exec("UPDATE questions SET status = 'active' WHERE id = 1; UPDATE question_groups SET status = 'active' WHERE id = 1;");

  await assert.rejects(
    saveQuestion(database, questionDraft({
      stem: '跨学科知识点不应写入',
      knowledgePointIds: [2],
    })),
    /知识点不存在或不属于试题学科/,
  );
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM question_knowledge_links').get()?.count, 0);

  await assert.rejects(
    saveQuestion(database, questionDraft({
      answer: { values: ['B'] },
      groupId: null,
      blocks: [{ kind: 'image', content: '缺失图片', sort_order: 0 }],
    })),
    /图片内容块必须选择试题图片/,
  );
  await assert.rejects(
    saveQuestion(database, questionDraft({
      answer: { values: ['B'] },
      groupId: null,
      blocks: [{ kind: 'image', content: '错误关联', media_asset_id: 2, sort_order: 0 }],
    })),
    /未关联到当前试题/,
  );

  sqlite.exec(`INSERT INTO question_answer_keys(id, question_id, version, answer_json, is_primary)
    VALUES (99, 1, 99, '{"values":["C"]}', 0)`);
  await assert.rejects(
    setPrimaryAnswerKey(database, 1, 99),
    /与当前试题不兼容/,
  );
  assert.equal(sqlite.prepare('SELECT id FROM question_answer_keys WHERE is_primary = 1').get()?.id, 2);

  await saveGroupContentBlocks(
    database,
    1,
    CONTENT_BLOCK_TYPES.map((kind, sort_order) => ({
      kind,
      content: kind === 'image' ? '示意图' : `${kind}内容`,
      media_asset_id: kind === 'image' ? 2 : null,
      sort_order,
    })),
  );
  assert.deepEqual(
    sqlite.prepare('SELECT kind FROM question_content_blocks WHERE group_id = 1 ORDER BY sort_order').all()
      .map((row) => row.kind),
    CONTENT_BLOCK_TYPES,
  );
  await saveGroupContentBlocks(database, 1, [
    { kind: 'image', content: '示意图', media_asset_id: 2, sort_order: 0 },
  ]);
  assert.deepEqual(
    sqlite.prepare('SELECT kind, media_asset_id, sort_order FROM question_content_blocks WHERE group_id = 1').all()
      .map((row) => [row.kind, row.media_asset_id, row.sort_order]),
    [['image', 2, 0]],
  );
  sqlite.exec("INSERT INTO question_import_jobs VALUES (2, 1, 'file:///imports/source.docx', 'running')");
  await assert.rejects(
    deleteQuestionBank(database, 1),
    /先在导入页取消/,
  );
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM question_banks WHERE id = 1').get()?.count, 1);
  sqlite.exec("UPDATE question_import_jobs SET status = 'cancelled' WHERE id = 2");
  assert.deepEqual(
    await deleteQuestionBank(database, 1),
    ['file:///imports/source.docx'],
  );
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM question_import_jobs').get()?.count, 0);
  sqlite.close();
});
