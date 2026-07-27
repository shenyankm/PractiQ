import { Directory, File, FileMode, Paths, type FileHandle } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as SQLite from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

import {
  assertBackupFileType,
  assertCurrentPractiqSchema,
  assertPractiqSchema,
  assertSafeArchivePath,
  assertSqliteSchemaIdentity,
  BACKUP_DATABASE_PATH,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  detectBackupKind,
  MAX_DATABASE_BYTES,
  MAX_BACKUP_ARCHIVE_BYTES,
  MAX_BACKUP_BYTES,
  MAX_BACKUP_FILES,
  MAX_MANAGED_FILE_BYTES,
  parseBackupManifest,
  PRACTIQ_APPLICATION_ID,
  PRACTIQ_CURRENT_SCHEMA,
  PRACTIQ_REQUIRED_SCHEMA,
  type BackupFileEntry,
  type BackupFileKind,
  type BackupManifest,
  type SqliteSchemaEntry,
} from '../backup';
import { SQLITE_OPEN_OPTIONS } from '../database';
import {
  invalidateDatabaseQueries,
  pauseDatabaseReads,
  pauseDatabaseWrites,
} from '../database-core';
import { DATABASE_VERSION, migrateDatabase } from '../database/migrations';
import { IMPORT_STAGE } from '../import-status';
import {
  PRACTICE_SNAPSHOT_IMMUTABILITY_TRIGGER_SQL,
  PRACTICE_SNAPSHOT_MEDIA_URIS_SQL,
  remapPracticeSnapshotMediaUris,
} from '../practice-snapshot';
import {
  copyStoredZipEntry,
  readStoredZip,
  readStoredZipEntry,
  writeStoredZip,
  type StoredZipEntry,
  type StoredZipInput,
  type StoredZipReader,
} from '../stored-zip';
import {
  deletePickerCacheCopy,
  isDirectManagedFile,
  safeName,
  withFileMaintenance,
} from './sandbox';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const expectedSchemas = new Map<number, Promise<SqliteSchemaEntry[]>>();

/** Removes restore staging directories left by a process termination. */
export async function pruneRestoreStagingDirectories() {
  return withFileMaintenance(async () => {
    try {
      for (const item of Paths.document.list()) {
        if (!(item instanceof Directory) || !/^\.practiq-restore-[a-z0-9-]+$/i.test(item.name)) continue;
        item.delete();
      }
      return true;
    } catch {
      // A later launch retries narrowly scoped staging cleanup.
      return false;
    }
  });
}

type UriRow = { uri: string };

class DatabaseRollbackError extends Error {}

function directoryFor(kind: BackupFileKind) {
  return new Directory(Paths.document, kind);
}

function assertInsideDirectory(uri: string, directory: Directory) {
  if (!isDirectManagedFile(uri, directory)) {
    throw new Error(`数据库引用了沙盒目录外的文件：${kindLabel(directory.name)}`);
  }
}

function kindLabel(kind: string) {
  return kind === 'media' ? '媒体' : '导入源文件';
}

