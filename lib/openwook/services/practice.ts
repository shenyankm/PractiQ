import 'server-only';

import { sql } from '../db';
import { ApiError } from '../api';
import {
  acquireRedisLock,
  redisGetJson,
  redisGetOrSetJson,
  redisKey,
  redisSetJson
} from '../redis';
import { env } from '../env';
import {
  answerKeyCacheKey,
  fillBlankValues,
  getExistingPracticeAnswer,
  hasNonEmptyText,
  invalidateBankAnalytics,
  invalidateBankLeaderboard,
  invalidatePracticeSummaryCaches,
  invalidateUserAnalytics,
  loadBankQuestionItems,
  loadPracticeQuestionIds,
  normalizePracticeModeForTest,
  normalizeQuestionCountForTest,
  normalizeStringArray,
  objectValue,
  parseJson,
  practiceProgressFullLimit,
  practiceProgressWindowRadius,
  practiceQuestionQueueKey,
  practiceQueueTtl,
  toJsonValue
} from './internal';
import { getBank } from './banks';
import type { AnswerMode, PracticeAnswer, PracticeMode, PracticeSession, User } from '../types';

export async function startPracticeSession(
  user: User,
  data: {
    bankId: number;
    sessionType?: 'practice' | 'review' | 'exam';
    questionCount?: number;
    mode?: PracticeMode;
    questionTypeId?: string | null;
    allQuestions?: boolean;
  }
) {
  await getBank(user, data.bankId);
  const mode = normalizePracticeModeForTest(data.mode, data.sessionType);
  if (mode === 'by_type' && !data.questionTypeId?.trim()) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Question type is required for type-based practice');
  }
  const count = normalizeQuestionCountForTest(data.questionCount, data.allQuestions || mode === 'all' && data.questionCount === undefined);
  const questionIds = await loadPracticeQuestionIds(user, data.bankId, count, {
    mode,
    questionTypeId: data.questionTypeId ?? null,
    allQuestions: data.allQuestions
  });
  if (questionIds.length < 1) {
    throw new ApiError(
      409,
      'INVALID_STATE',
      mode === 'wrong'
        ? 'No wrong questions are available for review'
        : 'No active questions are available for practice'
    );
  }
  const rows = await sql<PracticeSession[]>`
    INSERT INTO user_practice_sessions (user_id, bank_id, session_type, question_count)
    VALUES (${user.id}, ${data.bankId}, ${mode === 'exam' ? 'exam' : mode === 'wrong' ? 'review' : data.sessionType ?? 'practice'}, ${questionIds.length})
    RETURNING *
  `;
  await redisSetJson(practiceQuestionQueueKey(rows[0].id), questionIds, practiceQueueTtl);
  return rows[0];
}

