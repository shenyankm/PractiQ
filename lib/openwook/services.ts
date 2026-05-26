import 'server-only';

import { sql } from './db';
import { ApiError } from './api';
import { errorToLog, logger } from './logger';
import { invalidateUserCache } from './auth';
import { publishImportEvent } from './import-events';
import { requireAdminRole, requireImportSourceType, requirePlusEntitlement } from './permissions';
import {
  acquireRedisLock,
  hashKey,
  redisDel,
  redisGetText,
  redisGetJson,
  redisGetOrSetJson,
  redisIncr,
  redisKey,
  redisSetJson
} from './redis';
import type {
  AnswerMode,
  BankQuestionItem,
  ImportJob,
  KnowledgePoint,
  MediaAsset,
  PracticeMode,
  PracticeAnswer,
  PracticeSession,
  PracticeSessionOptions,
  Question,
  QuestionBank,
  QuestionType,
  Subject,
  User
} from './types';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const shortCacheTtl = Number(process.env.OPENWOOK_SHORT_CACHE_TTL_SECONDS || 60);
const referenceCacheTtl = Number(process.env.OPENWOOK_REFERENCE_CACHE_TTL_SECONDS || 3600);
const practiceQueueTtl = Number(process.env.PRACTICE_QUEUE_TTL_SECONDS || 7 * 24 * 60 * 60);
const maxPracticeQuestions = Number(process.env.PRACTICE_MAX_QUESTIONS || 500);
const practiceProgressFullLimit = Number(process.env.PRACTICE_PROGRESS_FULL_LIMIT || 120);
const practiceProgressWindowRadius = Number(process.env.PRACTICE_PROGRESS_WINDOW_RADIUS || 30);

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function practiceQuestionQueueKey(sessionId: number) {
  return redisKey('practice', sessionId, 'question-ids');
}

function answerKeyCacheKey(questionId: number) {
  return redisKey('cache', 'answer-key', questionId);
}

type BankQuestionIdentity = Pick<
  BankQuestionItem,
  'bank_id' | 'group_id' | 'question_id' | 'item_scope' | 'bank_sort_order' | 'group_sort_order' | 'question_no' | 'bank_link_status'
>;

async function cacheVersion(scope: string, id?: number | string | null) {
  return await redisGetText(redisKey('cache-version', scope, id ?? 'global')) ?? '0';
}

async function invalidateUserBankLists(userId?: number) {
  await redisIncr(redisKey('cache-version', 'banks', userId ?? 'global'));
}

async function invalidateUserAnalytics(userId: number) {
  await redisIncr(redisKey('cache-version', 'analytics', userId));
}