async function validateDatabase(source: SQLiteDatabase, requireApplicationId = false) {
  const integrity = await source.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
  if (integrity?.integrity_check !== 'ok') throw new Error('备份数据库完整性检查失败');
  const version = await source.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if (!version?.user_version || version.user_version > DATABASE_VERSION) {
    throw new Error('备份版本与当前应用不兼容');
  }
  const application = await source.getFirstAsync<{ application_id: number }>('PRAGMA application_id');
  if (
    (requireApplicationId && application?.application_id !== PRACTIQ_APPLICATION_ID) ||
    (application?.application_id !== 0 && application?.application_id !== PRACTIQ_APPLICATION_ID)
  ) throw new Error('备份数据库应用标识无效');
  const actualSchema: Record<string, string[]> = {};
  const tables = [...new Set([
    ...Object.keys(PRACTIQ_REQUIRED_SCHEMA),
    ...Object.keys(PRACTIQ_CURRENT_SCHEMA),
  ])];
  for (const column of await source.getAllAsync<{ table_name: string; column_name: string }>(
    `SELECT schema.name AS table_name, columns.name AS column_name
     FROM sqlite_schema schema, pragma_table_info(schema.name) columns
     WHERE schema.type = 'table'
       AND schema.name IN (${tables.map(() => '?').join(',')})
     ORDER BY schema.name, columns.cid`,
    tables,
  )) {
    (actualSchema[column.table_name] ??= []).push(column.column_name);
  }
  assertPractiqSchema(actualSchema);
  if (version.user_version === DATABASE_VERSION) {
    const objectRows = await source.getAllAsync<{ type: string; name: string }>(
      "SELECT type, name FROM sqlite_schema WHERE type IN ('view', 'trigger', 'index')",
    );
    const actualObjects: Record<string, string[]> = {};
    for (const object of objectRows) (actualObjects[object.type] ??= []).push(object.name);
    assertCurrentPractiqSchema(actualSchema, actualObjects);
  }
  const migrations = new Set(
    (await source.getAllAsync<{ version: number }>('SELECT version FROM schema_migrations'))
      .map((migration) => migration.version),
  );
  for (let expected = 1; expected <= version.user_version; expected += 1) {
    if (!migrations.has(expected)) throw new Error('备份数据库迁移记录不完整');
  }
  const actualObjects = await schemaEntries(source);
  assertSqliteSchemaIdentity(await expectedSchema(version.user_version), actualObjects);
  const foreignKeyErrors = await source.getAllAsync('PRAGMA foreign_key_check');
  if (foreignKeyErrors.length) throw new Error('备份数据库存在损坏的关联数据');
  return version.user_version;
}

function schemaEntries(database: SQLiteDatabase) {
  return database.getAllAsync<SqliteSchemaEntry>(
    `SELECT type, name, tbl_name AS tableName, sql
     FROM sqlite_schema
     WHERE type IN ('table', 'view', 'trigger', 'index') AND sql IS NOT NULL
     ORDER BY type, name`,
  );
}

function expectedSchema(version: number) {
  const cached = expectedSchemas.get(version);
  if (cached) return cached;
  const pending = withTemporaryDatabase(`practiq-schema-v${version}`, async (database) => {
    await migrateDatabase(database, { targetVersion: version });
    return schemaEntries(database);
  }).catch((reason) => {
    expectedSchemas.delete(version);
    throw reason;
  });
  expectedSchemas.set(version, pending);
  return pending;
}

async function withTemporaryDatabase<T>(prefix: string, action: (database: SQLiteDatabase) => Promise<T>) {
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const directory = Paths.cache.uri;
  const database = await SQLite.openDatabaseAsync(name, SQLITE_OPEN_OPTIONS, directory);
  try {
    return await action(database);
  } finally {
    await database.closeAsync().catch(() => undefined);
    await SQLite.deleteDatabaseAsync(name, directory).catch(() => undefined);
  }
}

async function writeStoredEntry(
  file: File,
  reader: StoredZipReader,
  entry: StoredZipEntry,
) {
  file.create({ overwrite: true });
  const writer = file.writableStream().getWriter();
  let completed = false;
  try {
    await copyStoredZipEntry(reader, entry, (chunk) => writer.write(chunk));
    completed = true;
  } finally {
    if (completed) await writer.close();
    else await writer.abort().catch(() => undefined);
  }
}

async function withDatabaseFile<T>(
  file: File,
  action: (database: SQLiteDatabase) => Promise<T>,
) {
  const database = await SQLite.openDatabaseAsync(
    file.name,
    SQLITE_OPEN_OPTIONS,
    file.parentDirectory.uri,
  );
  try {
    return await action(database);
  } finally {
    await database.closeAsync().catch(() => undefined);
  }
}

