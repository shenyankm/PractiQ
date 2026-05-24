import 'server-only';

import { sql } from './db';
import { ApiError } from './api';
import { invalidateUserCache } from './auth';
import { publishImportEvent } from './import-events';
import { enqueueImportJob, isImportQueueConfigured, removeQueuedImportJob } from './import-queue';
import { requireAdminRole, requireImportSourceType, requirePlusEntitlement } from './permissions';
import {
  acquireRedisLock,
  hashKey,
  redisDelByPattern,
  redisGetJson,
  redisGetOrSetJson,
  redisKey,
  redisSetJson
} from './redis';
import type {
  AnswerMode,
  BankQuestionItem,
  ImportJob,
  MediaAsset,
  PracticeAnswer,
  PracticeSession,
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

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function userBankListPattern(userId: number) {
  return redisKey('cache', 'banks', userId, '*');
}

function bankCachePattern(bankId: number) {
  return redisKey('cache', 'bank', bankId, '*');
}

function bankItemsCachePattern(bankId: number) {
  return redisKey('cache', 'bank-items', bankId, '*');
}

function questionCachePattern(questionId: number) {
  return redisKey('cache', 'question', questionId, '*');
}

function practiceQuestionQueueKey(sessionId: number) {
  return redisKey('practice', sessionId, 'question-ids');
}

function answerKeyCacheKey(questionId: number) {
  return redisKey('cache', 'answer-key', questionId);
}

function userAnalyticsPattern(userId: number) {
  return redisKey('cache', 'analytics', 'user', userId, '*');
}

function bankLeaderboardPattern(bankId: number) {
  return redisKey('cache', 'leaderboard', 'bank', bankId, '*');
}

async function invalidateUserBankLists(userId?: number) {
  await redisDelByPattern(userId ? userBankListPattern(userId) : redisKey('cache', 'banks', '*'));
}

async function invalidateUserAnalytics(userId: number) {
  await redisDelByPattern(userAnalyticsPattern(userId));
}

async function invalidateBankLeaderboard(bankId: number | null | undefined) {
  if (bankId) await redisDelByPattern(bankLeaderboardPattern(bankId));
}

async function invalidateBankCaches(bankId: number, userId?: number) {
  await Promise.all([
    redisDelByPattern(bankCachePattern(bankId)),
    redisDelByPattern(bankItemsCachePattern(bankId)),
    invalidateUserBankLists(userId)
  ]);
}

async function invalidateQuestionCaches(questionId: number) {
  const bankRows = await sql<Array<{ bank_id: number }>>`
    SELECT bank_id FROM bank_question_links WHERE question_id = ${questionId}
    UNION
    SELECT bgl.bank_id
    FROM bank_group_links bgl
    JOIN group_question_links gql ON gql.group_id = bgl.group_id
    WHERE gql.question_id = ${questionId}
  `;
  await redisDelByPattern(questionCachePattern(questionId));
  await redisDelByPattern(answerKeyCacheKey(questionId));
  await Promise.all(bankRows.map((row) => invalidateBankCaches(row.bank_id)));
}

async function loadPracticeQuestionIds(bankId: number, count: number) {
  const rows = await sql<Array<{ question_id: number }>>`
    SELECT question_id
    FROM v_bank_question_items
    WHERE bank_id = ${bankId}
      AND bank_link_status = 'active'
      AND question_status = 'active'
    ORDER BY bank_sort_order, question_id
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
  return redisGetOrSetJson(
    redisKey('cache', 'knowledge-points', hashKey({ subject: subject ?? null, parentId: parentId ?? null })),
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
  await redisDelByPattern(redisKey('cache', 'knowledge-points', '*'));
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
  await redisDelByPattern(redisKey('cache', 'knowledge-points', '*'));
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

  return redisGetOrSetJson<QuestionBank[]>(
    redisKey('cache', 'banks', user.id, hashKey({ scope, subject, q, limit })),
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
  const bank = await redisGetOrSetJson<QuestionBank | null>(
    redisKey('cache', 'bank', bankId, 'user', user.id),
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
  const status = params.get('status');
  const type = params.get('type');
  const limit = Math.min(Number(params.get('limit') || 50), 100);
  return redisGetOrSetJson<BankQuestionItem[]>(
    redisKey('cache', 'bank-items', bankId, 'user', user.id, hashKey({ status, type, limit })),
    shortCacheTtl,
    () => sql<BankQuestionItem[]>`
      SELECT
        v.*,
        COALESCE(
          (
            SELECT json_agg(qo.* ORDER BY qo.sort_order)
            FROM question_options qo
            WHERE qo.question_id = v.question_id
          ),
          '[]'
        ) AS options
      FROM v_bank_question_items
        v
      WHERE bank_id = ${bankId}
        AND (${status ?? null}::text IS NULL OR bank_link_status = ${status ?? null})
        AND (${type ?? null}::text IS NULL OR question_type_id = ${type ?? null})
      ORDER BY bank_sort_order, group_sort_order NULLS FIRST, question_id
      LIMIT ${limit}
    `
  );
}

export async function createGroup(
  user: User,
  bankId: number,
  data: { title: string; instructions?: string | null; groupTypeId?: string | null; contentMode?: string | null; status?: 'draft' | 'active' | 'archived' }
) {
  const bank = await requireBankOwner(user, bankId);
  const group = await sql.begin(async (tx) => {
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
        ${bank.subject}, ${data.groupTypeId ?? 'generic_answer_mode'}, ${data.title}, ${data.instructions ?? null},
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
  const question = await redisGetOrSetJson<
    (Question & { options: unknown; answer_keys: unknown; content_blocks: unknown; media_links: unknown }) | null
  >(
    redisKey('cache', 'question', questionId, 'user', user.id),
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
  }
) {
  const bank = await requireBankOwner(user, bankId);
  const question = await sql.begin(async (tx) => {
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
        ${bank.subject}, ${data.questionTypeId}, ${data.answerMode},
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
  await invalidateBankCaches(bankId, user.id);
  return question;
}

export async function updateQuestion(
  user: User,
  questionId: number,
  data: { stem?: string; analysis?: string | null; status?: string }
) {
  await ensureQuestionEditable(user, questionId);
  const rows = await sql<Question[]>`
    UPDATE questions
    SET
      stem = COALESCE(${data.stem ?? null}, stem),
      analysis = COALESCE(${data.analysis ?? null}, analysis),
      status = COALESCE(${data.status ?? null}, status)
    WHERE id = ${questionId}
    RETURNING *
  `;
  await invalidateQuestionCaches(questionId);
  return rows[0];
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
  await redisDelByPattern(questionCachePattern(questionId));
}

export async function setQuestionStatus(user: User, questionId: number, status: 'draft' | 'active' | 'archived') {
  if (status === 'active') await assertQuestionPublishable(user, questionId);
  return updateQuestion(user, questionId, { status });
}

async function assertQuestionPublishable(user: User, questionId: number) {
  await ensureQuestionEditable(user, questionId);
  const rows = await sql<Array<{ answer_mode: AnswerMode; option_count: number; correct_option_count: number; answer_key_count: number }>>`
    SELECT
      q.answer_mode,
      (SELECT COUNT(*)::int FROM question_options qo WHERE qo.question_id = q.id) AS option_count,
      (SELECT COUNT(*)::int FROM question_options qo WHERE qo.question_id = q.id AND qo.is_correct = true) AS correct_option_count,
      (SELECT COUNT(*)::int FROM question_answer_keys qak WHERE qak.question_id = q.id AND qak.is_primary = true) AS answer_key_count
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
  data: { bankId: number; sessionType?: 'practice' | 'review' | 'exam'; questionCount?: number }
) {
  await getBank(user, data.bankId);
  const count = Math.max(1, Math.min(data.questionCount ?? 10, 100));
  const questionIds = await loadPracticeQuestionIds(data.bankId, count);
  if (questionIds.length < 1) {
    throw new ApiError(409, 'INVALID_STATE', 'No active questions are available for practice');
  }
  const rows = await sql<PracticeSession[]>`
    INSERT INTO user_practice_sessions (user_id, bank_id, session_type, question_count)
    VALUES (${user.id}, ${data.bankId}, ${data.sessionType ?? 'practice'}, ${questionIds.length})
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

export async function getPracticeQuestions(user: User, sessionId: number) {
  const session = await getPracticeSession(user, sessionId);
  if (!session.bank_id) return [];
  const cachedQuestionIds = await redisGetJson<number[]>(practiceQuestionQueueKey(sessionId));
  if (cachedQuestionIds?.length) {
    const ids = sql.array(cachedQuestionIds);
    return sql<BankQuestionItem[]>`
      SELECT *
      FROM v_bank_question_items
      WHERE bank_id = ${session.bank_id}
        AND question_id = ANY(${ids}::bigint[])
      ORDER BY array_position(${ids}::bigint[], question_id)
      LIMIT ${session.question_count}
    `;
  }

  const questions = await sql<BankQuestionItem[]>`
    SELECT *
    FROM v_bank_question_items
    WHERE bank_id = ${session.bank_id}
      AND bank_link_status = 'active'
      AND question_status = 'active'
    ORDER BY bank_sort_order, question_id
    LIMIT ${session.question_count}
  `;
  await redisSetJson(practiceQuestionQueueKey(sessionId), questions.map((question) => Number(question.question_id)), practiceQueueTtl);
  return questions;
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
      SELECT answer_mode
      FROM questions
      WHERE id = ${data.questionId}
        AND EXISTS (
          SELECT 1
          FROM v_bank_question_items v
          WHERE v.bank_id = ${session.bank_id}
            AND v.question_id = questions.id
            AND v.bank_link_status = 'active'
            AND v.question_status = 'active'
        )
      LIMIT 1
    `;
    if (!questionRows[0]) throw new ApiError(404, 'NOT_FOUND', 'Question is not part of this active practice session');

    const isCorrect = answerKey ? gradeAnswer(questionRows[0].answer_mode, answerKey.answer_payload, data.answerPayload) : null;
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

function firstSlotValue(value: unknown, slotKey: string) {
  const slots = objectValue(value, 'slots');
  if (!Array.isArray(slots) || !slots[0] || typeof slots[0] !== 'object') return undefined;
  const firstSlot = slots[0] as Record<string, unknown>;
  const nested = firstSlot[slotKey];
  if (Array.isArray(nested)) return nested[0];
  return nested;
}

function gradeAnswer(mode: AnswerMode, expectedJson: string, actual: Record<string, unknown>) {
  const expected = parseJson(expectedJson);
  if (!expected) return null;

  if (mode === 'choice') {
    return normalizeStringArray(objectValue(expected, 'selected')).join('|') === normalizeStringArray(objectValue(actual, 'selected')).join('|');
  }
  if (mode === 'true_false') {
    return Boolean(objectValue(expected, 'value')) === Boolean(objectValue(actual, 'value'));
  }
  if (mode === 'fill_blank') {
    const expectedValue = normalizeText(objectValue(expected, 'value') ?? firstSlotValue(expected, 'answers'));
    const actualValue = normalizeText(objectValue(actual, 'value') ?? firstSlotValue(actual, 'value'));
    return expectedValue.length > 0 && expectedValue === actualValue;
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
  data: { artifactType?: string; storagePath?: string | null; content?: Record<string, unknown> | null }
) {
  await getImportJob(user, jobId);
  const rows = await sql`
    INSERT INTO question_import_job_artifacts (job_id, artifact_type, storage_path, content_json)
    VALUES (${jobId}, ${data.artifactType ?? 'source_file'}, ${data.storagePath ?? null}, ${data.content ? JSON.stringify(data.content) : null})
    RETURNING *
  `;
  return rows[0];
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
  if ((action === 'start' || action === 'retry') && !isImportQueueConfigured()) {
    throw new ApiError(503, 'IMPORT_QUEUE_UNAVAILABLE', 'Redis import queue is not configured');
  }
  const values =
    action === 'cancel'
      ? { status: 'failed', stage: 'failed', lastError: 'cancelled', completed: true }
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
    await removeQueuedImportJob(jobId).catch(() => false);
    await invalidateUserAnalytics(user.id);
    return rows.updated[0];
  }

  const queued = await enqueueImportJob({ jobId, userId: user.id, persistQuestions: true });
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
  if (!isImportQueueConfigured()) {
    throw new ApiError(503, 'IMPORT_QUEUE_UNAVAILABLE', 'Redis import queue is not configured');
  }

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
  const queued = await enqueueImportJob({
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
  const message = error instanceof Error ? error.message : String(error);
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

export async function listImportJobChildren(user: User, jobId: number, kind: 'events' | 'pages' | 'blocks' | 'review-items' | 'outputs' | 'artifacts') {
  await getImportJob(user, jobId);
  if (kind === 'events') return sql`SELECT * FROM question_import_job_events WHERE job_id = ${jobId} ORDER BY id`;
  if (kind === 'pages') return sql`SELECT * FROM question_import_job_pages WHERE job_id = ${jobId} ORDER BY page_no`;
  if (kind === 'blocks') return sql`SELECT * FROM question_import_job_blocks WHERE job_id = ${jobId} ORDER BY id`;
  if (kind === 'review-items') return sql`SELECT * FROM question_import_job_review_items WHERE job_id = ${jobId} ORDER BY id`;
  if (kind === 'artifacts') return sql`SELECT * FROM question_import_job_artifacts WHERE job_id = ${jobId} ORDER BY id`;
  return sql`SELECT * FROM question_import_job_outputs WHERE job_id = ${jobId} ORDER BY id`;
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
  if (target === 'banks') {
    return listBanks(user, new URLSearchParams({ scope: params.get('scope') || 'all', q }));
  }
  if (target === 'questions') {
    const bankId = params.get('bankId');
    return sql`
      SELECT q.*
      FROM questions q
      WHERE EXISTS (
        SELECT 1
        FROM bank_question_links bql
        JOIN question_banks b ON b.id = bql.bank_id
        LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = ${user.id}
        WHERE bql.question_id = q.id
          AND (b.is_public = true OR ubl.id IS NOT NULL)
          AND (${bankId ?? null}::bigint IS NULL OR b.id = ${bankId ? Number(bankId) : null})
      )
        AND (
          ${q || null}::text IS NULL
          OR q.stem ILIKE ${q ? `%${q}%` : null}
          OR to_tsvector('simple', q.stem) @@ plainto_tsquery('simple', ${q})
        )
        AND (${params.get('type') ?? null}::text IS NULL OR q.question_type_id = ${params.get('type') ?? null})
        AND (${params.get('status') ?? null}::text IS NULL OR q.status = ${params.get('status') ?? null})
      ORDER BY
        CASE
          WHEN ${q || null}::text IS NULL THEN 0
          ELSE ts_rank_cd(to_tsvector('simple', q.stem), plainto_tsquery('simple', ${q}))
        END DESC,
        q.updated_at DESC
      LIMIT 50
    `;
  }
  return listKnowledgePoints(params.get('subject') ?? undefined);
}

export async function getAnalyticsSummary(user: User) {
  return redisGetOrSetJson(
    redisKey('cache', 'analytics', 'user', user.id, 'summary'),
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
  return redisGetOrSetJson(
    redisKey('cache', 'leaderboard', 'bank', bankId, hashKey({ limit: safeLimit })),
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
  return redisGetOrSetJson(
    redisKey('cache', 'analytics', 'user', user.id, 'snapshot'),
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
  data: { username?: string; email?: string | null; passwordHash?: string | null }
) {
  const rows = await sql<User[]>`
    UPDATE users
    SET
      username = COALESCE(${data.username ?? null}, username),
      email = COALESCE(${data.email ?? null}, email),
      password = COALESCE(${data.passwordHash ?? null}, password)
    WHERE id = ${user.id}
    RETURNING id, username, email, is_active, role, membership, plus_trial_ends_at, created_at, updated_at
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
  const rows = await sql<User[]>`
    UPDATE users
    SET is_active = ${isActive}
    WHERE id = ${targetUserId}
    RETURNING id, username, email, is_active, role, membership, plus_trial_ends_at, created_at, updated_at
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
