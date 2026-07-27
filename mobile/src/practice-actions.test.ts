import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { migrateDatabase } from './database/migrations';
import { createPracticeSession } from './features/practice/actions';
import { expoDatabase } from './test-database';

test('practice modes select eligible questions and keep exam and scoring semantics', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const db = expoDatabase(sqlite);
  await migrateDatabase(db);
  sqlite.exec(`
    INSERT INTO practice_sessions(id, bank_id, mode, status, total_questions)
    VALUES (100, 1, 'all', 'completed', 1);
    INSERT INTO question_answers(session_id, question_id, answer_json, is_correct, score)
    VALUES (100, 1, '{"values":["A"]}', 0, 0);
  `);

  const wrong = await createPracticeSession(db, 1, 'wrong', null, 20);
  assert.deepEqual(
    sqlite.prepare(`
      SELECT question_id FROM practice_session_questions WHERE session_id = ? ORDER BY position
    `).all(wrong).map((row) => row.question_id),
    [1],
  );

  const fillBlank = await createPracticeSession(db, 1, 'type', 'fill_blank', 20);
  assert.deepEqual(
    sqlite.prepare(`
      SELECT question_id FROM practice_session_questions WHERE session_id = ? ORDER BY position
    `).all(fillBlank).map((row) => row.question_id),
    [4],
  );

  const exam = await createPracticeSession(db, 1, 'exam', null, 1);
  const examRow = sqlite.prepare(`
    SELECT mode, exam_mode, total_questions FROM practice_sessions WHERE id = ?
  `).get(exam);
  assert.deepEqual(
    { mode: examRow?.mode, exam_mode: examRow?.exam_mode },
    { mode: 'exam', exam_mode: 1 },
  );
  assert.ok(Number(examRow?.total_questions) >= 1 && Number(examRow?.total_questions) <= 2);

  const all = await createPracticeSession(db, 1, 'all', null, 200);
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT total_questions, max_score FROM practice_sessions WHERE id = ?
    `).get(all) },
    { total_questions: 5, max_score: 9 },
  );
  sqlite.close();
});