export async function getPracticeSession(user: User, sessionId: number) {
  const rows = await sql<PracticeSession[]>`
    SELECT *
    FROM user_practice_sessions
    WHERE id = ${sessionId} AND user_id = ${user.id}
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Practice session not found');
  return rows[0];
}

async function ensurePracticeQuestionQueue(session: PracticeSession) {
  if (!session.bank_id) return [];
  const key = practiceQuestionQueueKey(session.id);
  const cachedQuestionIds = await redisGetJson<number[]>(key);
  if (cachedQuestionIds?.length) return cachedQuestionIds.map(Number).slice(0, session.question_count);

  const rows = await sql<Array<{ question_id: number }>>`
    WITH active_question_ids AS (
      SELECT bql.question_id, bql.sort_order AS bank_sort_order, NULL::integer AS group_sort_order
      FROM bank_question_links bql
      WHERE bql.bank_id = ${session.bank_id}
        AND bql.status = 'active'

      UNION ALL

      SELECT gql.question_id, bgl.sort_order AS bank_sort_order, gql.sort_order AS group_sort_order
      FROM bank_group_links bgl
      JOIN group_question_links gql ON gql.group_id = bgl.group_id
      WHERE bgl.bank_id = ${session.bank_id}
        AND bgl.status = 'active'
    )
    SELECT ids.question_id
    FROM active_question_ids ids
    JOIN questions q ON q.id = ids.question_id
    WHERE q.status = 'active'
    ORDER BY ids.bank_sort_order, ids.group_sort_order NULLS FIRST, ids.question_id
    LIMIT ${session.question_count}
  `;
  const questionIds = rows.map((row) => Number(row.question_id));
  await redisSetJson(key, questionIds, practiceQueueTtl);
  return questionIds;
}

async function loadPracticeQuestionRows(session: PracticeSession, questionIds: number[], offset = 0, limit = session.question_count) {
  if (!session.bank_id || questionIds.length === 0) return [];
  const slice = questionIds.slice(offset, offset + limit);
  if (slice.length === 0) return [];
  const orderedItems = await loadBankQuestionItems(session.bank_id, {
    questionIds: slice,
    activeOnly: true,
    limit: slice.length
  });
  const orderByQuestionId = new Map(slice.map((questionId, index) => [Number(questionId), index]));
  return orderedItems.sort(
    (left, right) => (orderByQuestionId.get(Number(left.question_id)) ?? 0) - (orderByQuestionId.get(Number(right.question_id)) ?? 0)
  );
}

export async function getPracticeQuestions(user: User, sessionId: number) {
  const session = await getPracticeSession(user, sessionId);
  const questionIds = await ensurePracticeQuestionQueue(session);
  return loadPracticeQuestionRows(session, questionIds);
}

export async function getPracticeQuestionPage(user: User, sessionId: number, params?: URLSearchParams) {
  const session = await getPracticeSession(user, sessionId);
  const questionIds = await ensurePracticeQuestionQueue(session);
  const answeredSummaryRows = await sql<Array<Pick<PracticeAnswer, 'question_id' | 'is_correct'>>>`
    SELECT question_id, is_correct
    FROM user_question_answers
    WHERE user_id = ${user.id}
      AND session_id = ${sessionId}
    ORDER BY answered_at, id
  `;
  const answeredSummary = new Map(answeredSummaryRows.map((answer) => [Number(answer.question_id), answer]));
  const requestedIndex = Number(params?.get('index'));
  const firstUnansweredIndex = questionIds.findIndex((questionId) => !answeredSummary.has(questionId));
  const fallbackIndex = firstUnansweredIndex >= 0 ? firstUnansweredIndex : 0;
  const currentIndex = Number.isInteger(requestedIndex)
    ? Math.max(0, Math.min(requestedIndex, Math.max(questionIds.length - 1, 0)))
    : fallbackIndex;
  const rows = await loadPracticeQuestionRows(session, questionIds, currentIndex, 1);
  const question = rows[0] ?? null;
  const questionId = question ? Number(question.question_id) : null;
  const result = questionId ? await getExistingPracticeAnswer(user.id, sessionId, questionId) as PracticeAnswer | null : null;
  const progress = buildPracticeProgress(questionIds, answeredSummary, currentIndex);

  return {
    session,
    question,
    questionIndex: question ? currentIndex : 0,
    total: questionIds.length,
    answeredCount: answeredSummary.size,
    progress,
    progressTruncated: progress.length < questionIds.length,
    result,
    previousIndex: currentIndex > 0 ? currentIndex - 1 : null,
    nextIndex: currentIndex < questionIds.length - 1 ? currentIndex + 1 : null
  };
}

function buildPracticeProgress(
  questionIds: number[],
  answered: Map<number, Pick<PracticeAnswer, 'question_id' | 'is_correct'>>,
  currentIndex: number
) {
  const total = questionIds.length;
  const indexes = total <= practiceProgressFullLimit
    ? questionIds.map((_, index) => index)
    : windowedProgressIndexes(total, currentIndex, practiceProgressWindowRadius);

  return indexes.map((index) => {
    const questionId = questionIds[index];
    const result = answered.get(Number(questionId));
    return {
      questionId,
      index,
      isAnswered: Boolean(result),
      isCorrect: result?.is_correct ?? null
    };
  });
}

function windowedProgressIndexes(total: number, currentIndex: number, radius: number) {
  const normalizedRadius = Math.max(1, Math.min(radius, Math.max(total - 1, 1)));
  const indexes = new Set<number>([0, total - 1, currentIndex]);
  const start = Math.max(0, currentIndex - normalizedRadius);
  const end = Math.min(total - 1, currentIndex + normalizedRadius);
  for (let index = start; index <= end; index += 1) {
    indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
}

export async function listPracticeSessions(user: User, params: URLSearchParams) {
  const limit = Math.min(Number(params.get('limit') || 20), 100);
  const status = params.get('status');
  return sql<PracticeSession[]>`
    SELECT *
    FROM user_practice_sessions
    WHERE user_id = ${user.id}
      AND (${status ?? null}::text IS NULL OR status = ${status ?? null})
    ORDER BY started_at DESC, id DESC
    LIMIT ${limit}
  `;
}

export async function getBankWrongQuestionCount(user: User, bankId: number) {
  await getBank(user, bankId);
  const rows = await sql<Array<{ count: number }>>`
    WITH active_question_ids AS (
      SELECT bql.question_id
      FROM bank_question_links bql
      JOIN questions q ON q.id = bql.question_id
      WHERE bql.bank_id = ${bankId}
        AND bql.status = 'active'
        AND q.status = 'active'

      UNION

      SELECT gql.question_id
      FROM bank_group_links bgl
      JOIN group_question_links gql ON gql.group_id = bgl.group_id
      JOIN questions q ON q.id = gql.question_id
      WHERE bgl.bank_id = ${bankId}
        AND bgl.status = 'active'
        AND q.status = 'active'
    )
    SELECT COUNT(DISTINCT ids.question_id)::int AS count
    FROM active_question_ids ids
    JOIN user_question_stats uqs
      ON uqs.question_id = ids.question_id
     AND uqs.user_id = ${user.id}
    WHERE uqs.wrong_count > 0 OR uqs.last_is_correct IS FALSE
  `;
  return rows[0]?.count ?? 0;
}

export async function submitAnswer(
  user: User,
  sessionId: number,
  data: { questionId: number; answerPayload: Record<string, unknown>; durationMs?: number }
) {
  const lock = await acquireRedisLock(redisKey('practice', sessionId, 'question', data.questionId, 'submit'), 10_000);
  if (!lock.acquired) {
    const existing = await getExistingPracticeAnswer(user.id, sessionId, data.questionId);
    if (existing) return existing;
    throw new ApiError(409, 'DUPLICATE_SUBMISSION', 'Answer submission is already in progress');
  }

  try {
    const existing = await getExistingPracticeAnswer(user.id, sessionId, data.questionId);
    if (existing) return existing;

    const session = await getPracticeSession(user, sessionId);
    if (session.status !== 'active') {
      throw new ApiError(409, 'INVALID_STATE', 'Practice session is not active');
    }
    const queuedQuestionIds = await redisGetJson<number[]>(practiceQuestionQueueKey(sessionId));
    if (queuedQuestionIds?.length && !queuedQuestionIds.map(Number).includes(Number(data.questionId))) {
      throw new ApiError(404, 'NOT_FOUND', 'Question is not part of this practice session');
    }

    const answerKey = await redisGetOrSetJson<{ id: number; answer_payload: string; score_payload: string } | null>(
      answerKeyCacheKey(data.questionId),
      Number(env.ANSWER_KEY_CACHE_TTL_SECONDS || 300),
      async () => {
        const answerKeyRows = await sql<Array<{ id: number; answer_payload: string; score_payload: string }>>`
          SELECT id, answer_payload, score_payload
          FROM question_answer_keys
          WHERE question_id = ${data.questionId}
            AND is_primary = true
          LIMIT 1
        `;
        return answerKeyRows[0] ?? null;
      }
    );
    const questionRows = await sql<Array<{ answer_mode: AnswerMode }>>`
      SELECT q.answer_mode
      FROM questions q
      WHERE q.id = ${data.questionId}
        AND q.status = 'active'
        AND EXISTS (
          SELECT 1
          FROM bank_question_links bql
          WHERE bql.bank_id = ${session.bank_id}
            AND bql.question_id = q.id
            AND bql.status = 'active'

          UNION ALL

          SELECT 1
          FROM bank_group_links bgl
          JOIN group_question_links gql ON gql.group_id = bgl.group_id
          WHERE bgl.bank_id = ${session.bank_id}
            AND gql.question_id = q.id
            AND bgl.status = 'active'
        )
      LIMIT 1
    `;
    if (!questionRows[0]) throw new ApiError(404, 'NOT_FOUND', 'Question is not part of this active practice session');
    validateSubmittedAnswerForTest(questionRows[0].answer_mode, data.answerPayload);

    const isCorrect = answerKey ? gradeAnswerForTest(questionRows[0].answer_mode, answerKey.answer_payload, data.answerPayload) : null;
    const maxScore = answerKey ? 1 : null;
    const score = isCorrect === null ? null : isCorrect ? 1 : 0;

    const rows = await sql`
      INSERT INTO user_question_answers (
        user_id, session_id, bank_id, question_id, answer_key_id,
        answer_payload, is_correct, score, max_score, duration_ms
      )
      VALUES (
        ${user.id}, ${sessionId}, ${session.bank_id}, ${data.questionId}, ${answerKey?.id ?? null},
        ${sql.json(toJsonValue(data.answerPayload))}, ${isCorrect}, ${score}, ${maxScore}, ${data.durationMs ?? null}
      )
      RETURNING *
    `;
    await invalidateUserAnalytics(user.id);
    await invalidateBankAnalytics(session.bank_id);
    await invalidateBankLeaderboard(session.bank_id);
    await invalidatePracticeSummaryCaches(user.id, session.bank_id);
    return rows[0];
  } finally {
    await lock.release();
  }
}

export function validateSubmittedAnswerForTest(mode: AnswerMode, actual: Record<string, unknown>) {
  if (mode === 'choice' && normalizeStringArray(objectValue(actual, 'selected')).length < 1) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Select at least one option before submitting');
  }
  if (mode === 'true_false' && typeof actual.value !== 'boolean') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Select true or false before submitting');
  }
  if (mode === 'fill_blank' && fillBlankValues(actual).length < 1) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Fill at least one blank before submitting');
  }
  if (mode === 'short_answer' && !hasNonEmptyText(actual.value)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Answer text is required before submitting');
  }
}

export function gradeAnswerForTest(mode: AnswerMode, expectedJson: string, actual: Record<string, unknown>) {
  const expected = parseJson(expectedJson);
  if (!expected) return null;

  if (mode === 'choice') {
    return normalizeStringArray(objectValue(expected, 'selected')).join('|') === normalizeStringArray(objectValue(actual, 'selected')).join('|');
  }
  if (mode === 'true_false') {
    const expectedValue = objectValue(expected, 'value');
    const actualValue = objectValue(actual, 'value');
    if (typeof expectedValue !== 'boolean' || typeof actualValue !== 'boolean') return null;
    return expectedValue === actualValue;
  }
  if (mode === 'fill_blank') {
    const expectedValues = fillBlankValues(expected);
    const actualValues = fillBlankValues(actual);
    return expectedValues.length > 0
      && actualValues.length >= expectedValues.length
      && expectedValues.every((value, index) => value === actualValues[index]);
  }
  return null;
}

export async function completePracticeSession(user: User, sessionId: number, status: 'completed' | 'abandoned') {
  const rows = await sql<PracticeSession[]>`
    UPDATE user_practice_sessions
    SET status = ${status}, completed_at = NOW()
    WHERE id = ${sessionId}
      AND user_id = ${user.id}
      AND status = 'active'
    RETURNING *
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Active practice session not found');
  await invalidateUserAnalytics(user.id);
  return rows[0];
}

export async function getPracticeResults(user: User, sessionId: number) {
  await getPracticeSession(user, sessionId);
  return sql<Array<PracticeAnswer & { stem: string; answer_mode: AnswerMode; analysis: string | null; answer_keys: unknown }>>`
    SELECT
      uqa.*,
      q.stem,
      q.answer_mode,
      q.analysis,
      COALESCE(
        (
          SELECT json_agg(qak.* ORDER BY qak.version)
          FROM question_answer_keys qak
          WHERE qak.question_id = q.id
        ),
        '[]'
      ) AS answer_keys
    FROM user_question_answers uqa
    JOIN questions q ON q.id = uqa.question_id
    WHERE uqa.user_id = ${user.id}
      AND uqa.session_id = ${sessionId}
    ORDER BY uqa.answered_at, uqa.id
  `;
}
