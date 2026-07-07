import 'server-only';

import { sql } from '../db';
import { ApiError } from '../api';
import { hashKey, redisGetOrSetJson, redisKey } from '../redis';
import {
  cacheVersion,
  invalidateBankCaches,
  invalidateUserAnalytics,
  loadBankQuestionItems,
  parseJson,
  shortCacheTtl
} from './internal';
import type { BankQuestionItem, QuestionBank, User } from '../types';

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