async function withStoredDatabase<T>(
  prefix: string,
  reader: StoredZipReader,
  entry: StoredZipEntry,
  action: (database: SQLiteDatabase) => Promise<T>,
) {
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const file = new File(Paths.cache, name);
  await writeStoredEntry(file, reader, entry);
  try {
    return await withDatabaseFile(file, action);
  } finally {
    await SQLite.deleteDatabaseAsync(name, Paths.cache.uri).catch(() => undefined);
    try {
      if (file.exists) file.delete();
    } catch {
      // The cache directory can be reclaimed by the operating system.
    }
  }
}

async function withDatabaseSnapshot<T>(
  db: SQLiteDatabase,
  action: (snapshot: {
    database: File;
    references: { kind: BackupFileKind; uri: string }[];
    version: number;
  }) => Promise<T>,
) {
  return withTemporaryDatabase('practiq-export', async (snapshot) => {
    await SQLite.backupDatabaseAsync({
      sourceDatabase: db,
      sourceDatabaseName: 'main',
      destDatabase: snapshot,
      destDatabaseName: 'main',
    });
    await snapshot.execAsync(`PRAGMA application_id = ${PRACTIQ_APPLICATION_ID}`);
    const version = await validateDatabase(snapshot, true);
    await snapshot.execAsync('PRAGMA secure_delete = ON; VACUUM;');
    await snapshot.execAsync('PRAGMA wal_checkpoint(TRUNCATE)');
    const database = new File(snapshot.databasePath);
    if (!database.size || database.size > MAX_DATABASE_BYTES) {
      throw new Error('数据库超过 64 MB 本地安全上限');
    }
    const references: { kind: BackupFileKind; uri: string }[] = [];
    for (const row of await snapshot.getAllAsync<UriRow>('SELECT uri FROM media_assets ORDER BY id')) {
      references.push({ kind: 'media', uri: row.uri });
    }
    for (const row of await snapshot.getAllAsync<UriRow>(PRACTICE_SNAPSHOT_MEDIA_URIS_SQL)) {
      references.push({ kind: 'media', uri: row.uri });
    }
    for (const row of await snapshot.getAllAsync<UriRow>('SELECT stored_uri AS uri FROM question_import_jobs ORDER BY id')) {
      references.push({ kind: 'imports', uri: row.uri });
    }
    return action({ database, references, version });
  });
}

async function* byteChunks(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.byteLength; offset += 256 * 1024) {
    yield bytes.subarray(offset, offset + 256 * 1024);
  }
}

async function* fileChunks(file: File) {
  const handle = file.open(FileMode.ReadOnly);
  try {
    while (handle.offset !== null && handle.offset < file.size) {
      const value = handle.readBytes(Math.min(256 * 1024, file.size - handle.offset));
      if (!value.byteLength) throw new Error('备份源文件读取不完整');
      yield value;
    }
  } finally {
    handle.close();
  }
}

async function writeStoredZipFile(entries: readonly StoredZipInput[], destination: File) {
  const writer = destination.writableStream().getWriter();
  let completed = false;
  try {
    const size = await writeStoredZip(entries, (bytes) => writer.write(bytes));
    completed = true;
    return size;
  } finally {
    if (completed) await writer.close();
    else await writer.abort().catch(() => undefined);
  }
}

function collectBackupFiles(references: { kind: BackupFileKind; uri: string }[]) {
  const seen = new Map<string, BackupFileKind>();
  const files: { entry: BackupFileEntry; source: File }[] = [];
  let total = 0;
  for (const reference of references) {
    const existingKind = seen.get(reference.uri);
    if (existingKind) {
      if (existingKind !== reference.kind) throw new Error('数据库将同一文件同时引用为媒体和导入源文件');
      continue;
    }
    seen.set(reference.uri, reference.kind);
    const directory = directoryFor(reference.kind);
    assertInsideDirectory(reference.uri, directory);
    const source = new File(reference.uri);
    if (!source.exists || !source.size) throw new Error(`${kindLabel(reference.kind)}缺失，无法生成完整备份`);
    const archivePath = `files/${reference.kind}/${files.length}-${safeName(source.name)}`;
    files.push({
      source,
      entry: { kind: reference.kind, archivePath, originalUri: reference.uri, size: source.size },
    });
    total += source.size;
    if (files.length > MAX_BACKUP_FILES || total > MAX_MANAGED_FILE_BYTES) {
      throw new Error('媒体与导入源文件超过 64 MB 本地安全上限');
    }
  }
  return files;
}

