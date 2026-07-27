import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';

import { DATABASE_VERSION, migrateDatabase } from './database/migrations';
import { expoDatabase } from './test-database';

test('every historical database version migrates to the current schema without losing local data', async () => {
  for (let sourceVersion = 1; sourceVersion < DATABASE_VERSION; sourceVersion += 1) {
    const sqlite = new DatabaseSync(':memory:');
    const expo = expoDatabase(sqlite);

    await migrateDatabase(expo, { targetVersion: sourceVersion });
    sqlite.exec(`
      INSERT INTO subjects(id, name) VALUES (99, 'Migration subject');
      INSERT INTO question_banks(id, subject_id, name, description)
      VALUES (99, 99, 'Migration bank', 'preserve me');
    `);
    if (sourceVersion < 11) {
      sqlite.exec(`
      INSERT INTO question_import_jobs(
        id, bank_id, file_name, file_type, source_uri, stored_uri, parser, status, stage
      ) VALUES (
        99, 99, 'source.txt', 'txt', 'file:///picker/source.txt',
        'file:///imports/source.txt', 'local', 'completed', '正在写入 12 道题'
      );
      INSERT INTO artifacts(job_id, kind, uri, mime_type, size, metadata_json)
      VALUES (
        99, 'source', 'file:///imports/source.txt', 'text/plain', 17,
        '{"parsedTextCharacters":17}'
      );
      `);
    } else {
      sqlite.exec(`
        INSERT INTO question_import_jobs(
          id, bank_id, file_name, file_type, source_uri, stored_uri, parser, status, stage,
          source_mime_type, source_size, source_metadata_json
        ) VALUES (
          99, 99, 'source.txt', 'txt', 'file:///picker/source.txt',
          'file:///imports/source.txt', 'local', 'completed',
          '${sourceVersion >= 12 ? 'stage:writing:12' : '正在写入 12 道题'}',
          'text/plain', 17, '{"parsedTextCharacters":17}'
        );
      `);
    }

    await migrateDatabase(expo);

    assert.equal(
      sqlite.prepare('PRAGMA user_version').get()?.user_version,
      DATABASE_VERSION,
      `source version ${sourceVersion}`,
    );
    assert.equal(
      sqlite.prepare('SELECT description FROM question_banks WHERE id = 99').get()?.description,
      'preserve me',
      `source version ${sourceVersion}`,
    );
    assert.deepEqual(
      { ...sqlite.prepare(`
        SELECT source_mime_type, source_size, source_metadata_json
        FROM question_import_jobs WHERE id = 99
      `).get() },
      {
        source_mime_type: 'text/plain',
        source_size: 17,
        source_metadata_json: '{"parsedTextCharacters":17}',
      },
      `source version ${sourceVersion}`,
    );
    assert.equal(
      sqlite.prepare('SELECT stage FROM question_import_jobs WHERE id = 99').get()?.stage,
      'stage:writing:12',
      `source version ${sourceVersion}`,
    );
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count,
      DATABASE_VERSION,
      `source version ${sourceVersion}`,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'artifacts'").get()?.count,
      0,
      `source version ${sourceVersion}`,
    );
    assert.equal(sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    sqlite.close();
  }
});

test('an unchanged current database uses the lightweight startup integrity check', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const database = expoDatabase(sqlite);
  await migrateDatabase(database);
  const checks: string[] = [];
  const observed = {
    ...database,
    getFirstAsync: async (sql: string, ...params: unknown[]) => {
      checks.push(sql);
      return Reflect.apply(database.getFirstAsync, database, [sql, ...params]);
    },
  };

  await migrateDatabase(observed as unknown as SQLiteDatabase);

  assert.ok(checks.includes('PRAGMA quick_check'));
  assert.ok(!checks.includes('PRAGMA integrity_check'));
  sqlite.close();
});

test('v13 repairs completed-session metrics and installs hot-path indexes', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo, { targetVersion: 12 });
  sqlite.exec(`
    UPDATE bank_stats SET sessions = 9 WHERE bank_id = 1;
    INSERT INTO practice_sessions(bank_id, mode, status, total_questions)
    VALUES (1, 'all', 'completed', 1), (1, 'all', 'abandoned', 1);
  `);

  await migrateDatabase(expo, { targetVersion: 13 });

  assert.equal(sqlite.prepare('SELECT sessions FROM bank_stats WHERE bank_id = 1').get()?.sessions, 1);
  for (const name of [
    'idx_qkl_knowledge_question',
    'idx_answers_submitted',
    'idx_sessions_status_started',
    'idx_content_blocks_media',
    'idx_snapshot_media_refs_uri',
  ]) {
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name)?.count,
      1,
      name,
    );
  }
  sqlite.close();
});

