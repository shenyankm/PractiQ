import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { migrateDatabase } from './database/migrations';
import { expoDatabase } from './test-database';

async function currentDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  await migrateDatabase(expoDatabase(sqlite));
  return sqlite;
}

test('current schema enforces the question lifecycle and one primary answer', async () => {
  const sqlite = await currentDatabase();

  assert.throws(
    () => sqlite.exec(`
      INSERT INTO questions(id, subject_id, question_type_code, stem, status)
      VALUES (100, 1, 'true_false', '不能直接发布', 'active')
    `),
    /created as draft/,
  );
  sqlite.exec(`
    INSERT INTO questions(id, subject_id, question_type_code, stem)
    VALUES (100, 1, 'true_false', '生命周期测试')
  `);
  assert.throws(
    () => sqlite.exec("UPDATE questions SET status = 'active' WHERE id = 100"),
    /requires a primary answer/,
  );
  sqlite.exec(`
    INSERT INTO question_answer_keys(question_id, version, answer_json, is_primary)
    VALUES (100, 1, '{"values":["true"]}', 1)
  `);
  assert.throws(
    () => sqlite.exec(`
      INSERT INTO question_answer_keys(question_id, version, answer_json, is_primary)
      VALUES (100, 2, '{"values":["false"]}', 1)
    `),
    /UNIQUE constraint failed/,
  );

  sqlite.exec("UPDATE questions SET status = 'active' WHERE id = 100");
  assert.throws(
    () => sqlite.exec("UPDATE questions SET status = 'draft' WHERE id = 100"),
    /status can only move/,
  );
  sqlite.exec("UPDATE questions SET status = 'archived' WHERE id = 100");
  assert.throws(
    () => sqlite.exec("UPDATE questions SET status = 'active' WHERE id = 100"),
    /status can only move/,
  );
  sqlite.close();
});

test('current schema enforces the group lifecycle around active child questions', async () => {
  const sqlite = await currentDatabase();

  assert.throws(
    () => sqlite.exec(`
      INSERT INTO question_groups(id, subject_id, stem, status)
      VALUES (100, 1, '不能直接发布', 'active')
    `),
    /created as draft/,
  );
  sqlite.exec(`
    INSERT INTO question_groups(id, subject_id, stem) VALUES (100, 1, '题组生命周期');
    INSERT INTO questions(id, subject_id, question_type_code, stem)
    VALUES (100, 1, 'true_false', '题组子题');
    INSERT INTO question_answer_keys(question_id, version, answer_json, is_primary)
    VALUES (100, 1, '{"values":["true"]}', 1);
  `);
  assert.throws(
    () => sqlite.exec("UPDATE question_groups SET status = 'active' WHERE id = 100"),
    /requires at least one question/,
  );

  sqlite.exec(`
    INSERT INTO group_question_links(group_id, question_id) VALUES (100, 100);
    UPDATE question_groups SET status = 'active' WHERE id = 100;
    UPDATE questions SET status = 'active' WHERE id = 100;
  `);
  assert.throws(
    () => sqlite.exec("UPDATE question_groups SET status = 'archived' WHERE id = 100"),
    /archive active child questions/,
  );
  sqlite.exec(`
    UPDATE questions SET status = 'archived' WHERE id = 100;
    UPDATE question_groups SET status = 'archived' WHERE id = 100;
  `);
  assert.throws(
    () => sqlite.exec("UPDATE question_groups SET status = 'active' WHERE id = 100"),
    /status can only move/,
  );

  sqlite.exec(`
    INSERT INTO questions(id, subject_id, question_type_code, stem)
    VALUES (101, 1, 'true_false', '活动题');
    INSERT INTO question_answer_keys(question_id, version, answer_json, is_primary)
    VALUES (101, 1, '{"values":["true"]}', 1);
    UPDATE questions SET status = 'active' WHERE id = 101;
  `);
  assert.throws(
    () => sqlite.exec('INSERT INTO group_question_links(group_id, question_id) VALUES (100, 101)'),
    /archived question group/,
  );
  sqlite.close();
});