async function createBackupArchive(db: SQLiteDatabase) {
  return withDatabaseSnapshot(db, async ({ database, references, version }) => {
    const files = collectBackupFiles(references);
    const manifest = parseBackupManifest({
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      databaseVersion: version,
      databaseSize: database.size,
      createdAt: new Date().toISOString(),
      files: files.map(({ entry }) => entry),
    });
    const total = database.size + files.reduce((sum, file) => sum + file.entry.size, 0);
    if (total > MAX_BACKUP_BYTES) throw new Error('完整备份解压后超过 128 MB 安全上限');

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('完整备份清单超过 1 MB 安全上限');
    const entries: StoredZipInput[] = [
      {
        name: 'manifest.json',
        size: manifestBytes.byteLength,
        chunks: () => byteChunks(manifestBytes),
      },
      {
        name: BACKUP_DATABASE_PATH,
        size: database.size,
        chunks: () => fileChunks(database),
      },
      ...files.map(({ entry, source }) => ({
        name: entry.archivePath,
        size: entry.size,
        chunks: () => fileChunks(source),
      })),
    ];

    const backup = new File(
      Paths.cache,
      `PractiQ-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.practiq.zip`,
    );
    backup.create({ overwrite: true });
    try {
      await writeStoredZipFile(entries, backup);
      return backup;
    } catch (error) {
      if (backup.exists) backup.delete();
      throw error;
    }
  });
}

export async function exportDatabase(db: SQLiteDatabase) {
  if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备无法打开系统分享面板');
  const backup = await withFileMaintenance(() => createBackupArchive(db));
  try {
    await Sharing.shareAsync(backup.uri, { UTI: 'public.zip-archive', mimeType: 'application/zip' });
  } finally {
    if (backup.exists) backup.delete();
  }
}

async function replaceDatabase(
  db: SQLiteDatabase,
  source: SQLiteDatabase,
  requireApplicationId = false,
  recoveryMode = false,
) {
  if (recoveryMode) {
    // The current database has already failed startup validation, so it is not a
    // usable rollback source. The selected source is fully validated first.
    await SQLite.backupDatabaseAsync({
      sourceDatabase: source,
      sourceDatabaseName: 'main',
      destDatabase: db,
      destDatabaseName: 'main',
    });
    await db.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    await validateDatabase(db, requireApplicationId);
    return;
  }
  await withTemporaryDatabase('practiq-rollback', async (rollback) => {
    await SQLite.backupDatabaseAsync({
      sourceDatabase: db,
      sourceDatabaseName: 'main',
      destDatabase: rollback,
      destDatabaseName: 'main',
    });
    try {
      await SQLite.backupDatabaseAsync({
        sourceDatabase: source,
        sourceDatabaseName: 'main',
        destDatabase: db,
        destDatabaseName: 'main',
      });
      await db.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
      await validateDatabase(db, requireApplicationId);
    } catch (reason) {
      try {
        await SQLite.backupDatabaseAsync({
          sourceDatabase: rollback,
          sourceDatabaseName: 'main',
          destDatabase: db,
          destDatabaseName: 'main',
        });
      } catch {
        throw new DatabaseRollbackError('恢复失败，且数据库自动回滚失败；请勿继续编辑并重启应用');
      }
      throw reason;
    }
  });
}

async function restoreLegacyDatabase(db: SQLiteDatabase, file: File, recoveryMode = false) {
  if (file.size > MAX_DATABASE_BYTES) throw new Error('旧版数据库备份超过 64 MB 安全上限');
  await withDatabaseFile(file, async (source) => {
    await validateDatabase(source);
    await migrateDatabase(source);
    await failRestoredAiImports(source);
    await validateDatabase(source);
    await replaceDatabase(db, source, false, recoveryMode);
  });
}

