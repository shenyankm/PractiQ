import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Image } from 'react-native';

import { assertManagedFileCapacity, MAX_MANAGED_FILE_BYTES } from '../backup';
import { writeTransaction } from '../database-core';
import { assertImageDimensions, sniffMediaKind } from '../media';
import {
  PRACTICE_SNAPSHOT_MEDIA_URIS_SQL,
} from '../practice-snapshot';
import {
  deletePickerCacheCopy,
  isDirectManagedFile,
  managedSandboxBytes,
  safeName,
  withFileMaintenance,
} from './sandbox';

const MAX_MEDIA_BYTES = MAX_MANAGED_FILE_BYTES;
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/m4v']);

export type MediaTarget = { questionId: number } | { optionId: number } | { groupId: number };

function mediaTarget(target: MediaTarget) {
  const values: [column: 'question_id' | 'option_id' | 'group_id', id: number][] = [];
  if ('questionId' in target) values.push(['question_id', target.questionId]);
  if ('optionId' in target) values.push(['option_id', target.optionId]);
  if ('groupId' in target) values.push(['group_id', target.groupId]);
  if (values.length !== 1 || !Number.isInteger(values[0][1]) || values[0][1] <= 0) {
    throw new Error('媒体关联目标无效');
  }
  return values[0];
}

export async function importMedia(db: SQLiteDatabase, target: MediaTarget, kind: 'all' | 'image' = 'all') {
  const [column, targetId] = mediaTarget(target);
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    type: kind === 'image' ? 'image/*' : ['image/*', 'video/*'],
  });
  if (result.canceled) return;
  const asset = result.assets[0];
  const source = new File(asset.uri);
  try {
    await withFileMaintenance(async () => {
      const size = source.size || asset.size || 0;
      const mimeType = (source.type || asset.mimeType || '').split(';', 1)[0].trim().toLocaleLowerCase('en-US');
      if (!size || size > MAX_MEDIA_BYTES) {
        throw new Error('单个媒体文件必须小于 64 MB');
      }
      assertManagedFileCapacity(managedSandboxBytes(), size);
      const claimedKind = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : null;
      if (!claimedKind || (kind === 'image' && claimedKind !== 'image')) {
        throw new Error(kind === 'image' ? '仅支持图片媒体' : '仅支持图片或视频媒体');
      }
      if (claimedKind === 'video' && !VIDEO_MIME_TYPES.has(mimeType)) {
        throw new Error('视频仅支持 MP4、MOV 或 M4V 格式');
      }
      const detectedKind = sniffMediaKind(new Uint8Array(await source.slice(0, 64).arrayBuffer()));
      if (!detectedKind || detectedKind !== claimedKind || (kind === 'image' && detectedKind !== 'image')) {
        throw new Error('媒体文件内容与声明类型不一致，或格式不受支持');
      }
      const dimensions = claimedKind === 'image' ? await Image.getSize(source.uri) : null;
      if (dimensions) assertImageDimensions(dimensions.width, dimensions.height);

      const directory = new Directory(Paths.document, 'media');
      directory.create({ idempotent: true, intermediates: true });
      const destination = new File(directory, `${Date.now()}-${safeName(asset.name)}`);
      await source.copy(destination);
      try {
        await writeTransaction(db, ['media_assets', 'media_links'], async (transaction) => {
          const inserted = await transaction.runAsync(
            `INSERT INTO media_assets(file_name, uri, mime_type, size, width, height)
             VALUES (?, ?, ?, ?, ?, ?)`,
            asset.name,
            destination.uri,
            mimeType,
            size,
            dimensions?.width ?? null,
            dimensions?.height ?? null,
          );
          await transaction.runAsync(
            `INSERT INTO media_links(media_asset_id, ${column}, sort_order)
             VALUES (?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM media_links WHERE ${column} = ?), 0))`,
            inserted.lastInsertRowId,
            targetId,
            targetId,
          );
        });
      } catch (error) {
        try {
          destination.delete();
        } catch {
          // Best-effort cleanup; the database transaction has already rolled back.
        }
        throw error;
      }
    });
  } finally {
    deletePickerCacheCopy(source);
  }
}

type MediaAssetUriRow = { id: number; uri: string };
type UriRow = { uri: string };

/** Removes unreferenced media rows and their app-managed sandbox files. */
export async function pruneOrphanMedia(db: SQLiteDatabase, mediaIds?: readonly number[]) {
  return withFileMaintenance(() => pruneOrphanMediaUnlocked(db, mediaIds));
}

