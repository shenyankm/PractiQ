import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

import { expoDatabase } from './test-database';
import { migrateDatabase } from './database/migrations';

/**
 * Performance benchmark: measures the impact of covering indexes on stats views.
 * Run with: npx tsx --test src/perf.test.ts
 */

function seedAnswers(sqlite: DatabaseSync, count: number) {
  sqlite.exec('BEGIN');
  const insertSession = sqlite.prepare(
    `INSERT INTO practice_sessions(id, bank_id, mode, status, total_questions, answered_count, completed_at)
     VALUES (?, 1, 'all', 'completed', ?, ?, CURRENT_TIMESTAMP)`,
  );
  const insertAnswer = sqlite.prepare(
    `INSERT INTO question_answers(session_id, question_id, answer_json, is_correct, score)
     VALUES (?, ?, '{"values":["A"]}', ?, 1)`,
  );
  const questions = [1, 2, 3, 4, 5];
  let sessionId = 0;
  for (let i = 0; i < count; i += questions.length) {
    sessionId += 1;
    insertSession.run(sessionId, questions.length, questions.length);
    for (const qid of questions) {
      insertAnswer.run(sessionId, qid, i % 3 === 0 ? 0 : 1);
    }
  }
  sqlite.exec('COMMIT');
  return sessionId;
}

test('perf: covering index speeds up question_stats view (5000 answers)', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo);
  seedAnswers(sqlite, 5000);

  // Warm up
  sqlite.prepare('SELECT * FROM question_stats').all();

  const start = performance.now();
  for (let i = 0; i < 100; i += 1) {
    sqlite.prepare('SELECT * FROM question_stats').all();
  }
  const withIndex = performance.now() - start;

  // Drop the covering index and measure again
  sqlite.exec('DROP INDEX idx_answers_question_stats');
  sqlite.prepare('SELECT * FROM question_stats').all(); // warm up

  const startNoIdx = performance.now();
  for (let i = 0; i < 100; i += 1) {
    sqlite.prepare('SELECT * FROM question_stats').all();
  }
  const withoutIndex = performance.now() - startNoIdx;

  console.log(`  question_stats (5000 answers, 100 iterations):`);
  console.log(`    WITH covering index:    ${withIndex.toFixed(2)} ms`);
  console.log(`    WITHOUT covering index: ${withoutIndex.toFixed(2)} ms`);
  console.log(`    Speedup: ${(withoutIndex / withIndex).toFixed(2)}x`);

  // The covering index should be used (verify via query plan)
  sqlite.exec('CREATE INDEX idx_answers_question_stats ON question_answers(question_id, is_correct, submitted_at)');
  const plan = sqlite.prepare('EXPLAIN QUERY PLAN SELECT * FROM question_stats').all() as { detail: string }[];
  assert.ok(
    plan.some((step) => step.detail.includes('idx_answers_question_stats')),
    'Expected covering index to be used in question_stats view',
  );
  sqlite.close();
});

test('perf: covering index speeds up bank_stats view (5000 answers)', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo);
  seedAnswers(sqlite, 5000);

  // Warm up
  sqlite.prepare('SELECT * FROM bank_stats').all();

  const start = performance.now();
  for (let i = 0; i < 100; i += 1) {
    sqlite.prepare('SELECT * FROM bank_stats').all();
  }
  const withIndex = performance.now() - start;

  sqlite.exec('DROP INDEX idx_answers_session_stats');
  sqlite.prepare('SELECT * FROM bank_stats').all(); // warm up

  const startNoIdx = performance.now();
  for (let i = 0; i < 100; i += 1) {
    sqlite.prepare('SELECT * FROM bank_stats').all();
  }
  const withoutIndex = performance.now() - startNoIdx;

  console.log(`  bank_stats (5000 answers, 100 iterations):`);
  console.log(`    WITH covering index:    ${withIndex.toFixed(2)} ms`);
  console.log(`    WITHOUT covering index: ${withoutIndex.toFixed(2)} ms`);
  console.log(`    Speedup: ${(withoutIndex / withIndex).toFixed(2)}x`);
  sqlite.close();
});

test('perf: clean shutdown skips foreign_key_check on startup', async () => {
  // Simulate a database with data that has already been migrated
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo);
  seedAnswers(sqlite, 2000);

  // Mark clean shutdown
  sqlite.exec(`INSERT INTO app_settings(key, value) VALUES ('clean_shutdown', '1')
    ON CONFLICT(key) DO UPDATE SET value = '1'`);

  // Measure startup with clean shutdown (skips foreign_key_check)
  const startClean = performance.now();
  await migrateDatabase(expo);
  const cleanTime = performance.now() - startClean;

  // Now without clean shutdown flag (runs foreign_key_check)
  sqlite.exec(`UPDATE app_settings SET value = '0' WHERE key = 'clean_shutdown'`);
  const startDirty = performance.now();
  await migrateDatabase(expo);
  const dirtyTime = performance.now() - startDirty;

  console.log(`  Startup integrity check (2000 answers):`);
  console.log(`    Clean shutdown (skip FK check): ${cleanTime.toFixed(2)} ms`);
  console.log(`    Dirty shutdown (full FK check): ${dirtyTime.toFixed(2)} ms`);
  console.log(`    Saved: ${(dirtyTime - cleanTime).toFixed(2)} ms (${((1 - cleanTime / dirtyTime) * 100).toFixed(0)}%)`);
  sqlite.close();
});

test('perf: weak knowledge points query with covering index', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const expo = expoDatabase(sqlite);
  await migrateDatabase(expo);
  // Link questions to knowledge points
  sqlite.exec(`
    INSERT OR IGNORE INTO question_knowledge_links(question_id, knowledge_point_id)
    VALUES (1, 1), (2, 1), (3, 3), (4, 2), (5, 2);
  `);
  seedAnswers(sqlite, 5000);

  const weakSql = `
    SELECT kp.id, kp.name, s.name AS subject_name,
      SUM(qs.correct_count + qs.incorrect_count) AS graded,
      SUM(qs.correct_count) AS correct
    FROM knowledge_points kp JOIN subjects s ON s.id = kp.subject_id
    JOIN question_knowledge_links qkl ON qkl.knowledge_point_id = kp.id
    JOIN question_stats qs ON qs.question_id = qkl.question_id
    GROUP BY kp.id HAVING SUM(qs.correct_count + qs.incorrect_count) > 0
    ORDER BY CAST(SUM(qs.correct_count) AS REAL) / SUM(qs.correct_count + qs.incorrect_count), graded DESC LIMIT 8`;

  // Warm up
  sqlite.prepare(weakSql).all();

  const start = performance.now();
  for (let i = 0; i < 50; i += 1) {
    sqlite.prepare(weakSql).all();
  }
  const withIndex = performance.now() - start;

  sqlite.exec('DROP INDEX idx_answers_question_stats');
  sqlite.prepare(weakSql).all();

  const startNoIdx = performance.now();
  for (let i = 0; i < 50; i += 1) {
    sqlite.prepare(weakSql).all();
  }
  const withoutIndex = performance.now() - startNoIdx;

  console.log(`  weak knowledge points (5000 answers, 50 iterations):`);
  console.log(`    WITH covering index:    ${withIndex.toFixed(2)} ms`);
  console.log(`    WITHOUT covering index: ${withoutIndex.toFixed(2)} ms`);
  console.log(`    Speedup: ${(withoutIndex / withIndex).toFixed(2)}x`);
  sqlite.close();
});