async function invalidateBankLeaderboard(bankId: number | null | undefined) {
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

async function invalidateQuestionCaches(questionId: number) {
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

async function invalidatePracticeSummaryCaches(userId: number, bankId?: number | null) {
  void bankId;
  await redisIncr(redisKey('cache-version', 'practice-summary', userId));
}

async function importQueueHandlers() {
  return import('./import-queue');
}

async function loadPracticeQuestionIds(
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

async function getExistingPracticeAnswer(userId: number, sessionId: number, questionId: number) {
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

async function loadBankQuestionItems(
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

function hasNonEmptyText(value: unknown) {
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

export async function resolveQuestionTypeIdForSubject(
  subject: string,
  requestedTypeId: string | null | undefined,
  answerMode?: AnswerMode | null,
  preferredScope: 'question' | 'group' | 'hybrid' = 'question'
) {
  const requested = requestedTypeId?.trim() || null;
  if (requested) {
    const requestedRows = await sql<Array<{ type_id: string }>>`
      SELECT type_id
      FROM question_types
      WHERE subject_id = ${subject}
        AND type_id = ${requested}
      LIMIT 1
    `;
    if (requestedRows[0]) return requestedRows[0].type_id;
  }

  const fallbackRows = await sql<Array<{ type_id: string }>>`
    SELECT type_id
    FROM question_types
    WHERE subject_id = ${subject}
    ORDER BY
      CASE WHEN default_answer_mode = ${answerMode ?? null} THEN 0 ELSE 1 END,
      CASE WHEN default_answer_mode IS NULL THEN 0 ELSE 1 END,
      CASE WHEN scope = ${preferredScope} THEN 0 WHEN scope = 'hybrid' THEN 1 ELSE 2 END,
      type_id
    LIMIT 1
  `;
  if (fallbackRows[0]) return fallbackRows[0].type_id;

  throw new ApiError(422, 'INVALID_QUESTION_TYPE', `No compatible question type exists for subject ${subject}`);
}

async function ensureImportJobHasSourceArtifact(jobId: number) {
  const rows = await sql<Array<{ id: number }>>`
    SELECT id
    FROM question_import_job_artifacts
    WHERE job_id = ${jobId}
      AND artifact_type = 'source_file'
      AND (storage_path IS NOT NULL OR content_json IS NOT NULL)
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(409, 'SOURCE_FILE_REQUIRED', 'Import job requires an uploaded TXT or DOCX source file before parsing');
  }
}

function extractSourceTypeFromArtifact(storagePath?: string | null, content?: Record<string, unknown> | null) {
  const explicit = typeof content?.sourceType === 'string' ? content.sourceType : null;
  if (explicit) return explicit;
  const originalName = typeof content?.originalName === 'string' ? content.originalName : '';
  const pathValue = storagePath || originalName;
  if (/\.docx(?:$|[?#])/i.test(pathValue)) return 'docx';
  if (/\.txt(?:$|[?#])/i.test(pathValue)) return 'txt';
  return null;
}

export async function listSubjects() {
  return redisGetOrSetJson<Subject[]>(
    redisKey('cache', 'subjects'),
    referenceCacheTtl,
    () => sql<Subject[]>`
      SELECT subject_id, display_name
      FROM subjects
      ORDER BY display_name
    `
  );
}

export async function listQuestionTypes(subject?: string, scope?: string) {
  return redisGetOrSetJson<QuestionType[]>(
    redisKey('cache', 'question-types', hashKey({ subject: subject ?? null, scope: scope ?? null })),
    referenceCacheTtl,
    () => sql<QuestionType[]>`
      SELECT type_id, subject_id, display_name, scope, default_answer_mode
      FROM question_types
      WHERE (${subject ?? null}::text IS NULL OR subject_id = ${subject ?? null})
        AND (${scope ?? null}::text IS NULL OR scope = ${scope ?? null})
      ORDER BY subject_id, display_name
    `
  );
}

export async function listKnowledgePoints(subject?: string, parentId?: number) {
  const version = await cacheVersion('knowledge-points');
  return redisGetOrSetJson(
    redisKey('cache', 'knowledge-points', version, hashKey({ subject: subject ?? null, parentId: parentId ?? null })),
    referenceCacheTtl,
    () => sql`
      SELECT id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at
      FROM knowledge_points
      WHERE (${subject ?? null}::text IS NULL OR subject_id = ${subject ?? null})
        AND (
          ${parentId ?? null}::bigint IS NULL AND parent_id IS NULL
          OR parent_id = ${parentId ?? null}
        )
      ORDER BY display_name
    `
  );
}

export async function getAdminOverview(user: User) {
  requireAdminRole(user);

  const rows = await sql<Array<{
    total_users: number;
    active_users: number;
    admin_users: number;
    plus_users: number;
    total_banks: number;
    total_questions: number;
    import_jobs: number;
    open_review_items: number;
    knowledge_points: number;
  }>>`
    SELECT
      (SELECT COUNT(*)::int FROM users) AS total_users,
      (SELECT COUNT(*)::int FROM users WHERE is_active = true) AS active_users,
      (SELECT COUNT(*)::int FROM users WHERE role = 'admin') AS admin_users,
      (SELECT COUNT(*)::int FROM users WHERE membership = 'plus') AS plus_users,
      (SELECT COUNT(*)::int FROM question_banks) AS total_banks,
      (SELECT COUNT(*)::int FROM questions) AS total_questions,
      (SELECT COUNT(*)::int FROM question_import_jobs) AS import_jobs,
      (SELECT COUNT(*)::int FROM question_import_job_review_items WHERE status = 'open') AS open_review_items,
      (SELECT COUNT(*)::int FROM knowledge_points) AS knowledge_points
  `;

  return rows[0];
}

export async function listAdminUsers(user: User, params?: URLSearchParams) {
  requireAdminRole(user);
  const q = params?.get('q')?.trim() || null;
  const status = params?.get('status') || 'all';
  const role = params?.get('role') || 'all';

  return sql<Array<User & {
    bank_count: number;
    import_job_count: number;
    practice_session_count: number;
  }>>`
    SELECT
      u.id, u.username, u.email, u.avatar_url, u.is_active, u.role, u.membership,
      u.plus_trial_ends_at, u.plus_expires_at, u.created_at, u.updated_at,
      COALESCE(bank_counts.bank_count, 0)::int AS bank_count,
      COALESCE(import_counts.import_job_count, 0)::int AS import_job_count,
      COALESCE(session_counts.practice_session_count, 0)::int AS practice_session_count
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*)::int AS bank_count
      FROM user_bank_links
      WHERE is_owner = true
      GROUP BY user_id
    ) bank_counts ON bank_counts.user_id = u.id
    LEFT JOIN (
      SELECT created_by, COUNT(*)::int AS import_job_count
      FROM question_import_jobs
      GROUP BY created_by
    ) import_counts ON import_counts.created_by = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*)::int AS practice_session_count
      FROM user_practice_sessions
      GROUP BY user_id
    ) session_counts ON session_counts.user_id = u.id
    WHERE
      (${q}::text IS NULL OR u.username ILIKE ${q ? `%${q}%` : null} OR u.email ILIKE ${q ? `%${q}%` : null})
      AND (${status} = 'all' OR (${status} = 'active' AND u.is_active = true) OR (${status} = 'inactive' AND u.is_active = false))
      AND (${role} = 'all' OR u.role = ${role})
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT 100
  `;
}

export async function listAdminKnowledgePoints(user: User, params?: URLSearchParams) {
  requireAdminRole(user);
  const subject = params?.get('subject') || null;
  const q = params?.get('q')?.trim() || null;

  return sql<KnowledgePoint[]>`
    SELECT id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at
    FROM knowledge_points
    WHERE
      (${subject}::text IS NULL OR subject_id = ${subject})
      AND (${q}::text IS NULL OR code ILIKE ${q ? `%${q}%` : null} OR display_name ILIKE ${q ? `%${q}%` : null})
    ORDER BY subject_id, code
    LIMIT 200
  `;
}

export async function createKnowledgePoint(
  user: User,
  data: { subjectId: string; code: string; displayName: string; parentId?: number | null; metadata?: Record<string, unknown> }
) {
  await requireAdmin(user);
  const rows = await sql`
    INSERT INTO knowledge_points (subject_id, code, display_name, parent_id, metadata_json)
    VALUES (${data.subjectId}, ${data.code}, ${data.displayName}, ${data.parentId ?? null}, ${JSON.stringify(data.metadata ?? {})})
    RETURNING *
  `;
  await redisIncr(redisKey('cache-version', 'knowledge-points'));
  return rows[0];
}

export async function updateKnowledgePoint(
  user: User,
  id: number,
  data: { code?: string; displayName?: string; parentId?: number | null; metadata?: Record<string, unknown> }
) {
  await requireAdmin(user);
  const rows = await sql`
    UPDATE knowledge_points
    SET
      code = COALESCE(${data.code ?? null}, code),
      display_name = COALESCE(${data.displayName ?? null}, display_name),
      parent_id = COALESCE(${data.parentId ?? null}, parent_id),
      metadata_json = COALESCE(${data.metadata ? JSON.stringify(data.metadata) : null}, metadata_json)
    WHERE id = ${id}
    RETURNING *
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Knowledge point not found');
  await redisIncr(redisKey('cache-version', 'knowledge-points'));
  return rows[0];
}

function requireAdmin(user: User) {
  requireAdminRole(user);
}

export async function listBanks(user: User, params: URLSearchParams) {
  const scope = params.get('scope') || 'mine';
  const subject = params.get('subject');
  const q = params.get('q');
  const limit = Math.min(Number(params.get('limit') || 30), 100);
  const version = await cacheVersion('banks', user.id);
  const globalVersion = await cacheVersion('banks', 'global');

  return redisGetOrSetJson<QuestionBank[]>(
    redisKey('cache', 'banks', user.id, version, globalVersion, hashKey({ scope, subject, q, limit })),
    shortCacheTtl,
    () => sql<QuestionBank[]>`
      SELECT
        b.*,
        COALESCE(ubl.is_owner, false) AS is_owner,
        COALESCE(ubl.is_favorite, false) AS is_favorite
      FROM question_banks b
      LEFT JOIN user_bank_links ubl
        ON ubl.bank_id = b.id
       AND ubl.user_id = ${user.id}
      WHERE
        (
          ${scope} = 'public' AND b.is_public = true
          OR ${scope} = 'favorites' AND ubl.is_favorite = true
          OR ${scope} = 'mine' AND COALESCE(ubl.is_owner, false) = true
          OR ${scope} = 'all' AND (b.is_public = true OR ubl.id IS NOT NULL)
        )
        AND (${subject ?? null}::text IS NULL OR b.subject = ${subject ?? null})
        AND (${q ?? null}::text IS NULL OR b.name ILIKE ${q ? `%${q}%` : null})
      ORDER BY b.updated_at DESC, b.id DESC
      LIMIT ${limit}
    `
  );
}

export async function getBank(user: User, bankId: number) {
  const version = await cacheVersion('bank', bankId);
  const bank = await redisGetOrSetJson<QuestionBank | null>(
    redisKey('cache', 'bank', bankId, 'user', user.id, version),
    shortCacheTtl,
    async () => {
      const rows = await sql<QuestionBank[]>`
        SELECT
          b.*,
          COALESCE(ubl.is_owner, false) AS is_owner,
          COALESCE(ubl.is_favorite, false) AS is_favorite
        FROM question_banks b
        LEFT JOIN user_bank_links ubl
          ON ubl.bank_id = b.id
         AND ubl.user_id = ${user.id}
        WHERE b.id = ${bankId}
          AND (b.is_public = true OR ubl.id IS NOT NULL)
        LIMIT 1
      `;
      return rows[0] ?? null;
    }
  );
  if (!bank) throw new ApiError(404, 'NOT_FOUND', 'Question bank not found');
  return bank;
}

export async function requireBankOwner(user: User, bankId: number) {
  const rows = await sql<Array<{ id: number; subject: string }>>`
    SELECT b.id, b.subject
    FROM question_banks b
    JOIN user_bank_links ubl ON ubl.bank_id = b.id
    WHERE b.id = ${bankId}
      AND ubl.user_id = ${user.id}
      AND ubl.is_owner = true
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(403, 'FORBIDDEN', 'Bank owner access required');
  return rows[0];
}

export async function createBank(
  user: User,
  data: { name: string; description?: string | null; subject: string; isPublic?: boolean }
) {
  const rows = await sql.begin(async (tx) => {
    const created = await tx<QuestionBank[]>`
      INSERT INTO question_banks (name, description, subject, created_by, is_public)
      VALUES (${data.name}, ${data.description ?? null}, ${data.subject}, ${user.id}, ${data.isPublic ?? false})
      RETURNING *
    `;
    await tx`
      INSERT INTO user_bank_links (user_id, bank_id, is_owner)
      VALUES (${user.id}, ${created[0].id}, true)
    `;
    return created;
  });
  await invalidateBankCaches(rows[0].id, user.id);
  await invalidateUserAnalytics(user.id);
  return rows[0];
}

export async function updateBank(
  user: User,
  bankId: number,
  data: { name?: string; description?: string | null; isPublic?: boolean }
) {
  await requireBankOwner(user, bankId);
  const rows = await sql<QuestionBank[]>`
    UPDATE question_banks
    SET
      name = COALESCE(${data.name ?? null}, name),
      description = COALESCE(${data.description ?? null}, description),
      is_public = COALESCE(${data.isPublic ?? null}, is_public)
    WHERE id = ${bankId}
    RETURNING *
  `;
  await invalidateBankCaches(bankId, user.id);
  return rows[0];
}

export async function deleteBank(user: User, bankId: number) {
  await requireBankOwner(user, bankId);
  await sql`DELETE FROM question_banks WHERE id = ${bankId}`;
  await invalidateBankCaches(bankId, user.id);
  await invalidateUserAnalytics(user.id);
}

export async function setFavorite(user: User, bankId: number, favorite: boolean) {
  await getBank(user, bankId);
  if (favorite) {
    await sql`
      INSERT INTO user_bank_links (user_id, bank_id, is_favorite)
      VALUES (${user.id}, ${bankId}, true)
      ON CONFLICT (user_id, bank_id)
      DO UPDATE SET is_favorite = true
    `;
  } else {
    await sql`
      DELETE FROM user_bank_links
      WHERE user_id = ${user.id}
        AND bank_id = ${bankId}
        AND is_owner = false
    `;
    await sql`
      UPDATE user_bank_links
      SET is_favorite = false
      WHERE user_id = ${user.id}
        AND bank_id = ${bankId}
        AND is_owner = true
    `;
  }
  await invalidateBankCaches(bankId, user.id);
  await invalidateUserAnalytics(user.id);
}

export async function listBankItems(user: User, bankId: number, params: URLSearchParams) {
  await getBank(user, bankId);
  return listBankItemsForBank(user, bankId, params);
}

export async function getBankWithItems(user: User, bankId: number, params: URLSearchParams) {
  const bank = await getBank(user, bankId);
  const items = await listBankItemsForBank(user, bankId, params);

  return { bank, items };
}

async function listBankItemsForBank(user: User, bankId: number, params: URLSearchParams) {
  const status = params.get('status');
  const type = params.get('type');
  const limit = Math.min(Number(params.get('limit') || 50), 100);
  const version = await cacheVersion('bank-items', bankId);
  return redisGetOrSetJson<BankQuestionItem[]>(
    redisKey('cache', 'bank-items', bankId, 'user', user.id, version, hashKey({ status, type, limit })),
    shortCacheTtl,
    () => loadBankQuestionItems(bankId, { status, type, limit })
  );
}

function countMapFromDb(value: unknown) {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, count]) => [key, Number(count) || 0])
  );
}

export async function getBankPracticeSummary(user: User, bankId: number) {
  const bank = await getBank(user, bankId);
  const bankVersion = await cacheVersion('bank-practice-summary', bankId);
  const userPracticeVersion = await cacheVersion('practice-summary', user.id);
  const summary = await redisGetOrSetJson<{
    activeCount: number;
    wrongCount: number;
    typeCounts: Record<string, number>;
    modeCounts: Record<string, number>;
  }>(
    redisKey('cache', 'bank-practice-summary', bankId, 'user', user.id, bankVersion, userPracticeVersion),
    shortCacheTtl,
    async () => {
      const rows = await sql<Array<{
        active_count: number;
        wrong_count: number;
        type_counts: unknown;
        mode_counts: unknown;
      }>>`
        WITH active_questions AS (
          SELECT
            q.id AS question_id,
            q.question_type_id,
            q.answer_mode
          FROM bank_question_links bql
          JOIN questions q ON q.id = bql.question_id
          WHERE bql.bank_id = ${bankId}
            AND bql.status = 'active'
            AND q.status = 'active'

          UNION

          SELECT
            q.id AS question_id,
            q.question_type_id,
            q.answer_mode
          FROM bank_group_links bgl
          JOIN group_question_links gql ON gql.group_id = bgl.group_id
          JOIN questions q ON q.id = gql.question_id
          WHERE bgl.bank_id = ${bankId}
            AND bgl.status = 'active'
            AND q.status = 'active'
        )
        SELECT
          (SELECT COUNT(*)::int FROM active_questions) AS active_count,
          COALESCE(
            (
              SELECT jsonb_object_agg(question_type_id, total)
              FROM (
                SELECT question_type_id, COUNT(*)::int AS total
                FROM active_questions
                GROUP BY question_type_id
              ) type_counts
            ),
            '{}'::jsonb
          ) AS type_counts,
          COALESCE(
            (
              SELECT jsonb_object_agg(answer_mode, total)
              FROM (
                SELECT answer_mode, COUNT(*)::int AS total
                FROM active_questions
                GROUP BY answer_mode
              ) mode_counts
            ),
            '{}'::jsonb
          ) AS mode_counts,
          (
            SELECT COUNT(*)::int
            FROM active_questions aq
            JOIN user_question_stats uqs
              ON uqs.question_id = aq.question_id
             AND uqs.user_id = ${user.id}
            WHERE uqs.wrong_count > 0 OR uqs.last_is_correct IS FALSE
          ) AS wrong_count
      `;
      const row = rows[0];
      return {
        activeCount: row?.active_count ?? 0,
        wrongCount: row?.wrong_count ?? 0,
        typeCounts: countMapFromDb(row?.type_counts),
        modeCounts: countMapFromDb(row?.mode_counts)
      };
    }
  );

  return { bank, ...summary };
}

export async function createGroup(
  user: User,
  bankId: number,
  data: { title: string; instructions?: string | null; groupTypeId?: string | null; contentMode?: string | null; status?: 'draft' | 'active' | 'archived' }
) {
  const bank = await requireBankOwner(user, bankId);
  const groupTypeId = await resolveQuestionTypeIdForSubject(bank.subject, data.groupTypeId ?? null, null, 'group');
  const group = await sql.begin(async (tx) => {
    await tx`SELECT id FROM question_banks WHERE id = ${bankId} FOR UPDATE`;
    const maxRows = await tx<Array<{ next_sort: number }>>`
      SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
      FROM bank_group_links
      WHERE bank_id = ${bankId}
    `;
    const created = await tx`
      INSERT INTO question_groups (
        subject_id, group_type_id, title, instructions, content_mode, imported_by
      )
      VALUES (
        ${bank.subject}, ${groupTypeId}, ${data.title}, ${data.instructions ?? null},
        ${data.contentMode ?? 'text_only'}, ${user.id}
      )
      RETURNING *
    `;
    await tx`
      INSERT INTO bank_group_links (bank_id, group_id, sort_order, status, added_by)
      VALUES (${bankId}, ${created[0].id}, ${maxRows[0].next_sort}, ${data.status ?? 'draft'}, ${user.id})
    `;
    return created[0];
  });
  await invalidateBankCaches(bankId, user.id);
  return group;
}

export async function getGroup(user: User, groupId: number) {
  const rows = await sql`
    SELECT
      g.*,
      COALESCE(
        (
          SELECT json_agg(q.* ORDER BY gql.sort_order)
          FROM group_question_links gql
          JOIN questions q ON q.id = gql.question_id
          WHERE gql.group_id = g.id
        ),
        '[]'
      ) AS questions
    FROM question_groups g
    WHERE g.id = ${groupId}
      AND EXISTS (
        SELECT 1
        FROM bank_group_links bgl
        JOIN question_banks b ON b.id = bgl.bank_id
        LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = ${user.id}
        WHERE bgl.group_id = g.id
          AND (b.is_public = true OR ubl.id IS NOT NULL)
      )
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Group not found');
  return rows[0];
}

export async function updateGroup(
  user: User,
  groupId: number,
  data: { title?: string | null; instructions?: string | null; contentMode?: string | null }
) {
  await ensureGroupEditable(user, groupId);
  const rows = await sql`
    UPDATE question_groups
    SET
      title = COALESCE(${data.title ?? null}, title),
      instructions = COALESCE(${data.instructions ?? null}, instructions),
      content_mode = COALESCE(${data.contentMode ?? null}, content_mode)
    WHERE id = ${groupId}
    RETURNING *
  `;
  return rows[0];
}

export async function addQuestionToGroup(user: User, groupId: number, questionId: number, sortOrder?: number) {
  await ensureGroupEditable(user, groupId);
  await ensureQuestionEditable(user, questionId);
  const sortRows = await sql<Array<{ next_sort: number }>>`
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
    FROM group_question_links
    WHERE group_id = ${groupId}
  `;
  const rows = await sql`
    INSERT INTO group_question_links (group_id, question_id, sort_order)
    VALUES (${groupId}, ${questionId}, ${sortOrder ?? sortRows[0].next_sort})
    RETURNING *
  `;
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

export async function reorderGroupQuestions(user: User, groupId: number, items: Array<{ questionId: number; sortOrder: number }>) {
  await ensureGroupEditable(user, groupId);
  await sql.begin(async (tx) => {
    const offsetRows = await tx<Array<{ offset_value: number }>>`
      SELECT COALESCE(MAX(sort_order), 0) + 1000 AS offset_value
      FROM group_question_links
      WHERE group_id = ${groupId}
    `;
    await tx`UPDATE group_question_links SET sort_order = sort_order + ${offsetRows[0].offset_value} WHERE group_id = ${groupId}`;
    for (const item of items) {
      await tx`
        UPDATE group_question_links
        SET sort_order = ${item.sortOrder}
        WHERE group_id = ${groupId} AND question_id = ${item.questionId}
      `;
    }
  });
  await Promise.all(items.map((item) => invalidateQuestionCaches(item.questionId)));
}

export async function removeQuestionFromGroup(user: User, groupId: number, questionId: number) {
  await ensureGroupEditable(user, groupId);
  await sql`
    DELETE FROM group_question_links
    WHERE group_id = ${groupId} AND question_id = ${questionId}
  `;
  await invalidateQuestionCaches(questionId);
}

export async function ensureGroupEditable(user: User, groupId: number) {
  const rows = await sql<Array<{ id: number }>>`
    SELECT g.id
    FROM question_groups g
    JOIN bank_group_links bgl ON bgl.group_id = g.id
    JOIN user_bank_links ubl ON ubl.bank_id = bgl.bank_id
    WHERE g.id = ${groupId}
      AND ubl.user_id = ${user.id}
      AND ubl.is_owner = true
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(403, 'FORBIDDEN', 'Group editor access required');
}

export async function getQuestion(user: User, questionId: number) {
  const version = await cacheVersion('question', questionId);
  const question = await redisGetOrSetJson<
    (Question & { options: unknown; answer_keys: unknown; content_blocks: unknown; media_links: unknown }) | null
  >(
    redisKey('cache', 'question', questionId, 'user', user.id, version),
    shortCacheTtl,
    async () => {
      const rows = await sql<Array<Question & { options: unknown; answer_keys: unknown; content_blocks: unknown; media_links: unknown }>>`
        SELECT
          q.*,
          COALESCE(
            (
              SELECT json_agg(qo.* ORDER BY qo.sort_order)
              FROM question_options qo
              WHERE qo.question_id = q.id
            ),
            '[]'
          ) AS options,
          COALESCE(
            (
              SELECT json_agg(qak.* ORDER BY qak.version)
              FROM question_answer_keys qak
              WHERE qak.question_id = q.id
            ),
            '[]'
          ) AS answer_keys,
          COALESCE(
            (
              SELECT json_agg(qcb.* ORDER BY qcb.sequence)
              FROM question_content_blocks qcb
              WHERE qcb.question_id = q.id
            ),
            '[]'
          ) AS content_blocks,
          COALESCE(
            (
              SELECT json_agg(qml.* ORDER BY qml.sort_order)
              FROM question_media_links qml
              WHERE qml.question_id = q.id
            ),
            '[]'
          ) AS media_links
        FROM questions q
        WHERE q.id = ${questionId}
          AND EXISTS (
            SELECT 1
            FROM bank_question_links bql
            JOIN question_banks b ON b.id = bql.bank_id
            LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = ${user.id}
            WHERE bql.question_id = q.id
              AND (b.is_public = true OR ubl.id IS NOT NULL)
          )
        LIMIT 1
      `;
      return rows[0] ?? null;
    }
  );
  if (!question) throw new ApiError(404, 'NOT_FOUND', 'Question not found');
  return question;
}

export async function createQuestion(
  user: User,
  bankId: number,
  data: {
    questionTypeId: string;
    answerMode: AnswerMode;
    stem: string;
    analysis?: string | null;
    choiceVariant?: 'single' | 'multiple' | null;
    status?: 'draft' | 'active' | 'archived';
    options?: Array<{ label: string; content: string; isCorrect?: boolean }>;
    answerPayload?: Record<string, unknown>;
  },
  options?: { invalidateCaches?: boolean; resolveQuestionType?: boolean }
) {
  const bank = await requireBankOwner(user, bankId);
  validateQuestionPayloadForTest(data);
  const questionTypeId = options?.resolveQuestionType === false
    ? data.questionTypeId
    : await resolveQuestionTypeIdForSubject(bank.subject, data.questionTypeId, data.answerMode);
  const question = await sql.begin(async (tx) => {
    await tx`SELECT id FROM question_banks WHERE id = ${bankId} FOR UPDATE`;
    const maxRows = await tx<Array<{ next_sort: number }>>`
      SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
      FROM bank_question_links
      WHERE bank_id = ${bankId}
    `;
    const created = await tx<Question[]>`
      INSERT INTO questions (
        subject_id, question_type_id, answer_mode, choice_variant, stem,
        analysis, status, source_type, imported_by
      )
      VALUES (
        ${bank.subject}, ${questionTypeId}, ${data.answerMode},
        ${data.choiceVariant ?? null}, ${data.stem}, ${data.analysis ?? null},
        ${data.status ?? 'draft'}, 'manual', ${user.id}
      )
      RETURNING *
    `;
    const question = created[0];

    await tx`
      INSERT INTO question_answer_keys (question_id, answer_mode, answer_payload)
      VALUES (${question.id}, ${data.answerMode}, ${JSON.stringify(data.answerPayload ?? {})})
    `;

    if (data.answerMode === 'choice') {
      await tx`INSERT INTO question_choice_details (question_id, selection_mode) VALUES (${question.id}, ${data.choiceVariant ?? 'single'})`;
      for (const [index, option] of (data.options ?? []).entries()) {
        await tx`
          INSERT INTO question_options (question_id, option_label, sort_order, content, is_correct)
          VALUES (${question.id}, ${option.label}, ${index + 1}, ${option.content}, ${option.isCorrect ?? false})
        `;
      }
    } else if (data.answerMode === 'true_false') {
      const answer = typeof data.answerPayload?.value === 'boolean' ? data.answerPayload.value : null;
      await tx`INSERT INTO question_true_false_details (question_id, correct_answer) VALUES (${question.id}, ${answer})`;
    } else if (data.answerMode === 'fill_blank') {
      await tx`INSERT INTO question_fill_blank_details (question_id, correct_answer) VALUES (${question.id}, ${JSON.stringify(data.answerPayload ?? {})})`;
    } else {
      const answer = typeof data.answerPayload?.value === 'string' ? data.answerPayload.value : null;
      await tx`INSERT INTO question_short_answer_details (question_id, correct_answer) VALUES (${question.id}, ${answer})`;
    }

    await tx`
      INSERT INTO bank_question_links (bank_id, question_id, sort_order, status, added_by)
      VALUES (${bankId}, ${question.id}, ${maxRows[0].next_sort}, ${data.status ?? 'draft'}, ${user.id})
    `;
    await tx`
      UPDATE question_banks
      SET total_count = total_count + 1
      WHERE id = ${bankId}
    `;
    return question;
  });
  if (options?.invalidateCaches !== false) await invalidateBankCaches(bankId, user.id);
  return question;
}

export async function updateQuestion(
  user: User,
  questionId: number,
  data: { stem?: string; analysis?: string | null; status?: string }
) {
  await ensureQuestionEditable(user, questionId);
  const status = normalizeQuestionStatus(data.status);
  if (status === 'active') await assertQuestionPublishable(user, questionId);
  const rows = await sql.begin(async (tx) => {
    const updated = await tx<Question[]>`
      UPDATE questions
      SET
        stem = COALESCE(${data.stem ?? null}, stem),
        analysis = COALESCE(${data.analysis ?? null}, analysis),
        status = COALESCE(${status ?? null}, status)
      WHERE id = ${questionId}
      RETURNING *
    `;
    if (status) {
      await tx`
        UPDATE bank_question_links
        SET status = ${status}
        WHERE question_id = ${questionId}
      `;
    }
    return updated;
  });
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

function normalizeQuestionStatus(status?: string | null) {
  if (!status) return null;
  if (status === 'draft' || status === 'active' || status === 'archived') return status;
  throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid question status');
}

export async function deleteQuestion(user: User, questionId: number) {
  await ensureQuestionEditable(user, questionId);
  const banks = await sql.begin(async (tx) => {
    const banks = await tx<Array<{ bank_id: number }>>`
      SELECT bank_id
      FROM bank_question_links
      WHERE question_id = ${questionId}
    `;
    await tx`DELETE FROM questions WHERE id = ${questionId}`;
    for (const bank of banks) {
      await tx`
        UPDATE question_banks
        SET total_count = GREATEST(total_count - 1, 0)
        WHERE id = ${bank.bank_id}
      `;
    }
    return banks;
  });
  await Promise.all(banks.map((bank) => invalidateBankCaches(bank.bank_id, user.id)));
  await redisIncr(redisKey('cache-version', 'question', questionId));
}

export async function setQuestionStatus(user: User, questionId: number, status: 'draft' | 'active' | 'archived') {
  if (status === 'active') await assertQuestionPublishable(user, questionId);
  await ensureQuestionEditable(user, questionId);
  const rows = await sql.begin(async (tx) => {
    const updated = await tx<Question[]>`
      UPDATE questions
      SET status = ${status}
      WHERE id = ${questionId}
      RETURNING *
    `;
    await tx`
      UPDATE bank_question_links
      SET status = ${status}
      WHERE question_id = ${questionId}
    `;
    return updated;
  });
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

async function assertQuestionPublishable(user: User, questionId: number) {
  await ensureQuestionEditable(user, questionId);
  const rows = await sql<Array<{ answer_mode: AnswerMode; option_count: number; correct_option_count: number; answer_key_count: number; answer_payload: string | null }>>`
    SELECT
      q.answer_mode,
      (SELECT COUNT(*)::int FROM question_options qo WHERE qo.question_id = q.id) AS option_count,
      (SELECT COUNT(*)::int FROM question_options qo WHERE qo.question_id = q.id AND qo.is_correct = true) AS correct_option_count,
      (SELECT COUNT(*)::int FROM question_answer_keys qak WHERE qak.question_id = q.id AND qak.is_primary = true) AS answer_key_count,
      (SELECT qak.answer_payload FROM question_answer_keys qak WHERE qak.question_id = q.id AND qak.is_primary = true LIMIT 1) AS answer_payload
    FROM questions q
    WHERE q.id = ${questionId}
    LIMIT 1
  `;
  const question = rows[0];
  if (!question || question.answer_key_count < 1) {
    throw new ApiError(409, 'INVALID_STATE', 'Question requires a primary answer key before publishing');
  }
  if (question.answer_mode === 'choice' && (question.option_count < 2 || question.correct_option_count < 1)) {
    throw new ApiError(409, 'INVALID_STATE', 'Choice question requires at least two options and one correct option');
  }
  if (!hasUsableAnswerPayloadForTest(question.answer_mode, parseJson(question.answer_payload ?? '{}') as Record<string, unknown> | undefined)) {
    throw new ApiError(409, 'INVALID_STATE', 'Question requires a usable primary answer payload before publishing');
  }
}

export async function upsertAnswerKey(
  user: User,
  questionId: number,
  data: {
    answerMode: AnswerMode;
    answerPayload: Record<string, unknown>;
    explanationPayload?: Record<string, unknown>;
    scorePayload?: Record<string, unknown>;
  }
) {
  await ensureQuestionEditable(user, questionId);
  const rows = await sql`
    INSERT INTO question_answer_keys (
      question_id, answer_mode, version, is_primary, answer_payload, explanation_payload, score_payload
    )
    VALUES (
      ${questionId}, ${data.answerMode}, 1, true, ${JSON.stringify(data.answerPayload)},
      ${JSON.stringify(data.explanationPayload ?? {})}, ${JSON.stringify(data.scorePayload ?? {})}
    )
    ON CONFLICT (question_id) WHERE is_primary
    DO UPDATE SET
      answer_mode = EXCLUDED.answer_mode,
      answer_payload = EXCLUDED.answer_payload,
      explanation_payload = EXCLUDED.explanation_payload,
      score_payload = EXCLUDED.score_payload
    RETURNING *
  `;
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

export async function createOption(
  user: User,
  questionId: number,
  data: { label: string; content: string; isCorrect?: boolean; sortOrder?: number }
) {
  await ensureQuestionEditable(user, questionId);
  const sortRows = await sql<Array<{ next_sort: number }>>`
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
    FROM question_options
    WHERE question_id = ${questionId}
  `;
  const rows = await sql`
    INSERT INTO question_options (question_id, option_label, sort_order, content, is_correct)
    VALUES (${questionId}, ${data.label}, ${data.sortOrder ?? sortRows[0].next_sort}, ${data.content}, ${data.isCorrect ?? false})
    RETURNING *
  `;
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

export async function updateOption(
  user: User,
  questionId: number,
  optionId: number,
  data: { label?: string; content?: string; isCorrect?: boolean; sortOrder?: number }
) {
  await ensureQuestionEditable(user, questionId);
  const rows = await sql`
    UPDATE question_options
    SET
      option_label = COALESCE(${data.label ?? null}, option_label),
      content = COALESCE(${data.content ?? null}, content),
      is_correct = COALESCE(${data.isCorrect ?? null}, is_correct),
      sort_order = COALESCE(${data.sortOrder ?? null}, sort_order)
    WHERE id = ${optionId}
      AND question_id = ${questionId}
    RETURNING *
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Option not found');
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

export async function upsertQuestionMetadata(
  user: User,
  questionId: number,
  data: {
    difficultyLevel?: string | null;
    difficultyScore?: number | null;
    gradeLevel?: string | null;
    examType?: string | null;
    curriculumStandard?: string | null;
    textbookVersion?: string | null;
    knowledgeTags?: string[];
    skillTags?: string[];
    metadata?: Record<string, unknown>;
  }
) {
  await ensureQuestionEditable(user, questionId);
  const rows = await sql`
    INSERT INTO question_educational_metadata (
      question_id, difficulty_level, difficulty_score, grade_level, exam_type,
      curriculum_standard, textbook_version, knowledge_tags_json, skill_tags_json, metadata_json
    )
    VALUES (
      ${questionId}, ${data.difficultyLevel ?? null}, ${data.difficultyScore ?? null}, ${data.gradeLevel ?? null},
      ${data.examType ?? null}, ${data.curriculumStandard ?? null}, ${data.textbookVersion ?? null},
      ${JSON.stringify(data.knowledgeTags ?? [])}, ${JSON.stringify(data.skillTags ?? [])}, ${JSON.stringify(data.metadata ?? {})}
    )
    ON CONFLICT (question_id)
    DO UPDATE SET
      difficulty_level = EXCLUDED.difficulty_level,
      difficulty_score = EXCLUDED.difficulty_score,
      grade_level = EXCLUDED.grade_level,
      exam_type = EXCLUDED.exam_type,
      curriculum_standard = EXCLUDED.curriculum_standard,
      textbook_version = EXCLUDED.textbook_version,
      knowledge_tags_json = EXCLUDED.knowledge_tags_json,
      skill_tags_json = EXCLUDED.skill_tags_json,
      metadata_json = EXCLUDED.metadata_json
    RETURNING *
  `;
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

export async function replaceQuestionKnowledgePoints(user: User, questionId: number, knowledgePointIds: number[]) {
  await ensureQuestionEditable(user, questionId);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM question_knowledge_point_links WHERE question_id = ${questionId}`;
    for (const knowledgePointId of knowledgePointIds) {
      await tx`
        INSERT INTO question_knowledge_point_links (question_id, knowledge_point_id, source_type)
        VALUES (${questionId}, ${knowledgePointId}, 'manual')
      `;
    }
  });
  await invalidateQuestionCaches(questionId);
}

export async function replaceQuestionContentBlocks(
  user: User,
  questionId: number,
  blocks: Array<{
    ownerKind?: string;
    role?: string | null;
    partType: string;
    sequence?: number;
    contentMode?: string | null;
    textFormat?: string | null;
    textValue?: string | null;
    latexValue?: string | null;
    mathmlValue?: string | null;
    htmlValue?: string | null;
    markdownValue?: string | null;
    jsonValue?: Record<string, unknown> | string | null;
    mediaId?: number | null;
  }>
) {
  await ensureQuestionEditable(user, questionId);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM question_content_blocks WHERE question_id = ${questionId}`;
    for (const [index, block] of blocks.entries()) {
      await tx`
        INSERT INTO question_content_blocks (
          question_id, owner_kind, role, part_type, sequence, content_mode, text_format,
          text_value, latex_value, mathml_value, html_value, markdown_value, json_value, media_id
        )
        VALUES (
          ${questionId}, ${block.ownerKind ?? 'question'}, ${block.role ?? null}, ${block.partType}, ${block.sequence ?? index + 1},
          ${block.contentMode ?? null}, ${block.textFormat ?? null}, ${block.textValue ?? null}, ${block.latexValue ?? null},
          ${block.mathmlValue ?? null}, ${block.htmlValue ?? null}, ${block.markdownValue ?? null},
          ${typeof block.jsonValue === 'string' ? block.jsonValue : block.jsonValue ? JSON.stringify(block.jsonValue) : null},
          ${block.mediaId ?? null}
        )
      `;
    }
  });
  await invalidateQuestionCaches(questionId);
}

export async function ensureQuestionEditable(user: User, questionId: number) {
  const rows = await sql<Array<{ id: number }>>`
    SELECT q.id
    FROM questions q
    JOIN bank_question_links bql ON bql.question_id = q.id
    JOIN user_bank_links ubl ON ubl.bank_id = bql.bank_id
    WHERE q.id = ${questionId}
      AND ubl.user_id = ${user.id}
      AND ubl.is_owner = true
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(403, 'FORBIDDEN', 'Question editor access required');
}

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
      Number(process.env.ANSWER_KEY_CACHE_TTL_SECONDS || 300),
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
    await invalidateBankLeaderboard(session.bank_id);
    await invalidatePracticeSummaryCaches(user.id, session.bank_id);
    return rows[0];
  } finally {
    await lock.release();
  }
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown, key: string) {
  return value && typeof value === 'object' && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function fillBlankValues(value: unknown) {
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

export function validateSubmittedAnswerForTest(mode: AnswerMode, actual: Record<string, unknown>) {
  if (mode === 'choice' && selectedAnswerValues(actual).length < 1) {
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

function normalizeStringArray(value: unknown) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.map((item) => String(item).trim()).filter(Boolean).sort();
}

function normalizeText(value: unknown) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
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

export async function listImportJobs(user: User, params: URLSearchParams) {
  const status = params.get('status');
  return sql<ImportJob[]>`
    SELECT *
    FROM question_import_jobs
    WHERE created_by = ${user.id}
      AND (${status ?? null}::text IS NULL OR status = ANY(string_to_array(${status ?? null}, ',')))
    ORDER BY created_at DESC
    LIMIT 50
  `;
}

export async function createImportJob(
  user: User,
  data: { bankId?: number | null; fileName?: string | null; sourceType?: string | null; requestPayload?: Record<string, unknown> }
) {
  if (data.bankId) await requireBankOwner(user, data.bankId);
  const sourceType = requireImportSourceType(user, data.sourceType);
  const rows = await sql<ImportJob[]>`
    INSERT INTO question_import_jobs (created_by, bank_id, file_name, source_type, request_payload)
    VALUES (${user.id}, ${data.bankId ?? null}, ${data.fileName ?? null}, ${sourceType}, ${JSON.stringify(data.requestPayload ?? {})})
    RETURNING *
  `;
  return rows[0];
}

export async function addImportJobFile(
  user: User,
  jobId: number,
  data: { artifactType?: string; storagePath?: string | null; content?: Record<string, unknown> | null; sourceType?: string | null }
) {
  const job = await getImportJob(user, jobId);
  if (!data.storagePath && !data.content) {
    throw new ApiError(400, 'SOURCE_FILE_REQUIRED', 'Import artifact requires storagePath or content');
  }
  const sourceType = requireImportSourceType(user, data.sourceType ?? extractSourceTypeFromArtifact(data.storagePath, data.content) ?? job.source_type);
  const rows = await sql`
    UPDATE question_import_jobs
    SET source_type = ${sourceType}
    WHERE id = ${jobId}
    RETURNING *
  `;
  const artifactRows = await sql`
    INSERT INTO question_import_job_artifacts (job_id, artifact_type, storage_path, content_json)
    VALUES (
      ${jobId},
      ${data.artifactType ?? 'source_file'},
      ${data.storagePath ?? null},
      ${JSON.stringify({ ...(data.content ?? {}), sourceType })}
    )
    RETURNING *
  `;
  void rows;
  return artifactRows[0];
}

export async function addImportJobUploadedFile(
  user: User,
  jobId: number,
  file: FormDataEntryValue | null
) {
  const { inferImportSourceType, isUploadedFile, readObjectBuffer, storeImportSourceFile } = await import('./object-storage');
  const job = await getImportJob(user, jobId);
  if (!isUploadedFile(file)) {
    throw new ApiError(400, 'FILE_REQUIRED', 'Upload file is required');
  }

  const stored = await storeImportSourceFile(user.id, jobId, file);
  const inferredSourceType = inferImportSourceType(file);
  const sourceType = requireImportSourceType(user, inferredSourceType === 'unknown' ? job.source_type : inferredSourceType);
  const content: Record<string, unknown> = {
    objectUrl: stored.objectUrl,
    objectKey: stored.relativePath,
    originalName: stored.originalName,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sourceType
  };

  if (sourceType === 'txt') {
    const buffer = await readObjectBuffer(stored.relativePath);
    content.text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  }

  const rows = await sql`
    UPDATE question_import_jobs
    SET source_type = ${sourceType}, file_name = COALESCE(file_name, ${stored.originalName})
    WHERE id = ${jobId}
    RETURNING *
  `;
  const artifactRows = await sql`
    INSERT INTO question_import_job_artifacts (job_id, artifact_type, storage_path, content_json)
    VALUES (${jobId}, 'source_file', ${stored.objectUrl}, ${JSON.stringify(content)})
    RETURNING *
  `;
  void rows;
  return artifactRows[0];
}

export async function getImportJob(user: User, jobId: number) {
  const rows = await sql<ImportJob[]>`
    SELECT *
    FROM question_import_jobs
    WHERE id = ${jobId} AND created_by = ${user.id}
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Import job not found');
  return rows[0];
}

export async function updateImportJobStatus(user: User, jobId: number, action: 'start' | 'retry' | 'cancel') {
  await getImportJob(user, jobId);
  const queue = await importQueueHandlers();
  if ((action === 'start' || action === 'retry') && !queue.isImportQueueConfigured()) {
    throw new ApiError(503, 'IMPORT_QUEUE_UNAVAILABLE', 'Redis import queue is not configured');
  }
  if (action === 'start' || action === 'retry') {
    await ensureImportJobHasSourceArtifact(jobId);
  }
  const values =
    action === 'cancel'
      ? { status: 'failed', stage: 'failed', lastError: '任务已取消。', completed: true }
      : { status: 'queued', stage: 'queued', lastError: null, completed: false };
  const rows = await sql.begin(async (tx) => {
    const updated = await tx<ImportJob[]>`
      UPDATE question_import_jobs
      SET
        status = ${values.status},
        stage = ${values.stage},
        last_error = ${values.lastError},
        retry_count = retry_count + ${action === 'retry' ? 1 : 0},
        completed_at = CASE WHEN ${values.completed} THEN NOW() ELSE NULL END
      WHERE id = ${jobId}
      RETURNING *
    `;
    const event = await tx`
      INSERT INTO question_import_job_events (job_id, stage, step_code, step_label, status, message, overall_progress_percent)
      VALUES (
        ${jobId}, ${values.stage}, ${action}, ${action === 'start' ? '加入导入队列' : action === 'retry' ? '重新排队' : '取消任务'},
        ${values.status === 'failed' ? 'failed' : 'queued'}, ${values.lastError}, ${updated[0].overall_progress_percent}
      )
      RETURNING *
    `;
    return { updated, event: event[0] };
  });
  await publishImportEvent(jobId, rows.event);

  if (action === 'cancel') {
    await queue.removeQueuedImportJob(jobId).catch(() => false);
    await invalidateUserAnalytics(user.id);
    return rows.updated[0];
  }

  const queued = await queue.enqueueImportJob({ jobId, userId: user.id, persistQuestions: true });
  if (!queued) {
    await recordImportJobFailure(jobId, new Error('Redis import queue is not available'));
    throw new ApiError(503, 'IMPORT_QUEUE_UNAVAILABLE', 'Failed to enqueue import job');
  }

  await invalidateUserAnalytics(user.id);
  return rows.updated[0];
}

export async function queueImportJobForUser(
  user: User,
  jobId: number,
  options?: { persistQuestions?: boolean; retry?: boolean }
) {
  await getImportJob(user, jobId);
  const queue = await importQueueHandlers();
  if (!queue.isImportQueueConfigured()) {
    throw new ApiError(503, 'IMPORT_QUEUE_UNAVAILABLE', 'Redis import queue is not configured');
  }
  await ensureImportJobHasSourceArtifact(jobId);

  const rows = await sql.begin(async (tx) => {
    const updated = await tx<ImportJob[]>`
      UPDATE question_import_jobs
      SET
        status = 'queued',
        stage = 'queued',
        last_error = NULL,
        last_error_code = NULL,
        completed_at = NULL,
        retry_count = retry_count + ${options?.retry ? 1 : 0}
      WHERE id = ${jobId}
      RETURNING *
    `;
    const event = await tx`
      INSERT INTO question_import_job_events (job_id, stage, step_code, step_label, status, message, overall_progress_percent)
      VALUES (${jobId}, 'queued', 'queue_parse', '加入导入队列', 'queued', NULL, ${updated[0].overall_progress_percent})
      RETURNING *
    `;
    return { updated, event: event[0] };
  });

  await publishImportEvent(jobId, rows.event);
  const queued = await queue.enqueueImportJob({
    jobId,
    userId: user.id,
    persistQuestions: options?.persistQuestions ?? true
  });
  if (!queued) {
    await recordImportJobFailure(jobId, new Error('Redis import queue is not available'));
    throw new ApiError(503, 'IMPORT_QUEUE_UNAVAILABLE', 'Failed to enqueue import job');
  }
  await invalidateUserAnalytics(user.id);
  return rows.updated[0];
}

export async function recordImportJobFailure(jobId: number, error: unknown) {
  const internalMessage = error instanceof Error ? error.message : String(error);
  logger.error({ ...errorToLog(error), jobId }, 'import job reached terminal failure');
  const message = '导入失败，请稍后重试或联系管理员。';
  const rows = await sql.begin(async (tx) => {
    const event = await tx`
      INSERT INTO question_import_job_events (
        job_id, stage, step_code, step_label, status, message, overall_progress_percent, step_progress_percent
      )
      VALUES (${jobId}, 'failed', 'import_failed', '导入失败', 'failed', ${message}, 100, 100)
      RETURNING *
    `;
    const updated = await tx`
      UPDATE question_import_jobs
      SET
        status = 'failed',
        stage = 'failed',
        last_error = ${message},
        last_error_code = 'IMPORT_WORKER_FAILED',
        metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object('last_internal_error', ${internalMessage}),
        overall_progress_percent = 100,
        step_progress_percent = 100,
        last_event_id = ${event[0].id},
        last_event_at = NOW(),
        completed_at = NOW()
      WHERE id = ${jobId}
      RETURNING *
    `;
    return { event: event[0], updated: updated[0] };
  });
  await publishImportEvent(jobId, rows.event);
  return rows.updated;
}

export async function resolveImportReviewItem(user: User, jobId: number, itemId: number, note?: string | null) {
  await getImportJob(user, jobId);
  const rows = await sql`
    UPDATE question_import_job_review_items
    SET status = 'resolved', resolved_by = ${user.id}, resolution_note = ${note ?? null}, resolved_at = NOW()
    WHERE id = ${itemId}
      AND job_id = ${jobId}
      AND status = 'open'
    RETURNING *
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Open review item not found');
  return rows[0];
}

type ImportJobChildKind = 'events' | 'pages' | 'blocks' | 'review-items' | 'outputs' | 'artifacts';

export async function listImportJobChildren(user: User, jobId: number, kind: ImportJobChildKind) {
  await getImportJob(user, jobId);
  return listImportJobChildrenForJob(jobId, kind);
}

export async function getImportJobDetail(user: User, jobId: number) {
  const job = await getImportJob(user, jobId);
  const [events, pages, blocks, reviewItems, outputs] = await Promise.all([
    listImportJobChildrenForJob(jobId, 'events'),
    listImportJobChildrenForJob(jobId, 'pages'),
    listImportJobChildrenForJob(jobId, 'blocks'),
    listImportJobChildrenForJob(jobId, 'review-items'),
    listImportJobChildrenForJob(jobId, 'outputs')
  ]);

  return { job, events, pages, blocks, reviewItems, outputs };
}

async function listImportJobChildrenForJob(jobId: number, kind: ImportJobChildKind) {
  if (kind === 'events') return sql`SELECT * FROM question_import_job_events WHERE job_id = ${jobId} ORDER BY id DESC LIMIT 100`;
  if (kind === 'pages') return sql`SELECT * FROM question_import_job_pages WHERE job_id = ${jobId} ORDER BY page_no`;
  if (kind === 'blocks') return sql`SELECT * FROM question_import_job_blocks WHERE job_id = ${jobId} ORDER BY id LIMIT 200`;
  if (kind === 'review-items') return sql`SELECT * FROM question_import_job_review_items WHERE job_id = ${jobId} ORDER BY id LIMIT 200`;
  if (kind === 'artifacts') return sql`SELECT * FROM question_import_job_artifacts WHERE job_id = ${jobId} ORDER BY id`;
  return sql`SELECT * FROM question_import_job_outputs WHERE job_id = ${jobId} ORDER BY id LIMIT 200`;
}

export async function createMediaAsset(
  data: { storagePath: string; externalUrl?: string | null; originalName?: string | null; mimeType?: string | null; sizeBytes?: number | null }
) {
  const rows = await sql<MediaAsset[]>`
    INSERT INTO media_assets (storage_path, external_url, original_name, mime_type, size_bytes)
    VALUES (${data.storagePath}, ${data.externalUrl ?? null}, ${data.originalName ?? null}, ${data.mimeType ?? null}, ${data.sizeBytes ?? null})
    RETURNING *
  `;
  return rows[0];
}

export async function getMediaAsset(_user: User, mediaId: number) {
  const rows = await sql<MediaAsset[]>`
    SELECT *
    FROM media_assets
    WHERE id = ${mediaId}
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Media asset not found');
  return rows[0];
}

export async function deleteMediaAsset(_user: User, mediaId: number) {
  await sql`DELETE FROM media_assets WHERE id = ${mediaId}`;
}

export async function linkQuestionMedia(
  user: User,
  questionId: number,
  data: { mediaId: number; mediaKind: string; sortOrder?: number }
) {
  await ensureQuestionEditable(user, questionId);
  const rows = await sql`
    INSERT INTO question_media_links (question_id, media_id, media_kind, sort_order)
    VALUES (${questionId}, ${data.mediaId}, ${data.mediaKind}, ${data.sortOrder ?? 1})
    RETURNING *
  `;
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

export async function linkGroupMedia(
  user: User,
  groupId: number,
  data: { mediaId: number; mediaKind: string; sortOrder?: number }
) {
  await ensureGroupEditable(user, groupId);
  const rows = await sql`
    INSERT INTO question_group_media_links (group_id, media_id, media_kind, sort_order)
    VALUES (${groupId}, ${data.mediaId}, ${data.mediaKind}, ${data.sortOrder ?? 1})
    RETURNING *
  `;
  const banks = await sql<Array<{ bank_id: number }>>`
    SELECT bank_id FROM bank_group_links WHERE group_id = ${groupId}
  `;
  await Promise.all(banks.map((bank) => invalidateBankCaches(bank.bank_id, user.id)));
  return rows[0];
}

export async function linkOptionMedia(
  user: User,
  optionId: number,
  data: { mediaId: number; mediaKind: string; sortOrder?: number }
) {
  const questionRows = await sql<Array<{ question_id: number }>>`
    SELECT question_id
    FROM question_options
    WHERE id = ${optionId}
    LIMIT 1
  `;
  if (!questionRows[0]) throw new ApiError(404, 'NOT_FOUND', 'Option not found');
  await ensureQuestionEditable(user, questionRows[0].question_id);
  const rows = await sql`
    INSERT INTO question_option_media_links (option_id, media_id, media_kind, sort_order)
    VALUES (${optionId}, ${data.mediaId}, ${data.mediaKind}, ${data.sortOrder ?? 1})
    RETURNING *
  `;
  await invalidateQuestionCaches(questionRows[0].question_id);
  return rows[0];
}

export async function search(user: User, target: string, params: URLSearchParams) {
  const q = params.get('q') || '';
  const normalizedQuery = q.trim() || null;
  if (target === 'banks') {
    return listBanks(user, new URLSearchParams({ scope: params.get('scope') || 'all', q }));
  }
  if (target === 'questions') {
    const bankId = params.get('bankId');
    const parsedBankId = bankId ? Number(bankId) : null;
    const type = params.get('type');
    const status = params.get('status');
    return sql`
      WITH visible_question_ids AS MATERIALIZED (
        ${parsedBankId
          ? sql`
              SELECT bql.question_id
              FROM bank_question_links bql
              JOIN question_banks b ON b.id = bql.bank_id
              LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = ${user.id}
              WHERE bql.bank_id = ${parsedBankId}
                AND (b.is_public = true OR ubl.id IS NOT NULL)

              UNION

              SELECT gql.question_id
              FROM bank_group_links bgl
              JOIN question_banks b ON b.id = bgl.bank_id
              LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = ${user.id}
              JOIN group_question_links gql ON gql.group_id = bgl.group_id
              WHERE bgl.bank_id = ${parsedBankId}
                AND (b.is_public = true OR ubl.id IS NOT NULL)
            `
          : sql`
              SELECT bql.question_id
              FROM bank_question_links bql
              JOIN question_banks b ON b.id = bql.bank_id
              LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = ${user.id}
              WHERE b.is_public = true OR ubl.id IS NOT NULL

              UNION

              SELECT gql.question_id
              FROM bank_group_links bgl
              JOIN question_banks b ON b.id = bgl.bank_id
              LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = ${user.id}
              JOIN group_question_links gql ON gql.group_id = bgl.group_id
              WHERE b.is_public = true OR ubl.id IS NOT NULL
            `}
      ),
      searchable_questions AS MATERIALIZED (
        SELECT q.*
        FROM visible_question_ids vq
        JOIN questions q ON q.id = vq.question_id
        WHERE (${type ?? null}::text IS NULL OR q.question_type_id = ${type ?? null})
          AND (${status ?? null}::text IS NULL OR q.status = ${status ?? null})
      ),
      query AS (
        SELECT
          ${normalizedQuery}::text AS term,
          CASE
            WHEN ${normalizedQuery}::text IS NULL THEN NULL
            ELSE plainto_tsquery('simple', ${normalizedQuery}::text)
          END AS tsq
      )
      SELECT sq.*
      FROM searchable_questions sq
      CROSS JOIN query
      WHERE query.term IS NULL
         OR sq.stem ILIKE '%' || query.term || '%'
         OR to_tsvector('simple', COALESCE(sq.stem, '')) @@ query.tsq
      ORDER BY
        CASE
          WHEN query.tsq IS NULL THEN 0
          ELSE ts_rank_cd(to_tsvector('simple', COALESCE(sq.stem, '')), query.tsq)
        END DESC,
        sq.updated_at DESC
      LIMIT 50
    `;
  }
  return listKnowledgePoints(params.get('subject') ?? undefined);
}

export async function getAnalyticsSummary(user: User) {
  const version = await cacheVersion('analytics', user.id);
  return redisGetOrSetJson(
    redisKey('cache', 'analytics', 'user', user.id, version, 'summary'),
    Number(process.env.ANALYTICS_CACHE_TTL_SECONDS || 30),
    async () => {
      const rows = await sql<Array<{
        owned_banks: number;
        favorite_banks: number;
        attempts: number;
        correct: number;
        wrong: number;
        sessions: number;
        active_sessions: number;
        active_imports: number;
      }>>`
        SELECT
          (SELECT COUNT(*)::int FROM user_bank_links WHERE user_id = ${user.id} AND is_owner = true) AS owned_banks,
          (SELECT COUNT(*)::int FROM user_bank_links WHERE user_id = ${user.id} AND is_favorite = true) AS favorite_banks,
          COALESCE((SELECT SUM(attempt_count)::int FROM user_question_stats WHERE user_id = ${user.id}), 0) AS attempts,
          COALESCE((SELECT SUM(correct_count)::int FROM user_question_stats WHERE user_id = ${user.id}), 0) AS correct,
          COALESCE((SELECT SUM(wrong_count)::int FROM user_question_stats WHERE user_id = ${user.id}), 0) AS wrong,
          (SELECT COUNT(*)::int FROM user_practice_sessions WHERE user_id = ${user.id}) AS sessions,
          (SELECT COUNT(*)::int FROM user_practice_sessions WHERE user_id = ${user.id} AND status = 'active') AS active_sessions,
          (SELECT COUNT(*)::int FROM question_import_jobs WHERE created_by = ${user.id} AND status IN ('queued', 'processing')) AS active_imports
      `;
      const summary = rows[0];
      return {
        ...summary,
        accuracy: summary.attempts ? Math.round((summary.correct / summary.attempts) * 100) : 0
      };
    }
  );
}

export async function getBankAnalytics(user: User, bankId: number) {
  await getBank(user, bankId);
  const rows = await sql<Array<{ completed_count: number; wrong_count: number; practiced_users: number; answer_count: number }>>`
    SELECT
      COALESCE(SUM(completed_count), 0)::int AS completed_count,
      COALESCE(SUM(wrong_count), 0)::int AS wrong_count,
      COUNT(*)::int AS practiced_users,
      (
        SELECT COUNT(*)::int
        FROM user_question_answers
        WHERE bank_id = ${bankId}
      ) AS answer_count
    FROM user_bank_stats
    WHERE bank_id = ${bankId}
  `;
  return rows[0];
}

export async function getBankLeaderboard(user: User, bankId: number, limit = 20) {
  await getBank(user, bankId);
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const version = await cacheVersion('leaderboard', bankId);
  return redisGetOrSetJson(
    redisKey('cache', 'leaderboard', 'bank', bankId, version, hashKey({ limit: safeLimit })),
    Number(process.env.LEADERBOARD_CACHE_TTL_SECONDS || 60),
    () => sql`
      SELECT
        u.id AS user_id,
        u.username,
        ubs.completed_count,
        ubs.wrong_count,
        ubs.last_practiced_at,
        CASE
          WHEN ubs.completed_count > 0
          THEN ROUND(((ubs.completed_count - ubs.wrong_count)::numeric / ubs.completed_count) * 100, 2)
          ELSE 0
        END AS accuracy_percent
      FROM user_bank_stats ubs
      JOIN users u ON u.id = ubs.user_id
      WHERE ubs.bank_id = ${bankId}
      ORDER BY ubs.completed_count DESC, accuracy_percent DESC, ubs.last_practiced_at DESC NULLS LAST
      LIMIT ${safeLimit}
    `
  );
}

export async function getUserStatsSnapshot(user: User) {
  const version = await cacheVersion('analytics', user.id);
  return redisGetOrSetJson(
    redisKey('cache', 'analytics', 'user', user.id, version, 'snapshot'),
    Number(process.env.ANALYTICS_CACHE_TTL_SECONDS || 30),
    async () => {
      const [summary, recentSessions, weakQuestions] = await Promise.all([
        getAnalyticsSummary(user),
        sql`
          SELECT id, bank_id, session_type, status, question_count, answered_count, correct_count, wrong_count, started_at, completed_at
          FROM user_practice_sessions
          WHERE user_id = ${user.id}
          ORDER BY started_at DESC, id DESC
          LIMIT 10
        `,
        sql`
          SELECT
            uqs.question_id,
            uqs.attempt_count,
            uqs.correct_count,
            uqs.wrong_count,
            uqs.mastery_score,
            q.stem,
            q.question_type_id
          FROM user_question_stats uqs
          JOIN questions q ON q.id = uqs.question_id
          WHERE uqs.user_id = ${user.id}
            AND uqs.attempt_count > 0
          ORDER BY uqs.mastery_score ASC NULLS FIRST, uqs.wrong_count DESC, uqs.last_answered_at DESC NULLS LAST
          LIMIT 10
        `
      ]);
      return { summary, recentSessions, weakQuestions };
    }
  );
}

export async function getImportAnalytics(user: User, jobId: number) {
  const job = await getImportJob(user, jobId);
  const rows = await sql<Array<{ events: number; review_open: number; outputs: number }>>`
    SELECT
      (SELECT COUNT(*)::int FROM question_import_job_events WHERE job_id = ${jobId}) AS events,
      (SELECT COUNT(*)::int FROM question_import_job_review_items WHERE job_id = ${jobId} AND status = 'open') AS review_open,
      (SELECT COUNT(*)::int FROM question_import_job_outputs WHERE job_id = ${jobId}) AS outputs
  `;
  return {
    ...job,
    ...rows[0]
  };
}

export async function updateCurrentUser(
  user: User,
  data: { username?: string; email?: string | null; passwordHash?: string | null; avatarUrl?: string | null }
) {
  const rows = await sql<User[]>`
    UPDATE users
    SET
      username = COALESCE(${data.username ?? null}, username),
      email = COALESCE(${data.email ?? null}, email),
      password = COALESCE(${data.passwordHash ?? null}, password),
      avatar_url = CASE
        WHEN ${data.avatarUrl === undefined} THEN avatar_url
        ELSE ${data.avatarUrl ?? null}
      END
    WHERE id = ${user.id}
    RETURNING id, username, email, avatar_url, is_active, role, membership, plus_trial_ends_at, plus_expires_at, created_at, updated_at
  `;
  await invalidateUserCache(user.id);
  return rows[0];
}

export async function exportUserSummaryPdf(user: User) {
  requirePlusEntitlement(user, 'PDF export');
  const summary = await getAnalyticsSummary(user);
  const lines = [
    'OpenWook User Summary',
    `User: ${user.username}`,
    `Role: ${user.role}`,
    `Membership: ${user.membership}`,
    `Plus trial ends: ${user.plus_trial_ends_at ?? 'none'}`,
    '',
    `Owned banks: ${summary.owned_banks}`,
    `Favorite banks: ${summary.favorite_banks}`,
    `Practice sessions: ${summary.sessions}`,
    `Active sessions: ${summary.active_sessions}`,
    `Answer attempts: ${summary.attempts}`,
    `Correct answers: ${summary.correct}`,
    `Wrong answers: ${summary.wrong}`,
    `Accuracy: ${summary.accuracy}%`,
    `Active imports: ${summary.active_imports}`,
    '',
    `Generated at: ${new Date().toISOString()}`
  ];
  return buildSimplePdf(lines);
}

function buildSimplePdf(lines: string[]) {
  const content = [
    'BT',
    '/F1 18 Tf',
    '72 760 Td',
    `(${escapePdfText(lines[0] ?? 'OpenWook Export')}) Tj`,
    '/F1 11 Tf',
    ...lines.slice(1).flatMap((line) => [
      '0 -18 Td',
      `(${escapePdfText(line)}) Tj`
    ]),
    'ET'
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

function escapePdfText(value: string) {
  return value
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

export async function setUserStatus(user: User, targetUserId: number, isActive: boolean) {
  requireAdminRole(user);
  if (user.id === targetUserId && !isActive) {
    throw new ApiError(409, 'INVALID_STATE', 'Administrators cannot disable their own account');
  }
  const rows = await sql<User[]>`
    UPDATE users
    SET is_active = ${isActive}
    WHERE id = ${targetUserId}
    RETURNING id, username, email, avatar_url, is_active, role, membership, plus_trial_ends_at, plus_expires_at, created_at, updated_at
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  await invalidateUserCache(targetUserId);
  return rows[0];
}

export async function updateUserAccess(
  user: User,
  targetUserId: number,
  data: { role?: 'admin' | 'user'; membership?: 'free' | 'plus' }
) {
  requireAdminRole(user);
  if (user.id === targetUserId && data.role === 'user') {
    throw new ApiError(409, 'INVALID_STATE', 'Administrators cannot remove their own admin role');
  }

  const rows = await sql<User[]>`
    UPDATE users
    SET
      role = COALESCE(${data.role ?? null}, role),
      membership = COALESCE(${data.membership ?? null}, membership),
      plus_expires_at = CASE
        WHEN ${data.membership ?? null} = 'free' THEN NULL
        ELSE plus_expires_at
      END
    WHERE id = ${targetUserId}
    RETURNING id, username, email, avatar_url, is_active, role, membership, plus_trial_ends_at, plus_expires_at, created_at, updated_at
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  await invalidateUserCache(targetUserId);
  return rows[0];
}

export async function reorderBankItems(
  user: User,
  bankId: number,
  items: Array<{ questionId?: number; groupId?: number; sortOrder: number }>
) {
  await requireBankOwner(user, bankId);
  await sql.begin(async (tx) => {
    const offsetRows = await tx<Array<{ offset_value: number }>>`
      SELECT COALESCE(MAX(sort_order), 0) + 1000 AS offset_value
      FROM (
        SELECT sort_order FROM bank_question_links WHERE bank_id = ${bankId}
        UNION ALL
        SELECT sort_order FROM bank_group_links WHERE bank_id = ${bankId}
      ) s
    `;
    const offset = offsetRows[0].offset_value;
    await tx`UPDATE bank_question_links SET sort_order = sort_order + ${offset} WHERE bank_id = ${bankId}`;
    await tx`UPDATE bank_group_links SET sort_order = sort_order + ${offset} WHERE bank_id = ${bankId}`;
    for (const item of items) {
      if (item.questionId) {
        await tx`
          UPDATE bank_question_links
          SET sort_order = ${item.sortOrder}
          WHERE bank_id = ${bankId} AND question_id = ${item.questionId}
        `;
      }
      if (item.groupId) {
        await tx`
          UPDATE bank_group_links
          SET sort_order = ${item.sortOrder}
          WHERE bank_id = ${bankId} AND group_id = ${item.groupId}
        `;
      }
    }
  });
  await invalidateBankCaches(bankId, user.id);
}
