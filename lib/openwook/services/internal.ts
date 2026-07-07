import 'server-only';

import { sql } from '../db';
import { ApiError } from '../api';
import {
  redisDel,
  redisGetJson,
  redisGetOrSetJson,
  redisGetText,
  redisIncr,
  redisKey
} from '../redis';
import { env } from '../env';
import type {
  AnswerMode,
  BankQuestionItem,
  PracticeAnswer,
  PracticeMode,
  PracticeSessionOptions,
  User
} from '../types';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const shortCacheTtl = Number(env.OPENWOOK_SHORT_CACHE_TTL_SECONDS || 60);
export const referenceCacheTtl = Number(env.OPENWOOK_REFERENCE_CACHE_TTL_SECONDS || 3600);
export const practiceQueueTtl = Number(env.PRACTICE_QUEUE_TTL_SECONDS || 7 * 24 * 60 * 60);
export const maxPracticeQuestions = Number(env.PRACTICE_MAX_QUESTIONS || 500);
export const practiceProgressFullLimit = Number(env.PRACTICE_PROGRESS_FULL_LIMIT || 120);
export const practiceProgressWindowRadius = Number(env.PRACTICE_PROGRESS_WINDOW_RADIUS || 30);

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

export function practiceQuestionQueueKey(sessionId: number) {
  return redisKey('practice', sessionId, 'question-ids');
}

export function answerKeyCacheKey(questionId: number) {
  return redisKey('cache', 'answer-key', questionId);
}

type BankQuestionIdentity = Pick<
  BankQuestionItem,
  'bank_id' | 'group_id' | 'question_id' | 'item_scope' | 'bank_sort_order' | 'group_sort_order' | 'question_no' | 'bank_link_status'
>;

export async function cacheVersion(scope: string, id?: number | string | null) {
  return await redisGetText(redisKey('cache-version', scope, id ?? 'global')) ?? '0';
}

async function invalidateUserBankLists(userId?: number) {
  await redisIncr(redisKey('cache-version', 'banks', userId ?? 'global'));
}

export async function invalidateUserAnalytics(userId: number) {
  await redisIncr(redisKey('cache-version', 'analytics', userId));
}

export async function invalidateBankLeaderboard(bankId: number | null | undefined) {
  if (bankId) await redisIncr(redisKey('cache-version', 'leaderboard', bankId));
}

export async function invalidateBankCachesForTest(bankId: number, userId?: number) {
  await Promise.all([
    redisIncr(redisKey('cache-version', 'bank', bankId)),
    redisIncr(redisKey('cache-version', 'bank-items', bankId)),
    redisIncr(redisKey('cache-version', 'bank-practice-summary', bankId)),
    invalidateUserBankLists(userId)
  ]);
}

export const invalidateBankCaches = invalidateBankCachesForTest;

export async function invalidateQuestionCaches(questionId: number) {
  const bankRows = await sql<Array<{ bank_id: number }>>`
    SELECT bank_id FROM bank_question_links WHERE question_id = ${questionId}
    UNION
    SELECT bgl.bank_id
    FROM bank_group_links bgl
    JOIN group_question_links gql ON gql.group_id = bgl.group_id
    WHERE gql.question_id = ${questionId}
  `;
  await redisIncr(redisKey('cache-version', 'question', questionId));
  await redisDel(answerKeyCacheKey(questionId));
  await Promise.all(bankRows.map((row) => invalidateBankCaches(row.bank_id)));
}

export async function invalidatePracticeSummaryCaches(userId: number, bankId?: number | null) {
  void bankId;
  await redisIncr(redisKey('cache-version', 'practice-summary', userId));
}

export function normalizePracticeModeForTest(mode?: PracticeMode | null, sessionType?: 'practice' | 'review' | 'exam') {
  if (mode === 'wrong' || sessionType === 'review') return 'wrong' as const;
  if (mode === 'by_type') return 'by_type' as const;
  if (mode === 'exam' || sessionType === 'exam') return 'exam' as const;
  return 'all' as const;
}

