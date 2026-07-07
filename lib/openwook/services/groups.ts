import 'server-only';

import { sql } from '../db';
import { ApiError } from '../api';
import { invalidateBankCaches, invalidateQuestionCaches } from './internal';
import { requireBankOwner } from './banks';
import { ensureQuestionEditable } from './questions';
import { resolveQuestionTypeIdForSubject } from './reference';
import type { User } from '../types';

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