test('current schema rejects cross-subject links and linked subject changes', async () => {
  const sqlite = await currentDatabase();
  sqlite.exec(`
    INSERT INTO questions(id, subject_id, question_type_code, stem)
    VALUES (200, 2, 'true_false', '其他学科试题');
    INSERT INTO question_groups(id, subject_id, stem) VALUES
      (200, 2, '其他学科题组'),
      (201, 1, '本学科题组');
    INSERT INTO question_banks(id, subject_id, name) VALUES (202, 2, '其他学科题库');
    INSERT INTO bank_question_links(bank_id, question_id) VALUES (202, 200);
    INSERT INTO bank_group_links(bank_id, group_id) VALUES (202, 200);
    INSERT INTO group_question_links(group_id, question_id) VALUES (200, 200);
  `);

  assert.throws(
    () => sqlite.exec('INSERT INTO bank_question_links(bank_id, question_id) VALUES (1, 200)'),
    /subject must match question bank/,
  );
  assert.throws(
    () => sqlite.exec('INSERT INTO bank_group_links(bank_id, group_id) VALUES (1, 200)'),
    /subject must match question bank/,
  );
  assert.throws(
    () => sqlite.exec('INSERT INTO group_question_links(group_id, question_id) VALUES (201, 200)'),
    /subject must match question group/,
  );
  assert.throws(
    () => sqlite.exec('UPDATE bank_question_links SET bank_id = 1 WHERE bank_id = 202 AND question_id = 200'),
    /subject must match question bank/,
  );
  assert.throws(
    () => sqlite.exec('UPDATE bank_group_links SET bank_id = 1 WHERE bank_id = 202 AND group_id = 200'),
    /subject must match question bank/,
  );
  assert.throws(
    () => sqlite.exec('UPDATE group_question_links SET group_id = 201 WHERE group_id = 200 AND question_id = 200'),
    /subject must match question group/,
  );

  sqlite.exec(`
    INSERT INTO knowledge_points(id, subject_id, name) VALUES
      (200, 2, '其他学科知识点'),
      (201, 1, '本学科知识点');
    INSERT INTO question_knowledge_links(question_id, knowledge_point_id) VALUES (200, 200);
  `);
  assert.throws(
    () => sqlite.exec('INSERT INTO question_knowledge_links(question_id, knowledge_point_id) VALUES (1, 200)'),
    /subject must match knowledge point/,
  );
  assert.throws(
    () => sqlite.exec(`
      UPDATE question_knowledge_links SET knowledge_point_id = 201
      WHERE question_id = 200 AND knowledge_point_id = 200
    `),
    /subject must match knowledge point/,
  );
  sqlite.exec(`
    INSERT INTO questions(id, subject_id, question_type_code, stem)
    VALUES (203, 2, 'true_false', '仅关联知识点的试题');
    INSERT INTO question_knowledge_links(question_id, knowledge_point_id) VALUES (203, 200);
  `);
  assert.throws(
    () => sqlite.exec('UPDATE questions SET subject_id = 1 WHERE id = 203'),
    /match its knowledge points/,
  );
  assert.throws(
    () => sqlite.exec('UPDATE knowledge_points SET subject_id = 1 WHERE id = 200'),
    /match its questions/,
  );
  assert.throws(
    () => sqlite.exec('UPDATE questions SET subject_id = 2 WHERE id = 1'),
    /linked question subject/,
  );
  assert.throws(
    () => sqlite.exec('UPDATE question_groups SET subject_id = 2 WHERE id = 1'),
    /linked question group subject/,
  );
  assert.throws(
    () => sqlite.exec('UPDATE question_banks SET subject_id = 2 WHERE id = 1'),
    /subject cannot change/,
  );

  sqlite.exec(`
    INSERT INTO question_banks(id, subject_id, name) VALUES (210, 1, '空题库');
    UPDATE question_banks SET subject_id = 2 WHERE id = 210;
  `);
  assert.equal(sqlite.prepare('SELECT subject_id FROM question_banks WHERE id = 210').get()?.subject_id, 2);
  sqlite.close();
});