// Pending AI imports must be re-confirmed by the user after a restore before
// their document text is sent to the cloud service again.
async function failRestoredAiImports(source: SQLiteDatabase) {
  await source.runAsync(
    `UPDATE question_import_jobs
     SET status = 'failed', stage = ?,
         error = 'error:restore_ai_confirmation',
         next_retry_at = NULL, finished_at = CURRENT_TIMESTAMP
     WHERE parser = 'ai' AND status IN ('queued', 'running', 'retry_wait')`,
    IMPORT_STAGE.restoreAiConfirmation,
  );
}

function readerForHandle(handle: FileHandle, size: number): StoredZipReader {
  return {
    size,
    read: (offset, length) => {
      if (handle.offset === null) throw new Error('备份文件已经关闭');
      handle.offset = offset;
      return handle.readBytes(length);
    },
  };
}

function loadBackupBundle(reader: StoredZipReader) {
  const entries = readStoredZip(reader);
  if (entries.size > MAX_BACKUP_FILES + 2) throw new Error('备份压缩包文件过多');
  let declaredTotal = 0;
  for (const entry of entries.values()) {
    assertSafeArchivePath(entry.name);
    declaredTotal += entry.size;
    if (declaredTotal > MAX_BACKUP_BYTES + MAX_MANIFEST_BYTES) {
      throw new Error('备份解压后超过 128 MB 安全上限');
    }
  }
  const manifestEntry = entries.get('manifest.json');
  const databaseEntry = entries.get(BACKUP_DATABASE_PATH);
  if (!manifestEntry || !databaseEntry || manifestEntry.size > MAX_MANIFEST_BYTES) {
    throw new Error('PractiQ 备份缺少有效清单或数据库');
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      readStoredZipEntry(reader, manifestEntry),
    ));
  } catch {
    throw new Error('PractiQ 备份清单无法读取');
  }
  const manifest = parseBackupManifest(manifestValue);
  if (manifest.databaseVersion > DATABASE_VERSION || databaseEntry.size !== manifest.databaseSize) {
    throw new Error('备份数据库版本或大小与清单不一致');
  }
  const expected = new Set(['manifest.json', BACKUP_DATABASE_PATH, ...manifest.files.map((file) => file.archivePath)]);
  if ([...entries.keys()].some((name) => !expected.has(name)) || entries.size !== expected.size) {
    throw new Error('备份压缩包包含未在清单登记的文件');
  }
  for (const file of manifest.files) {
    const entry = entries.get(file.archivePath);
    if (!entry || entry.size !== file.size) throw new Error('备份文件大小与清单不一致');
  }
  return { entries, manifest, databaseEntry };
}

function restoredFileName(file: BackupFileEntry, restoreId: string) {
  return `${restoreId}-${file.archivePath.slice(file.archivePath.lastIndexOf('/') + 1)}`;
}