test('v14 installs group ordering indexes without temporary sorting', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo, { targetVersion: 13 });
  await migrateDatabase(expo, { targetVersion: 14 });

  for (const [name, sql, parameter] of [
    [
      'idx_bank_groups_order',
      'SELECT group_id FROM bank_group_links WHERE bank_id = ? ORDER BY sort_order, group_id',
      1,
    ],
    [
      'idx_group_questions_order',
      'SELECT question_id FROM group_question_links WHERE group_id = ? ORDER BY sort_order, question_id',
      1,
    ],
  ] as const) {
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name)?.count,
      1,
    );
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(parameter) as { detail: string }[];
    assert.equal(plan.some((step) => step.detail.includes('USE TEMP B-TREE')), false, JSON.stringify(plan));
  }
  sqlite.close();
});

test('v17 installs status and recency indexes that satisfy dashboard hot-path queries', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo, { targetVersion: 16 });
  await migrateDatabase(expo, { targetVersion: 17 });

  for (const name of ['idx_questions_status', 'idx_banks_recent']) {
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name)?.count,
      1,
      name,
    );
  }

  const activeCountPlan = sqlite.prepare(
    "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM questions WHERE status = 'active'",
  ).all() as { detail: string }[];
  assert.ok(
    activeCountPlan.some((step) => step.detail.includes('idx_questions_status')),
    JSON.stringify(activeCountPlan),
  );

  const recentPlan = sqlite.prepare(
    'EXPLAIN QUERY PLAN SELECT id FROM question_banks ORDER BY updated_at DESC, id DESC LIMIT 4',
  ).all() as { detail: string }[];
  assert.equal(
    recentPlan.some((step) => step.detail.includes('USE TEMP B-TREE')),
    false,
    JSON.stringify(recentPlan),
  );
  sqlite.close();
});

test('v18 installs covering indexes for stats views', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo, { targetVersion: 17 });
  await migrateDatabase(expo, { targetVersion: 18 });

  for (const name of ['idx_answers_question_stats', 'idx_answers_session_stats']) {
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name)?.count,
      1,
      name,
    );
  }

  const questionStatsPlan = sqlite.prepare(
    'EXPLAIN QUERY PLAN SELECT question_id, COUNT(*) AS attempts, COUNT(CASE WHEN is_correct = 1 THEN 1 END) AS correct_count FROM question_answers GROUP BY question_id',
  ).all() as { detail: string }[];
  assert.ok(
    questionStatsPlan.some((step) => step.detail.includes('idx_answers_question_stats')),
    JSON.stringify(questionStatsPlan),
  );
  sqlite.close();
});

test('v15 replaces mirrored state with aggregate views and one latest report', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo, { targetVersion: 14 });
  sqlite.exec(`
    INSERT INTO practice_sessions(id, bank_id, mode, status, total_questions, completed_at)
    VALUES
      (90, 1, 'all', 'completed', 1, '2026-01-02 00:00:00'),
      (91, 1, 'all', 'abandoned', 1, '2026-01-03 00:00:00');
    INSERT INTO question_answers(
      session_id, question_id, answer_json, is_correct, score, submitted_at
    ) VALUES
      (90, 1, '{}', 1, 2, '2026-01-01 00:00:00'),
      (91, 1, '{}', 0, 0, '2026-01-02 12:00:00');
    UPDATE bank_stats SET sessions = 99, answers = 99 WHERE bank_id = 1;
    INSERT INTO question_stats(question_id, attempts) VALUES (1, 99);
    INSERT INTO learning_reports(bank_id, report, stats_json, created_at) VALUES
      (NULL, 'old', '{}', '2026-01-01 00:00:00'),
      (NULL, 'new', '{}', '2026-01-02 00:00:00'),
      (1, 'unused bank report', '{}', '2026-01-03 00:00:00');
  `);

  await migrateDatabase(expo, { targetVersion: 15 });

  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT attempts, correct_count, incorrect_count, last_answered_at
      FROM question_stats WHERE question_id = 1
    `).get() },
    {
      attempts: 2,
      correct_count: 1,
      incorrect_count: 1,
      last_answered_at: '2026-01-02 12:00:00',
    },
  );
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT sessions, answers, correct_count, incorrect_count, total_score, last_practiced_at
      FROM bank_stats WHERE bank_id = 1
    `).get() },
    {
      sessions: 1,
      answers: 2,
      correct_count: 1,
      incorrect_count: 1,
      total_score: 2,
      last_practiced_at: '2026-01-03 00:00:00',
    },
  );
  assert.deepEqual(
    { ...sqlite.prepare('SELECT id, report, created_at FROM learning_reports').get() },
    { id: 1, report: 'new', created_at: '2026-01-02 00:00:00' },
  );
  assert.deepEqual(
    sqlite.prepare("SELECT name FROM pragma_table_info('learning_reports') ORDER BY cid").all()
      .map((row) => row.name),
    ['id', 'report', 'created_at'],
  );
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name IN ('events', 'practice_snapshot_media_refs')
    `).get()?.count,
    0,
  );
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE type = 'view' AND name IN ('question_stats', 'bank_stats')
    `).get()?.count,
    2,
  );
  sqlite.close();
});