export function normalizeQuestionCountForTest(value: number | undefined, allQuestions: boolean | undefined) {
  if (allQuestions) return maxPracticeQuestions;
  return Math.max(1, Math.min(Number.isFinite(value ?? NaN) ? Number(value) : 10, maxPracticeQuestions));
}

export async function loadPracticeQuestionIds(
  user: User,
  bankId: number,
  count: number,
  options: PracticeSessionOptions
) {
  const mode = normalizePracticeModeForTest(options.mode);
  const typeFilter = mode === 'by_type' ? options.questionTypeId?.trim() || null : null;

  const rows = await sql<Array<{ question_id: number }>>`
    WITH active_question_ids AS (
      SELECT bql.question_id, bql.sort_order AS bank_sort_order, NULL::integer AS group_sort_order
      FROM bank_question_links bql
      WHERE bql.bank_id = ${bankId}
        AND bql.status = 'active'

      UNION ALL

      SELECT gql.question_id, bgl.sort_order AS bank_sort_order, gql.sort_order AS group_sort_order
      FROM bank_group_links bgl
      JOIN group_question_links gql ON gql.group_id = bgl.group_id
      WHERE bgl.bank_id = ${bankId}
        AND bgl.status = 'active'
    )
    SELECT ids.question_id
    FROM active_question_ids ids
    JOIN questions q ON q.id = ids.question_id
    LEFT JOIN user_question_stats uqs
      ON uqs.question_id = ids.question_id
     AND uqs.user_id = ${user.id}
    WHERE q.status = 'active'
      AND (${typeFilter ?? null}::text IS NULL OR q.question_type_id = ${typeFilter ?? null})
      AND (
        ${mode} <> 'wrong'
        OR COALESCE(uqs.wrong_count, 0) > 0
        OR uqs.last_is_correct IS FALSE
      )
    GROUP BY ids.question_id, ids.bank_sort_order, ids.group_sort_order, uqs.wrong_count, uqs.last_is_correct
    ORDER BY
      CASE WHEN ${mode} = 'wrong' THEN COALESCE(uqs.wrong_count, 0) ELSE 0 END DESC,
      CASE WHEN ${mode} = 'exam' THEN md5(ids.question_id::text || ${user.id}::text || CURRENT_DATE::text) ELSE NULL END,
      ids.bank_sort_order,
      ids.group_sort_order NULLS FIRST,
      ids.question_id
    LIMIT ${count}
  `;
  return rows.map((row) => Number(row.question_id));
}

