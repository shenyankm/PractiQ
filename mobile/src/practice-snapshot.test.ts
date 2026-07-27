import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createPracticeSession, finishPracticeSession, submitPracticeAnswer } from './features/practice/actions';
import {
  PRACTICE_SESSION_QUESTIONS_SQL,
  PRACTICE_SNAPSHOT_MEDIA_URIS_SQL,
  PRACTICE_SNAPSHOT_MIGRATION_SQL,
  remapPracticeSnapshotMediaUris,
} from './practice-snapshot';
import { expoDatabase } from './test-database';

test('practice snapshots survive live question edits for grading and completed results', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE question_types (code TEXT PRIMARY KEY, name TEXT, sort_order INTEGER);
    CREATE TABLE question_banks (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY, question_type_code TEXT REFERENCES question_types(code), stem TEXT,
      explanation TEXT, status TEXT, default_score REAL
    );
    CREATE TABLE bank_question_links (
      bank_id INTEGER REFERENCES question_banks(id), question_id INTEGER REFERENCES questions(id),
      sort_order INTEGER, PRIMARY KEY (bank_id, question_id)
    );
    CREATE TABLE question_options (
      id INTEGER PRIMARY KEY, question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
      label TEXT, content TEXT, sort_order INTEGER
    );
    CREATE TABLE question_answer_keys (
      id INTEGER PRIMARY KEY, question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
      answer_json TEXT, is_primary INTEGER
    );
    CREATE TABLE question_groups (
      id INTEGER PRIMARY KEY, stem TEXT, explanation TEXT, status TEXT
    );
    CREATE TABLE group_question_links (group_id INTEGER, question_id INTEGER, sort_order INTEGER);
    CREATE TABLE bank_group_links (bank_id INTEGER, group_id INTEGER, sort_order INTEGER);
    CREATE TABLE media_assets (
      id INTEGER PRIMARY KEY, file_name TEXT, uri TEXT, mime_type TEXT, size INTEGER,
      width INTEGER, height INTEGER, duration REAL, metadata_json TEXT
    );
    CREATE TABLE question_content_blocks (
      id INTEGER PRIMARY KEY, question_id INTEGER, group_id INTEGER, kind TEXT, content TEXT,
      media_asset_id INTEGER, metadata_json TEXT, sort_order INTEGER
    );
    CREATE TABLE media_links (
      id INTEGER PRIMARY KEY, media_asset_id INTEGER, question_id INTEGER, option_id INTEGER,
      group_id INTEGER, sort_order INTEGER
    );
    CREATE TABLE practice_sessions (
      id INTEGER PRIMARY KEY, bank_id INTEGER REFERENCES question_banks(id), mode TEXT,
      question_type_code TEXT, status TEXT DEFAULT 'active', exam_mode INTEGER DEFAULT 0,
      total_questions INTEGER, answered_count INTEGER DEFAULT 0, correct_count INTEGER DEFAULT 0,
      incorrect_count INTEGER DEFAULT 0, score REAL DEFAULT 0, max_score REAL DEFAULT 0,
      current_index INTEGER DEFAULT 0, started_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
    );
    CREATE TABLE practice_session_questions (
      session_id INTEGER REFERENCES practice_sessions(id) ON DELETE CASCADE,
      question_id INTEGER REFERENCES questions(id) ON DELETE RESTRICT, position INTEGER,
      answer_key_id INTEGER REFERENCES question_answer_keys(id) ON DELETE RESTRICT, max_score REAL,
      PRIMARY KEY (session_id, question_id), UNIQUE (session_id, position)
    );
    CREATE TABLE question_answers (
      id INTEGER PRIMARY KEY, session_id INTEGER, question_id INTEGER, answer_json TEXT,
      is_correct INTEGER, score REAL, feedback TEXT DEFAULT '', submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (session_id, question_id)
    );

    INSERT INTO question_types VALUES
      ('single_choice', '单选题', 1), ('true_false', '判断题', 2);
    INSERT INTO question_banks VALUES (1, '目标题库'), (2, '其他题库');
    INSERT INTO questions VALUES
      (1, 'single_choice', '原题干', '原解析', 'active', 2),
      (2, 'single_choice', '题组第二题', '第二题解析', 'active', 2);
    INSERT INTO bank_question_links VALUES (1, 1, 0), (1, 2, 1);
    INSERT INTO question_options VALUES
      (10, 1, 'A', '原 A', 0), (11, 1, 'B', '原 B', 1),
      (12, 2, 'A', '第二题 A', 0), (13, 2, 'B', '第二题 B', 1);
    INSERT INTO question_answer_keys VALUES
      (20, 1, '{"values":["B"]}', 1),
      (21, 2, '{"values":["A"]}', 1);
    INSERT INTO question_groups VALUES
      (30, '本题库原题组', '原题组解析', 'active'),
      (31, '其他题库题组', '', 'active');
    INSERT INTO group_question_links VALUES (30, 1, 0), (30, 2, 1), (31, 1, 0);
    INSERT INTO bank_group_links VALUES (1, 30, 0), (2, 31, 0);
    INSERT INTO media_assets VALUES
      (40, 'option.png', 'file:///old-option.png', 'image/png', 10, 10, 10, NULL, '{}'),
      (41, 'question.png', 'file:///old-question.png', 'image/png', 10, 10, 10, NULL, '{}'),
      (42, 'block.png', 'file:///old-block.png', 'image/png', 10, 10, 10, NULL, '{}'),
      (43, 'group.png', 'file:///old-group.png', 'image/png', 10, 10, 10, NULL, '{}'),
      (44, 'group-block.png', 'file:///old-group-block.png', 'image/png', 10, 10, 10, NULL, '{}');
    INSERT INTO media_links VALUES
      (50, 40, NULL, 11, NULL, 0), (51, 41, 1, NULL, NULL, 0), (52, 43, NULL, NULL, 30, 0);
    INSERT INTO question_content_blocks VALUES
      (60, 1, NULL, 'image', '原题目内容块', 42, '{}', 0),
      (61, NULL, 30, 'image', '原题组内容块', 44, '{}', 0);

    INSERT INTO practice_sessions(id, bank_id, mode, total_questions, max_score)
      VALUES (70, 1, 'all', 1, 2);
    INSERT INTO practice_session_questions VALUES (70, 1, 0, 20, 2);
  `);

  sqlite.exec(PRACTICE_SNAPSHOT_MIGRATION_SQL);
  sqlite.exec("INSERT INTO practice_sessions(id, bank_id, mode, total_questions) VALUES (71, 1, 'all', 1)");
  assert.throws(
    () => sqlite.exec(`
      INSERT INTO practice_session_questions(session_id, question_id, position, answer_key_id, max_score)
      VALUES (71, 2, 0, 21, 2)
    `),
    /requires a snapshot/,
  );
  assert.throws(
    () => sqlite.exec(`
      INSERT INTO practice_session_questions(
        session_id, question_id, position, answer_key_id, max_score, snapshot_json
      ) VALUES (71, 2, 0, 21, 2, '[]')
    `),
    /requires a snapshot/,
  );
  assert.equal(
    JSON.parse(String(sqlite.prepare('SELECT snapshot_json FROM practice_session_questions WHERE session_id = 70').get()?.snapshot_json)).stem,
    '原题干',
  );

  const db = expoDatabase(sqlite);
  const sessionId = await createPracticeSession(
    db,
    1,
    'all',
    null,
    1,
  );
  assert.deepEqual(
    sqlite.prepare('SELECT question_id FROM practice_session_questions WHERE session_id = ? ORDER BY position')
      .all(sessionId).map((row) => row.question_id),
    [1, 2],
  );

  assert.deepEqual(
    sqlite.prepare(`${PRACTICE_SNAPSHOT_MEDIA_URIS_SQL} ORDER BY uri`).all().map((row) => row.uri),
    [
      'file:///old-block.png',
      'file:///old-group-block.png',
      'file:///old-group.png',
      'file:///old-option.png',
      'file:///old-question.png',
    ],
  );
  const remappedSnapshot = remapPracticeSnapshotMediaUris(
    String(sqlite.prepare('SELECT snapshot_json FROM practice_session_questions WHERE session_id = ?').get(sessionId)?.snapshot_json),
    new Map([
      ['file:///old-option.png', 'file:///restored-option.png'],
      ['file:///old-block.png', 'file:///restored-block.png'],
    ]),
  );
  const remappedValue = JSON.parse(remappedSnapshot);
  assert.equal(remappedValue.options[1].media_json[0].uri, 'file:///restored-option.png');
  assert.equal(remappedValue.blocks[0].media_uri, 'file:///restored-block.png');
  assert.equal(remappedValue.media[0].uri, 'file:///old-question.png');

  sqlite.exec(`
    UPDATE questions
    SET question_type_code = 'true_false', stem = '已修改题干', explanation = '已修改解析';
    UPDATE question_answer_keys SET answer_json = '{"values":["A"]}';
    UPDATE question_options SET content = '已修改选项';
    UPDATE question_groups SET stem = '已修改题组';
    UPDATE question_content_blocks SET content = '已修改内容块';
    UPDATE media_assets SET uri = 'file:///changed.png';
    DELETE FROM media_links;
  `);

  const grade = await submitPracticeAnswer(
    db,
    sessionId,
    1,
    { values: ['B'] },
  );
  assert.equal(grade.isCorrect, true);
  assert.equal(grade.score, 2);

  const result = sqlite.prepare(PRACTICE_SESSION_QUESTIONS_SQL).get(sessionId);
  assert.equal(result?.question_type_code, 'single_choice');
  assert.equal(result?.stem, '原题干');
  assert.equal(result?.explanation, '原解析');
  assert.equal(result?.answer_json, '{"values":["B"]}');
  const options = JSON.parse(String(result?.options_json));
  assert.equal(options[1].content, '原 B');
  assert.equal(options[1].media_json[0].uri, 'file:///old-option.png');
  assert.equal(JSON.parse(String(result?.blocks_json))[0].content, '原题目内容块');
  assert.equal(JSON.parse(String(result?.media_json))[0].uri, 'file:///old-question.png');
  assert.equal(result?.group_stem, '本题库原题组');
  assert.equal(JSON.parse(String(result?.group_blocks_json))[0].content, '原题组内容块');
  assert.equal(JSON.parse(String(result?.group_media_json))[0].uri, 'file:///old-group.png');

  await finishPracticeSession(
    db,
    sessionId,
    'completed',
  );
  const abandonedSessionId = await createPracticeSession(
    db,
    1,
    'all',
    null,
    1,
  );
  await finishPracticeSession(
    db,
    abandonedSessionId,
    'abandoned',
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS sessions FROM practice_sessions WHERE bank_id = 1 AND status = 'completed'").get()?.sessions,
    1,
  );
  assert.equal(sqlite.prepare(PRACTICE_SESSION_QUESTIONS_SQL).get(sessionId)?.stem, '原题干');
  assert.throws(() => sqlite.exec(`
    UPDATE practice_session_questions SET snapshot_json = '{}' WHERE session_id = ${sessionId};
  `), /snapshot is immutable/);
  sqlite.exec(`
    WITH RECURSIVE ids(id) AS (
      SELECT 3 UNION ALL SELECT id + 1 FROM ids WHERE id < 201
    )
    INSERT INTO questions(id, question_type_code, stem, explanation, status, default_score)
    SELECT id, 'true_false', 'oversized group question', '', 'active', 1 FROM ids;
    WITH RECURSIVE ids(id) AS (
      SELECT 3 UNION ALL SELECT id + 1 FROM ids WHERE id < 201
    )
    INSERT INTO bank_question_links(bank_id, question_id, sort_order)
    SELECT 1, id, id FROM ids;
    WITH RECURSIVE ids(id) AS (
      SELECT 3 UNION ALL SELECT id + 1 FROM ids WHERE id < 201
    )
    INSERT INTO group_question_links(group_id, question_id, sort_order)
    SELECT 30, id, id FROM ids;
    WITH RECURSIVE ids(id) AS (
      SELECT 3 UNION ALL SELECT id + 1 FROM ids WHERE id < 201
    )
    INSERT INTO question_answer_keys(id, question_id, answer_json, is_primary)
    SELECT id + 1000, id, '{"values":["true"]}', 1 FROM ids;
  `);
  await assert.rejects(
    createPracticeSession(db, 1, 'all', null, 200),
    /200 题上限/,
  );
  sqlite.close();
});

test('practice writes serialize duplicate submissions and terminal-state races', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE practice_sessions (
      id INTEGER PRIMARY KEY, bank_id INTEGER, status TEXT DEFAULT 'active', total_questions INTEGER,
      answered_count INTEGER DEFAULT 0, correct_count INTEGER DEFAULT 0,
      incorrect_count INTEGER DEFAULT 0, score REAL DEFAULT 0, current_index INTEGER DEFAULT 0,
      completed_at TEXT
    );
    CREATE TABLE practice_session_questions (
      session_id INTEGER, question_id INTEGER, max_score REAL, snapshot_json TEXT,
      PRIMARY KEY (session_id, question_id)
    );
    CREATE TABLE question_answers (
      id INTEGER PRIMARY KEY, session_id INTEGER, question_id INTEGER, answer_json TEXT,
      is_correct INTEGER, score REAL, feedback TEXT, submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (session_id, question_id)
    );
  `);
  const db = expoDatabase(sqlite);
  const snapshot = JSON.stringify({
    questionTypeCode: 'single_choice',
    answerJson: JSON.stringify({ values: ['B'] }),
  });

  for (const [sessionId, terminalStatus] of [[1, 'completed'], [2, 'abandoned']] as const) {
    sqlite.prepare('INSERT INTO practice_sessions(id, bank_id, total_questions) VALUES (?, 1, 1)').run(sessionId);
    sqlite.prepare(
      `INSERT INTO practice_session_questions(session_id, question_id, max_score, snapshot_json)
       VALUES (?, 1, 2, ?)`,
    ).run(sessionId, snapshot);
    const racingDb = {
      ...db,
      withExclusiveTransactionAsync: async (
        work: Parameters<typeof db.withExclusiveTransactionAsync>[0],
      ) => {
        sqlite.prepare('UPDATE practice_sessions SET status = ? WHERE id = ?').run(terminalStatus, sessionId);
        return db.withExclusiveTransactionAsync(work);
      },
    };

    await assert.rejects(
      submitPracticeAnswer(
        racingDb as unknown as Parameters<typeof submitPracticeAnswer>[0],
        sessionId,
        1,
        { values: ['B'] },
      ),
      /练习会话已结束/,
    );
    assert.deepEqual(
      { ...sqlite.prepare(
        `SELECT status, answered_count, correct_count, incorrect_count, score
         FROM practice_sessions WHERE id = ?`,
      ).get(sessionId) },
      { status: terminalStatus, answered_count: 0, correct_count: 0, incorrect_count: 0, score: 0 },
    );
  }

  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM question_answers').get()?.count, 0);

  sqlite.prepare('INSERT INTO practice_sessions(id, bank_id, total_questions) VALUES (3, 1, 1)').run();
  sqlite.prepare(
    `INSERT INTO practice_session_questions(session_id, question_id, max_score, snapshot_json)
     VALUES (3, 1, 2, ?)`,
  ).run(snapshot);
  const submissions = await Promise.allSettled([
    submitPracticeAnswer(db, 3, 1, { values: ['B'] }),
    submitPracticeAnswer(db, 3, 1, { values: ['B'] }),
  ]);
  assert.equal(submissions.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = submissions.find((result) => result.status === 'rejected');
  assert.match(String(rejected && rejected.status === 'rejected' ? rejected.reason : ''), /已经提交/);
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT answered_count, correct_count, incorrect_count, score
      FROM practice_sessions WHERE id = 3
    `).get() },
    { answered_count: 1, correct_count: 1, incorrect_count: 0, score: 2 },
  );
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM question_answers WHERE session_id = 3').get()?.count, 1);

  await Promise.all([
    finishPracticeSession(db, 3, 'completed'),
    finishPracticeSession(db, 3, 'abandoned'),
  ]);
  assert.equal(sqlite.prepare('SELECT status FROM practice_sessions WHERE id = 3').get()?.status, 'completed');
  sqlite.prepare('INSERT INTO practice_sessions(id, bank_id, total_questions) VALUES (4, 1, 0)').run();
  await Promise.all([
    finishPracticeSession(db, 4, 'abandoned'),
    finishPracticeSession(db, 4, 'completed'),
  ]);
  assert.equal(sqlite.prepare('SELECT status FROM practice_sessions WHERE id = 4').get()?.status, 'abandoned');
  sqlite.close();
});