test('v16 rejects pre-existing cross-subject relationships without partial trigger installation', async () => {
  const cases = [
    {
      name: 'updated bank membership',
      setup: `
        INSERT INTO question_banks(id, subject_id, name) VALUES (200, 2, 'Subject 2 bank');
        INSERT INTO questions(id, subject_id, question_type_code, stem)
        VALUES (200, 2, 'true_false', 'Subject 2 question');
        INSERT INTO bank_question_links(bank_id, question_id) VALUES (200, 200);
        UPDATE bank_question_links SET bank_id = 1 WHERE bank_id = 200 AND question_id = 200;
      `,
    },
    {
      name: 'cross-subject knowledge link',
      setup: `
        INSERT INTO knowledge_points(id, subject_id, name) VALUES (200, 2, 'Subject 2 point');
        INSERT INTO question_knowledge_links(question_id, knowledge_point_id) VALUES (1, 200);
      `,
    },
  ];

  for (const { name, setup } of cases) {
    const sqlite = new DatabaseSync(':memory:');
    const expo = expoDatabase(sqlite);
    await migrateDatabase(expo, { targetVersion: 15 });
    sqlite.exec(setup);

    await assert.rejects(migrateDatabase(expo), /CHECK constraint failed/, name);

    assert.equal(sqlite.prepare('PRAGMA user_version').get()?.user_version, 15, name);
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 16').get()?.count,
      0,
      name,
    );
    assert.equal(
      sqlite.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_schema
        WHERE type = 'trigger' AND name = 'question_knowledge_subject_must_match'
      `).get()?.count,
      0,
      name,
    );
    sqlite.close();
  }
});

test('v16 rejects historical practice rows whose snapshot could not be backfilled', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo, { targetVersion: 5 });
  sqlite.exec(`
    DELETE FROM bank_question_links WHERE bank_id = 1 AND question_id = 1;
    INSERT INTO practice_sessions(id, bank_id, mode, total_questions)
    VALUES (100, 1, 'all', 1);
    INSERT INTO practice_session_questions(
      session_id, question_id, position, answer_key_id, max_score
    ) VALUES (100, 1, 0, 1, 2);
  `);
  await migrateDatabase(expo, { targetVersion: 15 });
  assert.equal(
    sqlite.prepare('SELECT snapshot_json FROM practice_session_questions WHERE session_id = 100').get()?.snapshot_json,
    null,
  );

  await assert.rejects(migrateDatabase(expo), /CHECK constraint failed/);

  assert.equal(sqlite.prepare('PRAGMA user_version').get()?.user_version, 15);
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 16').get()?.count,
    0,
  );
  sqlite.close();
});

test('v15 views derive empty, ungraded, changed, and deleted activity without mirrored writes', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo);
  sqlite.exec(`
    INSERT INTO question_banks(id, subject_id, name) VALUES (100, 1, '空题库');
    INSERT INTO practice_sessions(id, bank_id, mode, status, total_questions)
    VALUES (100, 1, 'all', 'active', 1);
    INSERT INTO question_answers(
      id, session_id, question_id, answer_json, is_correct, score, submitted_at
    ) VALUES (100, 100, 1, '{"text":"自评"}', NULL, NULL, '2026-02-01 00:00:00');
  `);

  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT attempts, correct_count, incorrect_count FROM question_stats WHERE question_id = 1
    `).get() },
    { attempts: 1, correct_count: 0, incorrect_count: 0 },
  );
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT answers, correct_count, incorrect_count, total_score, last_practiced_at
      FROM bank_stats WHERE bank_id = 1
    `).get() },
    {
      answers: 1,
      correct_count: 0,
      incorrect_count: 0,
      total_score: 0,
      last_practiced_at: '2026-02-01 00:00:00',
    },
  );
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT sessions, answers, total_score, last_practiced_at FROM bank_stats WHERE bank_id = 100
    `).get() },
    { sessions: 0, answers: 0, total_score: 0, last_practiced_at: null },
  );

  sqlite.exec('UPDATE question_answers SET is_correct = 1, score = 2 WHERE id = 100');
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT attempts, correct_count, incorrect_count FROM question_stats WHERE question_id = 1
    `).get() },
    { attempts: 1, correct_count: 1, incorrect_count: 0 },
  );
  sqlite.exec('DELETE FROM question_answers WHERE id = 100');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM question_stats WHERE question_id = 1').get()?.count, 0);
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT answers, correct_count, incorrect_count, total_score, last_practiced_at
      FROM bank_stats WHERE bank_id = 1
    `).get() },
    { answers: 0, correct_count: 0, incorrect_count: 0, total_score: 0, last_practiced_at: null },
  );
  assert.throws(
    () => sqlite.exec('INSERT INTO question_stats(question_id, attempts) VALUES (1, 1)'),
    /cannot modify question_stats/,
  );
  sqlite.close();
});