export async function getExistingPracticeAnswer(userId: number, sessionId: number, questionId: number) {
  const rows = await sql`
    SELECT *
    FROM user_question_answers
    WHERE user_id = ${userId}
      AND session_id = ${sessionId}
      AND question_id = ${questionId}
    ORDER BY answered_at ASC, id ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadBankQuestionIdentities(
  bankId: number,
  options: {
    status?: string | null;
    type?: string | null;
    activeOnly?: boolean;
    questionIds?: number[];
    offset?: number;
    limit?: number;
  } = {}
) {
  const questionIds = options.questionIds?.map(Number).filter(Number.isFinite) ?? [];
  const ids = sql.array(questionIds);
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  const hasQuestionFilter = questionIds.length > 0;
  const status = options.status ?? null;
  const type = options.type ?? null;
  const activeOnly = options.activeOnly ?? false;

  if (hasQuestionFilter && !type) {
    return sql<BankQuestionIdentity[]>`
      WITH requested_ids AS (
        SELECT id, ord
        FROM unnest(${ids}::bigint[]) WITH ORDINALITY AS requested(id, ord)
      ),
      matched_items AS (
        SELECT
          bql.bank_id,
          NULL::bigint AS group_id,
          bql.question_id,
          'standalone'::text AS item_scope,
          bql.sort_order AS bank_sort_order,
          NULL::integer AS group_sort_order,
          bql.question_no,
          bql.status AS bank_link_status,
          requested_ids.ord
        FROM requested_ids
        JOIN bank_question_links bql ON bql.question_id = requested_ids.id
        WHERE bql.bank_id = ${bankId}
          AND (${status}::text IS NULL OR bql.status = ${status})
          AND (${activeOnly}::boolean = false OR bql.status = 'active')

        UNION ALL

        SELECT
          bgl.bank_id,
          bgl.group_id,
          gql.question_id,
          'grouped'::text AS item_scope,
          bgl.sort_order AS bank_sort_order,
          gql.sort_order AS group_sort_order,
          gql.question_no,
          bgl.status AS bank_link_status,
          requested_ids.ord
        FROM requested_ids
        JOIN group_question_links gql ON gql.question_id = requested_ids.id
        JOIN bank_group_links bgl ON bgl.group_id = gql.group_id
        WHERE bgl.bank_id = ${bankId}
          AND (${status}::text IS NULL OR bgl.status = ${status})
          AND (${activeOnly}::boolean = false OR bgl.status = 'active')
      )
      SELECT bank_id, group_id, question_id, item_scope, bank_sort_order, group_sort_order, question_no, bank_link_status
      FROM matched_items
      ORDER BY ord
      LIMIT ${limit}
    `;
  }

  if (hasQuestionFilter) {
    return sql<BankQuestionIdentity[]>`
      WITH requested_ids AS (
        SELECT id, ord
        FROM unnest(${ids}::bigint[]) WITH ORDINALITY AS requested(id, ord)
      ),
      matched_items AS (
        SELECT
          bql.bank_id,
          NULL::bigint AS group_id,
          bql.question_id,
          'standalone'::text AS item_scope,
          bql.sort_order AS bank_sort_order,
          NULL::integer AS group_sort_order,
          bql.question_no,
          bql.status AS bank_link_status,
          requested_ids.ord
        FROM requested_ids
        JOIN bank_question_links bql ON bql.question_id = requested_ids.id
        JOIN questions q_filter ON q_filter.id = bql.question_id
        WHERE bql.bank_id = ${bankId}
          AND (${status}::text IS NULL OR bql.status = ${status})
          AND (${activeOnly}::boolean = false OR bql.status = 'active')
          AND q_filter.question_type_id = ${type}

        UNION ALL

        SELECT
          bgl.bank_id,
          bgl.group_id,
          gql.question_id,
          'grouped'::text AS item_scope,
          bgl.sort_order AS bank_sort_order,
          gql.sort_order AS group_sort_order,
          gql.question_no,
          bgl.status AS bank_link_status,
          requested_ids.ord
        FROM requested_ids
        JOIN group_question_links gql ON gql.question_id = requested_ids.id
        JOIN bank_group_links bgl ON bgl.group_id = gql.group_id
        JOIN questions q_filter ON q_filter.id = gql.question_id
        WHERE bgl.bank_id = ${bankId}
          AND (${status}::text IS NULL OR bgl.status = ${status})
          AND (${activeOnly}::boolean = false OR bgl.status = 'active')
          AND q_filter.question_type_id = ${type}
      )
      SELECT bank_id, group_id, question_id, item_scope, bank_sort_order, group_sort_order, question_no, bank_link_status
      FROM matched_items
      ORDER BY ord
      LIMIT ${limit}
    `;
  }

  if (!type) {
    return sql<BankQuestionIdentity[]>`
      WITH bank_item_ids AS (
        SELECT
          bql.bank_id,
          NULL::bigint AS group_id,
          bql.question_id,
          'standalone'::text AS item_scope,
          bql.sort_order AS bank_sort_order,
          NULL::integer AS group_sort_order,
          bql.question_no,
          bql.status AS bank_link_status
        FROM bank_question_links bql
        WHERE bql.bank_id = ${bankId}
          AND (${status}::text IS NULL OR bql.status = ${status})
          AND (${activeOnly}::boolean = false OR bql.status = 'active')

        UNION ALL

        SELECT
          bgl.bank_id,
          bgl.group_id,
          gql.question_id,
          'grouped'::text AS item_scope,
          bgl.sort_order AS bank_sort_order,
          gql.sort_order AS group_sort_order,
          gql.question_no,
          bgl.status AS bank_link_status
        FROM bank_group_links bgl
        JOIN group_question_links gql ON gql.group_id = bgl.group_id
        WHERE bgl.bank_id = ${bankId}
          AND (${status}::text IS NULL OR bgl.status = ${status})
          AND (${activeOnly}::boolean = false OR bgl.status = 'active')
      )
      SELECT bank_id, group_id, question_id, item_scope, bank_sort_order, group_sort_order, question_no, bank_link_status
      FROM bank_item_ids
      ORDER BY bank_sort_order, group_sort_order NULLS FIRST, question_id
      OFFSET ${offset}
      LIMIT ${limit}
    `;
  }

  return sql<BankQuestionIdentity[]>`
    WITH bank_item_ids AS (
      SELECT
        bql.bank_id,
        NULL::bigint AS group_id,
        bql.question_id,
        'standalone'::text AS item_scope,
        bql.sort_order AS bank_sort_order,
        NULL::integer AS group_sort_order,
        bql.question_no,
        bql.status AS bank_link_status
      FROM bank_question_links bql
      JOIN questions q_filter ON q_filter.id = bql.question_id
      WHERE bql.bank_id = ${bankId}
        AND (${status}::text IS NULL OR bql.status = ${status})
        AND (${activeOnly}::boolean = false OR bql.status = 'active')
        AND q_filter.question_type_id = ${type}

      UNION ALL

      SELECT
        bgl.bank_id,
        bgl.group_id,
        gql.question_id,
        'grouped'::text AS item_scope,
        bgl.sort_order AS bank_sort_order,
        gql.sort_order AS group_sort_order,
        gql.question_no,
        bgl.status AS bank_link_status
      FROM bank_group_links bgl
      JOIN group_question_links gql ON gql.group_id = bgl.group_id
      JOIN questions q_filter ON q_filter.id = gql.question_id
      WHERE bgl.bank_id = ${bankId}
        AND (${status}::text IS NULL OR bgl.status = ${status})
        AND (${activeOnly}::boolean = false OR bgl.status = 'active')
        AND q_filter.question_type_id = ${type}
    )
    SELECT bank_id, group_id, question_id, item_scope, bank_sort_order, group_sort_order, question_no, bank_link_status
    FROM bank_item_ids
    ORDER BY bank_sort_order, group_sort_order NULLS FIRST, question_id
    OFFSET ${offset}
    LIMIT ${limit}
  `;
}

async function loadBankQuestionDetails(identities: BankQuestionIdentity[]) {
  if (identities.length === 0) return [];

  const questionIds = [...new Set(identities.map((item) => Number(item.question_id)))];
  const groupIds = [...new Set(
    identities
      .map((item) => item.group_id == null ? null : Number(item.group_id))
      .filter((id): id is number => id !== null && Number.isFinite(id))
  )];
  const questionIdArray = sql.array(questionIds);
  const groupIdArray = sql.array(groupIds);

  const [questions, groups, options] = await Promise.all([
    sql<Array<{
      question_id: number;
      business_type: string;
      subject_id: string;
      question_type_id: string;
      answer_mode: AnswerMode;
      choice_variant: 'single' | 'multiple' | null;
      content_mode: string | null;
      stem: string;
      analysis: string | null;
      question_status: 'draft' | 'active' | 'archived';
    }>>`
      SELECT
        q.id AS question_id,
        q.business_type,
        q.subject_id,
        q.question_type_id,
        q.answer_mode,
        q.choice_variant,
        q.content_mode,
        q.stem,
        q.analysis,
        q.status AS question_status
      FROM questions q
      WHERE q.id = ANY(${questionIdArray}::bigint[])
    `,
    groupIds.length
      ? sql<Array<{ group_id: number; group_title: string | null; group_instructions: string | null }>>`
          SELECT id AS group_id, title AS group_title, instructions AS group_instructions
          FROM question_groups
          WHERE id = ANY(${groupIdArray}::bigint[])
        `
      : Promise.resolve([]),
    sql<Array<{ question_id: number; options: BankQuestionItem['options'] }>>`
      SELECT
        qo.question_id,
        json_agg(
          json_build_object(
            'id', qo.id,
            'option_label', qo.option_label,
            'content', qo.content,
            'is_correct', qo.is_correct
          )
          ORDER BY qo.sort_order
        ) AS options
      FROM question_options qo
      WHERE qo.question_id = ANY(${questionIdArray}::bigint[])
      GROUP BY qo.question_id
    `
  ]);

  const questionById = new Map(questions.map((question) => [Number(question.question_id), question]));
  const groupById = new Map(groups.map((group) => [Number(group.group_id), group]));
  const optionsByQuestionId = new Map(options.map((row) => [Number(row.question_id), row.options ?? []]));

  return identities.flatMap((identity) => {
    const question = questionById.get(Number(identity.question_id));
    if (!question) return [];
    const group = identity.group_id == null ? null : groupById.get(Number(identity.group_id));

    return [{
      ...identity,
      ...question,
      item_scope: identity.item_scope as BankQuestionItem['item_scope'],
      bank_link_status: identity.bank_link_status as BankQuestionItem['bank_link_status'],
      question_status: question.question_status,
      group_title: group?.group_title ?? null,
      group_instructions: group?.group_instructions ?? null,
      options: optionsByQuestionId.get(Number(identity.question_id)) ?? []
    } satisfies BankQuestionItem];
  });
}

export async function loadBankQuestionItems(
  bankId: number,
  options: {
    status?: string | null;
    type?: string | null;
    activeOnly?: boolean;
    questionIds?: number[];
    offset?: number;
    limit?: number;
  } = {}
) {
  const identities = await loadBankQuestionIdentities(bankId, options);
  const items = await loadBankQuestionDetails(identities);
  return options.limit ? items.slice(0, options.limit) : items;
}

export function hasNonEmptyText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function selectedAnswerValues(value: unknown) {
  return normalizeStringArray(objectValue(value, 'selected'));
}

export function hasUsableAnswerPayloadForTest(mode: AnswerMode, payload: Record<string, unknown> | undefined) {
  if (!payload) return false;
  if (mode === 'choice') return selectedAnswerValues(payload).length > 0;
  if (mode === 'true_false') return typeof payload.value === 'boolean';
  if (mode === 'fill_blank') return fillBlankValues(payload).some((value) => value.length > 0);
  return hasNonEmptyText(payload.value);
}

export function validateQuestionPayloadForTest(data: {
  answerMode: AnswerMode;
  status?: 'draft' | 'active' | 'archived';
  options?: Array<{ label: string; content: string; isCorrect?: boolean }>;
  answerPayload?: Record<string, unknown>;
}) {
  if (data.answerMode !== 'choice' && data.options?.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Options are only supported for choice questions');
  }

  if (data.answerMode === 'choice') {
    const options = data.options ?? [];
    const labels = new Set(options.map((option) => option.label.trim()).filter(Boolean));
    if (labels.size !== options.length) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Choice option labels must be unique and non-empty');
    }
    if (data.answerPayload && selectedAnswerValues(data.answerPayload).some((label) => !labels.has(label))) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Choice answer must reference existing option labels');
    }
  }

  if (data.status === 'active') {
    if (!hasUsableAnswerPayloadForTest(data.answerMode, data.answerPayload)) {
      throw new ApiError(409, 'INVALID_STATE', 'Active questions require a usable answer payload');
    }
    if (data.answerMode === 'choice') {
      const options = data.options ?? [];
      if (options.length < 2 || !options.some((option) => option.isCorrect)) {
        throw new ApiError(409, 'INVALID_STATE', 'Active choice questions require at least two options and one correct option');
      }
    }
  }
}

export function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function objectValue(value: unknown, key: string) {
  return value && typeof value === 'object' && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export function fillBlankValues(value: unknown) {
  const directValue = objectValue(value, 'value');
  if (Array.isArray(directValue)) return directValue.map(normalizeText);
  if (directValue !== undefined && directValue !== null) return [normalizeText(directValue)];

  const slots = objectValue(value, 'slots');
  if (!Array.isArray(slots)) return [];
  return slots.flatMap((slot) => {
    if (!isNonEmptyRecord(slot)) return [];
    const nestedValue = slot.value ?? slot.answers;
    const list = Array.isArray(nestedValue) ? nestedValue : [nestedValue];
    return list.map(normalizeText).filter(Boolean);
  });
}

export function normalizeStringArray(value: unknown) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.map((item) => String(item).trim()).filter(Boolean).sort();
}

export function normalizeText(value: unknown) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}