async function pruneOrphanMediaUnlocked(db: SQLiteDatabase, mediaIds?: readonly number[]) {
  const wanted = mediaIds
    ? new Set(mediaIds.filter((id) => Number.isInteger(id) && id > 0))
    : null;
  if (wanted?.size === 0) return true;
  let cleanupSucceeded = true;

  const deleted: MediaAssetUriRow[] = [];
  await writeTransaction(db, ['media_assets'], async (transaction) => {
    const candidates = await transaction.getAllAsync<MediaAssetUriRow>(
      `SELECT ma.id, ma.uri
       FROM media_assets ma
       WHERE NOT EXISTS (
         SELECT 1 FROM media_links ml WHERE ml.media_asset_id = ma.id
       ) AND NOT EXISTS (
         SELECT 1 FROM question_content_blocks qcb WHERE qcb.media_asset_id = ma.id
       ) AND NOT EXISTS (
         SELECT 1 FROM (${PRACTICE_SNAPSHOT_MEDIA_URIS_SQL}) snapshot_media
         WHERE snapshot_media.uri = ma.uri
       )`,
    );
    for (const candidate of candidates) {
      if (wanted && !wanted.has(candidate.id)) continue;
      const result = await transaction.runAsync(
        `DELETE FROM media_assets
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM media_links WHERE media_asset_id = ?)
           AND NOT EXISTS (SELECT 1 FROM question_content_blocks WHERE media_asset_id = ?)
           AND NOT EXISTS (
             SELECT 1 FROM (${PRACTICE_SNAPSHOT_MEDIA_URIS_SQL}) snapshot_media
             WHERE snapshot_media.uri = media_assets.uri
           )`,
        candidate.id,
        candidate.id,
        candidate.id,
      );
      if (result.changes) deleted.push(candidate);
    }
  });
  const mediaDirectory = new Directory(Paths.document, 'media');
  for (const candidate of deleted) {
    if (!isDirectManagedFile(candidate.uri, mediaDirectory)) continue;
    try {
      const file = new File(candidate.uri);
      if (file.exists) file.delete();
    } catch {
      // The now-unreferenced file is retried by the directory sweep below or on next launch.
      cleanupSucceeded = false;
    }
  }
  if (!wanted) {
    const referenced = new Set((await db.getAllAsync<UriRow>(
      `SELECT uri FROM media_assets
       UNION SELECT uri FROM (${PRACTICE_SNAPSHOT_MEDIA_URIS_SQL})`,
    )).map((row) => row.uri));
    try {
      for (const item of mediaDirectory.list()) {
        if (!(item instanceof File) || referenced.has(item.uri) || !isDirectManagedFile(item.uri, mediaDirectory)) continue;
        item.delete();
      }
    } catch {
      // A killed copy or provider cleanup failure is reconciled again on next launch.
      cleanupSucceeded = false;
    }
  }
  return cleanupSucceeded;
}

/** Removes one association, preserving the asset while any other association or content block uses it. */
export async function unlinkMedia(db: SQLiteDatabase, linkId: number) {
  if (!Number.isInteger(linkId) || linkId <= 0) throw new Error('媒体关联无效');
  let mediaId = 0;
  await writeTransaction(db, ['media_links'], async (transaction) => {
    const link = await transaction.getFirstAsync<{ media_asset_id: number }>(
      'SELECT media_asset_id FROM media_links WHERE id = ?',
      linkId,
    );
    if (!link) throw new Error('媒体关联不存在');
    mediaId = link.media_asset_id;
    await transaction.runAsync('DELETE FROM media_links WHERE id = ?', linkId);
  });
  await pruneOrphanMedia(db, [mediaId]);
}

export async function moveMediaLink(db: SQLiteDatabase, linkId: number, direction: -1 | 1) {
  await writeTransaction(db, ['media_links'], async (transaction) => {
    const current = await transaction.getFirstAsync<{
      id: number;
      question_id: number | null;
      option_id: number | null;
      group_id: number | null;
      sort_order: number;
    }>('SELECT id, question_id, option_id, group_id, sort_order FROM media_links WHERE id = ?', linkId);
    if (!current) throw new Error('媒体关联不存在');
    const [column, targetId] = current.question_id !== null
      ? ['question_id', current.question_id] as const
      : current.option_id !== null
        ? ['option_id', current.option_id] as const
        : ['group_id', current.group_id] as const;
    if (targetId === null) throw new Error('媒体关联目标无效');
    const comparison = direction < 0 ? '<' : '>';
    const order = direction < 0 ? 'DESC' : 'ASC';
    const neighbor = await transaction.getFirstAsync<{ id: number; sort_order: number }>(
      `SELECT id, sort_order FROM media_links
       WHERE ${column} = ? AND (sort_order ${comparison} ? OR (sort_order = ? AND id ${comparison} ?))
       ORDER BY sort_order ${order}, id ${order} LIMIT 1`,
      targetId,
      current.sort_order,
      current.sort_order,
      current.id,
    );
    if (!neighbor) return;
    await transaction.runAsync('UPDATE media_links SET sort_order = ? WHERE id = ?', neighbor.sort_order, current.id);
    await transaction.runAsync('UPDATE media_links SET sort_order = ? WHERE id = ?', current.sort_order, neighbor.id);
  });
}

export async function updateMediaAnnotation(db: SQLiteDatabase, mediaId: number, annotation: string) {
  await writeTransaction(db, ['media_assets'], (transaction) => transaction.runAsync(
    `UPDATE media_assets SET metadata_json = CASE
       WHEN trim(?) = '' THEN json_remove(COALESCE(metadata_json, '{}'), '$.alt')
       ELSE json_set(COALESCE(metadata_json, '{}'), '$.alt', trim(?))
     END WHERE id = ?`,
    annotation,
    annotation,
    mediaId,
  ));
}