test('v15 migration rolls back earlier cleanup when a legacy object is missing', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo, { targetVersion: 14 });
  sqlite.exec('DROP TABLE question_stats');

  await assert.rejects(migrateDatabase(expo), /no such table: question_stats/);

  assert.equal(sqlite.prepare('PRAGMA user_version').get()?.user_version, 14);
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get()?.count,
    0,
  );
  for (const table of ['events', 'practice_snapshot_media_refs', 'bank_stats', 'learning_reports']) {
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)?.count,
      1,
      table,
    );
  }
  sqlite.close();
});

test('migration startup rejects newer databases and incomplete migration history', async () => {
  const newer = new DatabaseSync(':memory:');
  const newerExpo = expoDatabase(newer);
  await migrateDatabase(newerExpo);
  newer.exec(`PRAGMA user_version = ${DATABASE_VERSION + 1}`);
  await assert.rejects(migrateDatabase(newerExpo), /版本高于当前应用版本/);
  newer.close();

  const incomplete = new DatabaseSync(':memory:');
  const incompleteExpo = expoDatabase(incomplete);
  await migrateDatabase(incompleteExpo);
  incomplete.exec('DELETE FROM schema_migrations WHERE version = 7');
  await assert.rejects(migrateDatabase(incompleteExpo), /迁移记录不完整/);
  incomplete.close();
});

test('startup recovers interrupted imports without changing other queue states', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo);
  sqlite.exec(`
    INSERT INTO question_import_jobs(
      id, bank_id, file_name, file_type, source_uri, stored_uri, parser, status, stage
    ) VALUES
      (100, 1, 'running.txt', 'txt', 'file:///running', 'file:///running', 'local', 'running', 'stage:reading_txt'),
      (101, 1, 'queued.txt', 'txt', 'file:///queued', 'file:///queued', 'local', 'queued', 'stage:queued'),
      (102, 1, 'done.txt', 'txt', 'file:///done', 'file:///done', 'local', 'completed', 'stage:completed:1');
  `);

  await migrateDatabase(expo);

  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT status, stage, error, finished_at IS NOT NULL AS finished
      FROM question_import_jobs WHERE id = 100
    `).get() },
    {
      status: 'failed',
      stage: 'stage:interrupted',
      error: 'error:interrupted',
      finished: 1,
    },
  );
  assert.deepEqual(
    sqlite.prepare('SELECT id, status FROM question_import_jobs WHERE id IN (101, 102) ORDER BY id').all()
      .map((row) => [row.id, row.status]),
    [[101, 'queued'], [102, 'completed']],
  );
  sqlite.close();
});
