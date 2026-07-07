import 'server-only';

import { sql } from '../db';
import { listBanks } from './banks';
import { listKnowledgePoints } from './reference';
import type { User } from '../types';

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