async function remapBundleUris(source: SQLiteDatabase, manifest: BackupManifest, restoreId: string) {
  const mediaDestinations = new Map(
    manifest.files
      .filter((file) => file.kind === 'media')
      .map((file) => [
        file.originalUri,
        new File(Paths.document, file.kind, restoredFileName(file, restoreId)).uri,
      ]),
  );
  const importDestinations = new Map(
    manifest.files
      .filter((file) => file.kind === 'imports')
      .map((file) => [
        file.originalUri,
        new File(Paths.document, file.kind, restoredFileName(file, restoreId)).uri,
      ]),
  );
  const media = await source.getAllAsync<UriRow>('SELECT uri FROM media_assets');
  const snapshotMedia = await source.getAllAsync<UriRow>(PRACTICE_SNAPSHOT_MEDIA_URIS_SQL);
  const mediaReferences = new Set([...media, ...snapshotMedia].map((row) => row.uri));
  const jobs = await source.getAllAsync<UriRow>('SELECT stored_uri AS uri FROM question_import_jobs');
  if (
    [...media, ...snapshotMedia].some((row) => !mediaDestinations.has(row.uri)) ||
    jobs.some((row) => !importDestinations.has(row.uri)) ||
    manifest.files.some((file) => file.kind === 'media' && !mediaReferences.has(file.originalUri))
  ) {
    throw new Error('完整备份缺少数据库引用的媒体或导入源文件');
  }
  await source.withTransactionAsync(async () => {
    for (const file of manifest.files) {
      if (file.kind === 'media') {
        const destination = mediaDestinations.get(file.originalUri)!;
        await source.runAsync('UPDATE media_assets SET uri = ? WHERE uri = ?', destination, file.originalUri);
      } else {
        const destination = importDestinations.get(file.originalUri)!;
        const job = await source.runAsync(
          'UPDATE question_import_jobs SET stored_uri = ? WHERE stored_uri = ?',
          destination,
          file.originalUri,
        );
        if (job.changes < 1) throw new Error('导入源文件清单与数据库不一致');
      }
    }
    await source.execAsync('DROP TRIGGER IF EXISTS practice_session_question_snapshot_is_immutable');
    let sessionId = -1;
    let questionId = -1;
    while (true) {
      const snapshots = await source.getAllAsync<{
        session_id: number;
        question_id: number;
        snapshot_json: string;
      }>(
        `SELECT session_id, question_id, snapshot_json
         FROM practice_session_questions
         WHERE session_id > ? OR (session_id = ? AND question_id > ?)
         ORDER BY session_id, question_id LIMIT 200`,
        sessionId,
        sessionId,
        questionId,
      );
      if (!snapshots.length) break;
      for (const snapshot of snapshots) {
        const remapped = remapPracticeSnapshotMediaUris(snapshot.snapshot_json, mediaDestinations);
        if (remapped !== snapshot.snapshot_json) {
          const result = await source.runAsync(
            `UPDATE practice_session_questions SET snapshot_json = ?
             WHERE session_id = ? AND question_id = ?`,
            remapped,
            snapshot.session_id,
            snapshot.question_id,
          );
          if (result.changes !== 1) throw new Error('练习快照与数据库不一致');
        }
        sessionId = snapshot.session_id;
        questionId = snapshot.question_id;
      }
    }
    await source.execAsync(PRACTICE_SNAPSHOT_IMMUTABILITY_TRIGGER_SQL);
    await source.runAsync('UPDATE question_import_jobs SET source_uri = stored_uri');
  });
}

async function installSandboxAndDatabase(
  db: SQLiteDatabase,
  source: SQLiteDatabase,
  staging: Directory,
  manifest: BackupManifest,
  restoreId: string,
  recoveryMode: boolean,
) {
  const installed: File[] = [];
  try {
    for (const file of manifest.files) {
      const directory = directoryFor(file.kind);
      directory.create({ idempotent: true, intermediates: true });
      const staged = new File(staging, file.kind, restoredFileName(file, restoreId));
      const destination = new File(directory, staged.name);
      if (destination.exists) throw new Error('恢复目标文件已存在，请重试');
      await staged.move(directory);
      installed.push(destination);
    }
    await replaceDatabase(db, source, true, recoveryMode);
  } catch (reason) {
    if (!(reason instanceof DatabaseRollbackError)) {
      for (const file of installed) {
        try {
          if (file.exists) file.delete();
        } catch {
          // The old database and old files are still authoritative after rollback.
        }
      }
    }
    throw reason;
  }

  const keep = new Set(installed.map((file) => file.uri));
  for (const kind of ['media', 'imports'] as const) {
    try {
      for (const item of directoryFor(kind).list()) {
        if (item instanceof Directory || (item instanceof File && !keep.has(item.uri))) item.delete();
      }
    } catch {
      // Once SQLite commits, leftover old files are harmless orphans and must not turn success into a false failure.
    }
  }
}