test('current schema enforces exclusive content ownership and media uniqueness', async () => {
  const sqlite = await currentDatabase();
  sqlite.exec(`
    INSERT INTO media_assets(id, file_name, uri, mime_type, size) VALUES
      (100, 'one.png', 'file:///media/one.png', 'image/png', 1),
      (101, 'two.png', 'file:///media/two.png', 'image/png', 1);
    INSERT INTO media_links(media_asset_id, question_id) VALUES (100, 1);
  `);
  assert.throws(
    () => sqlite.exec('INSERT INTO media_links(media_asset_id, question_id) VALUES (100, 1)'),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => sqlite.exec(`
      INSERT INTO media_links(media_asset_id, question_id, option_id)
      VALUES (101, 1, 1)
    `),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => sqlite.exec(`
      INSERT INTO question_content_blocks(question_id, group_id, kind, content)
      VALUES (1, 1, 'text', 'ambiguous owner')
    `),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => sqlite.exec(`
      INSERT INTO question_content_blocks(kind, content)
      VALUES ('text', 'missing owner')
    `),
    /CHECK constraint failed/,
  );
  sqlite.close();
});

test('current schema enforces scalar ranges, enums, and JSON validity', async () => {
  const sqlite = await currentDatabase();
  const invalidStatements = [
    `INSERT INTO questions(id, subject_id, question_type_code, stem, difficulty)
     VALUES (400, 1, 'true_false', 'bad difficulty', 0)`,
    `INSERT INTO questions(id, subject_id, question_type_code, stem, default_score)
     VALUES (400, 1, 'true_false', 'bad score', -1)`,
    `INSERT INTO question_answer_keys(question_id, version, answer_json)
     VALUES (1, 2, 'not-json')`,
    `INSERT INTO media_assets(file_name, uri, mime_type, size)
     VALUES ('bad.png', 'file:///media/bad.png', 'image/png', -1)`,
    `INSERT INTO question_content_blocks(question_id, kind, content, metadata_json)
     VALUES (1, 'text', 'bad metadata', 'not-json')`,
    `INSERT INTO question_import_jobs(
       bank_id, file_name, file_type, source_uri, stored_uri, parser, progress
     ) VALUES (1, 'bad.txt', 'txt', 'file:///source', 'file:///stored', 'local', 101)`,
    `INSERT INTO practice_sessions(bank_id, mode, exam_mode, total_questions)
     VALUES (1, 'all', 2, 1)`,
    `INSERT INTO question_answers(session_id, question_id, answer_json)
     VALUES (999, 1, 'not-json')`,
  ];
  for (const sql of invalidStatements) {
    assert.throws(() => sqlite.exec(sql), /constraint failed/i, sql);
  }
  sqlite.close();
});

