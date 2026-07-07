import 'server-only';

import { sql } from '../db';
import { ApiError } from '../api';
import { invalidateBankCaches, invalidateQuestionCaches } from './internal';
import { ensureGroupEditable } from './groups';
import { ensureQuestionEditable } from './questions';
import type { MediaAsset, User } from '../types';

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