async function restoreBackupBundle(db: SQLiteDatabase, archive: File, recoveryMode = false) {
  const handle = archive.open(FileMode.ReadOnly);
  try {
    const reader = readerForHandle(handle, archive.size);
    const { entries, manifest, databaseEntry } = loadBackupBundle(reader);
    if (detectBackupKind(reader.read(databaseEntry.dataOffset, Math.min(16, databaseEntry.size))) !== 'legacy') {
      throw new Error('备份中的数据库头无效');
    }
    const restoreId = `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    await withStoredDatabase('practiq-bundle-restore', reader, databaseEntry, async (source) => {
      const staging = new Directory(Paths.document, `.practiq-restore-${restoreId}`);
      staging.create({ intermediates: true });
      new Directory(staging, 'media').create();
      new Directory(staging, 'imports').create();
      try {
        const version = await validateDatabase(source, true);
        if (version !== manifest.databaseVersion) throw new Error('备份数据库版本与清单不一致');
        await migrateDatabase(source);
        await failRestoredAiImports(source);
        await remapBundleUris(source, manifest, restoreId);
        await validateDatabase(source, true);
        for (const file of manifest.files) {
          const entry = entries.get(file.archivePath);
          if (!entry) throw new Error('备份文件大小与清单不一致');
          const destination = new File(staging, file.kind, restoredFileName(file, restoreId));
          await writeStoredEntry(destination, reader, entry);
        }
        await installSandboxAndDatabase(db, source, staging, manifest, restoreId, recoveryMode);
      } finally {
        try {
          if (staging.exists) staging.delete();
        } catch {
          // Staging cleanup is best effort after the validated restore path.
        }
      }
    });
  } finally {
    handle.close();
  }
}

export async function restoreDatabase(
  db: SQLiteDatabase,
  options: { recoveryMode?: boolean } = {},
): Promise<false | 'bundle' | 'legacy'> {
  if (!options.recoveryMode) {
    const activeImport = await db.getFirstAsync<{ count: number }>(
      "SELECT COUNT(*) AS count FROM question_import_jobs WHERE status IN ('queued', 'running', 'retry_wait')",
    );
    if (activeImport?.count) throw new Error('请先等待或取消正在排队的导入任务，再恢复备份');
  }
  const result = await File.pickFileAsync({
    mimeTypes: [
      'application/zip',
      'application/x-zip',
      'application/x-zip-compressed',
      'application/x-sqlite3',
      'application/vnd.sqlite3',
      'application/octet-stream',
    ],
  });
  if (result.canceled) return false;
  const selected = result.result;
  const selectedSize = selected.size;
  if (!selected.exists || !selectedSize || selectedSize > MAX_BACKUP_ARCHIVE_BYTES) {
    throw new Error('备份文件无效或超过 130 MB');
  }
  const source = new File(
    Paths.cache,
    `PractiQ-restore-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.backup`,
  );
  try {
    await selected.copy(source);
    const size = source.size;
    if (!size || size !== selectedSize || size > MAX_BACKUP_ARCHIVE_BYTES) {
      throw new Error('备份文件复制不完整或超过 130 MB');
    }
    const handle = source.open(FileMode.ReadOnly);
    let header: Uint8Array;
    try {
      header = handle.readBytes(Math.min(16, size));
    } finally {
      handle.close();
    }
    const kind = detectBackupKind(header);
    assertBackupFileType(selected.name, selected.type, kind);
    return await withFileMaintenance(async () => {
      const { quiesceCloudRequests } = await import('../cloud');
      const resumeCloudRequests = await quiesceCloudRequests();
      try {
        const { quiesceImportRuntime } = await import('../features/imports/runtime');
        const resumeImportRuntime = await quiesceImportRuntime();
        const resumeDatabaseReads = await pauseDatabaseReads();
        const resumeDatabaseWrites = await pauseDatabaseWrites();
        try {
          if (kind === 'legacy') await restoreLegacyDatabase(db, source, Boolean(options.recoveryMode));
          else await restoreBackupBundle(db, source, Boolean(options.recoveryMode));
          invalidateDatabaseQueries();
          return kind;
        } finally {
          resumeDatabaseWrites();
          resumeDatabaseReads();
          resumeImportRuntime();
        }
      } finally {
        resumeCloudRequests();
      }
    });
  } finally {
    deletePickerCacheCopy(source);
  }
}
