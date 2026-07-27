import type { SQLiteDatabase } from 'expo-sqlite';

import { writeTransaction } from '../../database-core';
import { gradeAnswer, serializePracticeAnswer } from '../../logic';
import type { PracticeMode, QuestionType } from '../../types';

export const MAX_SESSION_QUESTIONS = 200;

export async function createPracticeSession(
  db: SQLiteDatabase,
  bankId: number,
  mode: PracticeMode,
  questionType: QuestionType | null,
  requestedCount: number,
) {
  const count = Math.max(1, Math.min(MAX_SESSION_QUESTIONS, Math.round(requestedCount)));
  const conditions = ["q.status = 'active'", 'ak.is_primary = 1'];
  const filterParams: (string | number)[] = [];
  let statsJoin = '';
  if (mode === 'wrong') {
    statsJoin = 'JOIN question_stats qs ON qs.question_id = q.id';
    conditions.push('qs.incorrect_count > 0');
  }
  if (mode === 'type' && questionType) {
    conditions.push('q.question_type_code = ?');
    filterParams.push(questionType);
  }
  let sessionId = 0;
  await writeTransaction(db, [
    'practice_sessions',
    'practice_session_questions',
  ], async (transaction) => {
    const questions = await transaction.getAllAsync<{
      id: number;
      answer_key_id: number;
      default_score: number;
      type: QuestionType;
      snapshot_json: string;
    }>(
      `WITH membership AS (
         SELECT gql.question_id, gql.group_id, bgl.sort_order AS group_order,
           gql.sort_order AS child_order,
           ROW_NUMBER() OVER (
             PARTITION BY gql.question_id
             ORDER BY bgl.sort_order, gql.sort_order, gql.group_id
           ) AS membership_rank
         FROM bank_group_links bgl
         JOIN group_question_links gql ON gql.group_id = bgl.group_id
         WHERE bgl.bank_id = ?
       ), candidates AS MATERIALIZED (
         SELECT q.id, ak.id AS answer_key_id, q.default_score,
           q.question_type_code AS type, snapshot.snapshot_json,
           membership.group_id, membership.group_order, membership.child_order,
           bql.sort_order AS bank_order,
           CASE WHEN membership.group_id IS NULL THEN -q.id ELSE membership.group_id END AS unit_id
         FROM bank_question_links bql
         JOIN questions q ON q.id = bql.question_id
         JOIN question_answer_keys ak ON ak.question_id = q.id
         JOIN practice_question_snapshot_source snapshot
           ON snapshot.bank_id = bql.bank_id
           AND snapshot.question_id = q.id AND snapshot.answer_key_id = ak.id
         LEFT JOIN membership
           ON membership.question_id = q.id AND membership.membership_rank = 1
         ${statsJoin}
         WHERE bql.bank_id = ? AND ${conditions.join(' AND ')}
       ), units AS MATERIALIZED (
         SELECT unit_id, COUNT(*) AS unit_size,
           CASE WHEN ? = 1 THEN RANDOM()
             ELSE MIN(CASE WHEN group_id IS NULL THEN 1000000000 + bank_order ELSE group_order END)
           END AS unit_sort
         FROM candidates GROUP BY unit_id
       ), ordered_units AS (
         SELECT unit_id,
           ROW_NUMBER() OVER (ORDER BY unit_sort, unit_id) AS unit_position,
           COALESCE(SUM(unit_size) OVER (
             ORDER BY unit_sort, unit_id
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ), 0) AS before_count
         FROM units
       )
       SELECT candidates.id, candidates.answer_key_id, candidates.default_score,
         candidates.type, candidates.snapshot_json
       FROM candidates JOIN ordered_units USING(unit_id)
       WHERE ordered_units.before_count < ?
       ORDER BY ordered_units.unit_position,
         CASE WHEN candidates.group_id IS NULL THEN candidates.bank_order ELSE candidates.child_order END,
         candidates.id`,
      [bankId, bankId, ...filterParams, mode === 'exam' ? 1 : 0, count],
    );
    if (!questions.length) throw new Error('当前条件下没有可练习的已发布试题');
    if (questions.length > MAX_SESSION_QUESTIONS) {
      throw new Error(`题组超过单次练习 ${MAX_SESSION_QUESTIONS} 题上限，请先拆分题组`);
    }
    const maxScore = questions.reduce(
      (sum, question) => sum + (question.type === 'short_answer' ? 0 : question.default_score),
      0,
    );
    const result = await transaction.runAsync(
      `INSERT INTO practice_sessions
       (bank_id, mode, question_type_code, exam_mode, total_questions, max_score)
       VALUES (?, ?, ?, ?, ?, ?)`,
      bankId,
      mode,
      mode === 'type' ? questionType : null,
      mode === 'exam' ? 1 : 0,
      questions.length,
      maxScore,
    );
    sessionId = result.lastInsertRowId;
    for (const [position, question] of questions.entries()) {
      await transaction.runAsync(
        `INSERT INTO practice_session_questions
         (session_id, question_id, position, answer_key_id, max_score, snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        sessionId,
        question.id,
        position,
        question.answer_key_id,
        question.default_score,
        question.snapshot_json,
      );
    }
  });
  return sessionId;
}

export async function submitPracticeAnswer(
  db: SQLiteDatabase,
  sessionId: number,
  questionId: number,
  submitted: unknown,
) {
  const result: { grade?: ReturnType<typeof gradeAnswer> } = {};
  await writeTransaction(db, [
    'question_answers',
    'practice_sessions',
  ], async (transaction) => {
    const row = await transaction.getFirstAsync<{
      status: string;
      type: QuestionType;
      answer_json: string;
      max_score: number;
    }>(
      `SELECT s.status,
         json_extract(psq.snapshot_json, '$.questionTypeCode') AS type,
         json_extract(psq.snapshot_json, '$.answerJson') AS answer_json,
         psq.max_score
       FROM practice_sessions s
       JOIN practice_session_questions psq ON psq.session_id = s.id
       WHERE s.id = ? AND psq.question_id = ?`,
      sessionId,
      questionId,
    );
    if (!row || row.status !== 'active') throw new Error('练习会话已结束或不存在');
    const existing = await transaction.getFirstAsync<{ id: number }>(
      'SELECT id FROM question_answers WHERE session_id = ? AND question_id = ?',
      sessionId,
      questionId,
    );
    if (existing) throw new Error('本题已经提交');

    const submittedJson = serializePracticeAnswer(row.type, submitted);
    const grade = gradeAnswer(row.type, submitted, JSON.parse(row.answer_json), row.max_score);
    await transaction.runAsync(
      `INSERT INTO question_answers
       (session_id, question_id, answer_json, is_correct, score, feedback)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sessionId,
      questionId,
      submittedJson,
      grade.isCorrect === null ? null : grade.isCorrect ? 1 : 0,
      grade.score,
      grade.feedback,
    );
    await transaction.runAsync(
      `UPDATE practice_sessions SET
         answered_count = answered_count + 1,
         correct_count = correct_count + ?,
         incorrect_count = incorrect_count + ?,
         score = score + ?,
         current_index = MIN(current_index + 1, total_questions - 1)
       WHERE id = ?`,
      grade.isCorrect === true ? 1 : 0,
      grade.isCorrect === false ? 1 : 0,
      grade.score ?? 0,
      sessionId,
    );
    result.grade = grade;
  });
  if (!result.grade) throw new Error('答案提交失败');
  return result.grade;
}

export async function finishPracticeSession(
  db: SQLiteDatabase,
  sessionId: number,
  status: 'completed' | 'abandoned',
) {
  await writeTransaction(db, ['practice_sessions'], (transaction) => transaction.runAsync(
      `UPDATE practice_sessions
       SET status = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'active'`,
      status,
      sessionId,
    ));
}