test('current schema enforces business-key and ordered-membership uniqueness', async () => {
  const sqlite = await currentDatabase();
  sqlite.exec(`
    INSERT INTO subjects(id, name) VALUES (100, 'Biology');
    INSERT INTO question_banks(id, subject_id, name) VALUES (100, 1, 'Unique bank');
  `);
  assert.throws(
    () => sqlite.exec("INSERT INTO subjects(id, name) VALUES (101, 'biology')"),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => sqlite.exec("INSERT INTO question_banks(id, subject_id, name) VALUES (101, 1, 'unique BANK')"),
    /UNIQUE constraint failed/,
  );
  sqlite.exec("INSERT INTO question_banks(id, subject_id, name) VALUES (101, 2, 'unique BANK')");
  assert.throws(
    () => sqlite.exec("INSERT INTO question_options(question_id, label, content) VALUES (1, 'A', 'duplicate')"),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => sqlite.exec(`
      INSERT INTO question_answer_keys(question_id, version, answer_json)
      VALUES (1, 1, '{"values":["A"]}')
    `),
    /UNIQUE constraint failed/,
  );

  sqlite.exec(`
    INSERT INTO question_import_jobs(
      id, bank_id, file_name, file_type, source_uri, stored_uri, parser
    ) VALUES (100, 1, 'source.txt', 'txt', 'file:///source', 'file:///stored', 'local');
    INSERT INTO outputs(job_id, source_index, confidence, needs_review, raw_json)
    VALUES (100, 0, 1, 0, '{}');
  `);
  assert.throws(
    () => sqlite.exec(`
      INSERT INTO outputs(job_id, source_index, confidence, needs_review, raw_json)
      VALUES (100, 0, 1, 0, '{}')
    `),
    /UNIQUE constraint failed/,
  );

  sqlite.exec(`
    INSERT INTO practice_sessions(id, bank_id, mode, total_questions)
    VALUES (100, 1, 'all', 2);
    INSERT INTO practice_session_questions(
      session_id, question_id, position, answer_key_id, max_score, snapshot_json
    )
    SELECT 100, question_id, 0, answer_key_id, 2, snapshot_json
    FROM practice_question_snapshot_source
    WHERE bank_id = 1 AND question_id = 1 AND answer_key_id = 1;
  `);
  assert.throws(
    () => sqlite.exec(`
      INSERT INTO practice_session_questions(
        session_id, question_id, position, answer_key_id, max_score, snapshot_json
      )
      SELECT 100, question_id, 0, answer_key_id, 3, snapshot_json
      FROM practice_question_snapshot_source
      WHERE bank_id = 1 AND question_id = 2 AND answer_key_id = 2
    `),
    /UNIQUE constraint failed/,
  );
  sqlite.exec(`
    INSERT INTO question_answers(session_id, question_id, answer_json)
    VALUES (100, 1, '{}')
  `);
  assert.throws(
    () => sqlite.exec(`
      INSERT INTO question_answers(session_id, question_id, answer_json)
      VALUES (100, 1, '{}')
    `),
    /UNIQUE constraint failed/,
  );
  sqlite.close();
});

test('current schema keeps practiced questions, cascades bank-owned history, and synchronizes FTS', async () => {
  const sqlite = await currentDatabase();
  sqlite.exec(`
    INSERT INTO practice_sessions(id, bank_id, mode, total_questions)
    VALUES (100, 1, 'all', 1);
    INSERT INTO practice_session_questions(
      session_id, question_id, position, answer_key_id, max_score, snapshot_json
    )
    SELECT 100, question_id, 0, answer_key_id, 2, snapshot_json
    FROM practice_question_snapshot_source
    WHERE bank_id = 1 AND question_id = 1 AND answer_key_id = 1;
    INSERT INTO question_answers(session_id, question_id, answer_json, is_correct, score)
    VALUES (100, 1, '{"values":["B"]}', 1, 2);
  `);
  assert.throws(
    () => sqlite.exec('DELETE FROM questions WHERE id = 1'),
    /FOREIGN KEY constraint failed/,
  );

  sqlite.exec('DELETE FROM question_banks WHERE id = 1');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM practice_sessions WHERE id = 100').get()?.count, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM question_answers WHERE session_id = 100').get()?.count, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM questions WHERE id = 1').get()?.count, 1);

  sqlite.exec(`
    INSERT INTO questions(id, subject_id, question_type_code, stem)
    VALUES (300, 1, 'true_false', 'alpha marker')
  `);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM questions_fts WHERE questions_fts MATCH 'alpha'").get()?.count,
    1,
  );
  sqlite.exec("UPDATE questions SET stem = 'omega marker' WHERE id = 300");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM questions_fts WHERE questions_fts MATCH 'alpha'").get()?.count,
    0,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM questions_fts WHERE questions_fts MATCH 'omega'").get()?.count,
    1,
  );
  sqlite.exec('DELETE FROM questions WHERE id = 300');
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM questions_fts WHERE questions_fts MATCH 'omega'").get()?.count,
    0,
  );
  sqlite.close();
});
