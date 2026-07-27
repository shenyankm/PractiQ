import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  assertBackupFileType,
  assertCurrentPractiqSchema,
  assertManagedFileCapacity,
  assertPractiqSchema,
  assertSafeArchivePath,
  assertSqliteSchemaIdentity,
  backupCrc32,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  detectBackupKind,
  MAX_BACKUP_FILES,
  MAX_DATABASE_BYTES,
  parseBackupManifest,
  PRACTIQ_CURRENT_OBJECTS,
  PRACTIQ_CURRENT_SCHEMA,
  PRACTIQ_REQUIRED_SCHEMA,
  MAX_MANAGED_FILE_BYTES,
  finishBackupCrc32,
  type SqliteSchemaEntry,
  updateBackupCrc32,
} from './backup';
import { migrateDatabase } from './database/migrations';
import { expoDatabase } from './test-database';

test('backup CRC32 matches the ZIP checksum standard vector', () => {
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(backupCrc32(bytes) >>> 0, 0xcbf43926);

  const changed = bytes.slice();
  changed[0] ^= 1;
  assert.notEqual(backupCrc32(changed), backupCrc32(bytes));

  const state = updateBackupCrc32(updateBackupCrc32(-1, bytes.slice(0, 4)), bytes.slice(4));
  assert.equal(finishBackupCrc32(state), backupCrc32(bytes));
});

test('backup boundary validation rejects spoofed and traversing input', () => {
  const sqlite = new TextEncoder().encode('SQLite format 3\0rest');
  const zip = new Uint8Array([0x50, 0x4b, 3, 4]);
  assert.equal(detectBackupKind(sqlite), 'legacy');
  assert.equal(detectBackupKind(zip), 'bundle');
  assert.doesNotThrow(() => assertBackupFileType('copy.practiq.zip', 'application/zip', 'bundle'));
  assert.doesNotThrow(() => assertBackupFileType('opaque-provider-id', 'application/zip', 'bundle'));
  assert.throws(() => assertBackupFileType('copy.txt', 'application/zip', 'bundle'));
  for (const path of [
    'files/media/../../database.sqlite',
    '/files/media/photo.png',
    'files\\media\\photo.png',
    'files//photo.png',
    'files/./photo.png',
    'files/media/\u0000photo.png',
  ]) assert.throws(() => assertSafeArchivePath(path), /不安全/, path);

  const manifest = parseBackupManifest({
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    databaseVersion: 1,
    databaseSize: 4096,
    createdAt: '2026-07-15T00:00:00.000Z',
    files: [{
      kind: 'media',
      archivePath: 'files/media/0-photo.png',
      originalUri: 'file:///sandbox/media/photo.png',
      size: 12,
    }],
  });
  assert.equal(manifest.files[0].size, 12);
  assert.throws(() => parseBackupManifest({
    ...manifest,
    files: [...manifest.files, { ...manifest.files[0], archivePath: 'files/media/1-photo.png' }],
  }));
});

test('backup manifest rejects oversized, excessive, and mismatched declarations', () => {
  const base = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    databaseVersion: 15,
    databaseSize: 4096,
    createdAt: '2026-07-15T00:00:00.000Z',
    files: [],
  };
  assert.throws(() => parseBackupManifest({ ...base, databaseSize: MAX_DATABASE_BYTES + 1 }), /清单无效/);
  assert.throws(() => parseBackupManifest({ ...base, createdAt: 'not-a-date' }), /清单无效/);
  assert.throws(() => parseBackupManifest({
    ...base,
    files: [{
      kind: 'media',
      archivePath: 'files/imports/photo.png',
      originalUri: 'file:///sandbox/media/photo.png',
      size: 1,
    }],
  }), /路径无效/);
  assert.throws(() => parseBackupManifest({
    ...base,
    files: [
      {
        kind: 'media',
        archivePath: 'files/media/a.png',
        originalUri: 'file:///sandbox/media/a.png',
        size: MAX_MANAGED_FILE_BYTES / 2 + 1,
      },
      {
        kind: 'media',
        archivePath: 'files/media/b.png',
        originalUri: 'file:///sandbox/media/b.png',
        size: MAX_MANAGED_FILE_BYTES / 2 + 1,
      },
    ],
  }), /超过 64 MB/);
  assert.throws(() => parseBackupManifest({
    ...base,
    files: Array.from({ length: MAX_BACKUP_FILES + 1 }, () => ({})),
  }), /清单无效/);
});

test('schema identity rejects unrelated or incomplete SQLite layouts', () => {
  const complete = Object.fromEntries(
    Object.entries(PRACTIQ_REQUIRED_SCHEMA).map(([table, columns]) => [table, [...columns]]),
  );
  assert.doesNotThrow(() => assertPractiqSchema(complete));
  assert.equal(Object.hasOwn(PRACTIQ_REQUIRED_SCHEMA, 'artifacts'), false);
  assert.throws(() => assertPractiqSchema({ unrelated_table: ['id'] }));
  assert.throws(() => assertPractiqSchema({ ...complete, question_import_jobs: ['id', 'status'] }));
});

test('current schema identity requires practice snapshots and integrity objects', () => {
  const schema = Object.fromEntries(
    Object.entries(PRACTIQ_CURRENT_SCHEMA).map(([table, columns]) => [table, [...columns]]),
  );
  const objects = Object.fromEntries(
    Object.entries(PRACTIQ_CURRENT_OBJECTS).map(([type, names]) => [type, [...names]]),
  );
  assert.doesNotThrow(() => assertCurrentPractiqSchema(schema, objects));
  assert.deepEqual(PRACTIQ_CURRENT_SCHEMA.question_import_jobs, [
    'ai_profile',
    'ai_profile_revision',
    'source_mime_type',
    'source_size',
    'source_metadata_json',
  ]);
  assert.deepEqual(PRACTIQ_CURRENT_SCHEMA.learning_reports, ['id', 'report', 'created_at']);
  assert.ok(PRACTIQ_CURRENT_OBJECTS.view.includes('question_stats'));
  assert.ok(PRACTIQ_CURRENT_OBJECTS.view.includes('bank_stats'));
  assert.throws(() => assertCurrentPractiqSchema({ practice_session_questions: [] }, objects), /数据列/);
  assert.throws(() => assertCurrentPractiqSchema(schema, { ...objects, view: [] }), /view/);
  assert.throws(() => assertCurrentPractiqSchema(schema, { ...objects, trigger: [] }), /trigger/);
});

test('managed sandbox quota keeps every valid data set inside full-backup capacity', () => {
  assert.doesNotThrow(() => assertManagedFileCapacity(MAX_MANAGED_FILE_BYTES - 1, 1));
  assert.throws(() => assertManagedFileCapacity(MAX_MANAGED_FILE_BYTES, 1), /64 MB/);
});

test('schema identity rejects renamed, extra, and no-op database objects', () => {
  const expected = [{ type: 'trigger', name: 'guard', tableName: 'questions', sql: 'CREATE TRIGGER guard BEFORE DELETE ON questions BEGIN SELECT RAISE(ABORT); END' }];
  assert.doesNotThrow(() => assertSqliteSchemaIdentity(expected, [{ ...expected[0], sql: 'CREATE  TRIGGER guard BEFORE DELETE ON questions BEGIN SELECT RAISE(ABORT); END' }]));
  assert.throws(() => assertSqliteSchemaIdentity(expected, [{ ...expected[0], sql: 'CREATE TRIGGER guard BEFORE DELETE ON questions BEGIN SELECT 1; END' }]), /不可信/);
  assert.throws(() => assertSqliteSchemaIdentity(expected, []), /未知或缺失/);
});

test('schema identity accepts the released import-stage default', () => {
  const expected = [{
    type: 'table',
    name: 'question_import_jobs',
    tableName: 'question_import_jobs',
    sql: "CREATE TABLE question_import_jobs (stage TEXT NOT NULL DEFAULT 'stage:queued', status TEXT NOT NULL)",
  }];
  assert.doesNotThrow(() => assertSqliteSchemaIdentity(expected, [{
    ...expected[0],
    sql: "CREATE TABLE question_import_jobs (stage TEXT NOT NULL DEFAULT '等待处理', status TEXT NOT NULL)",
  }]));
  assert.throws(() => assertSqliteSchemaIdentity(expected, [{
    ...expected[0],
    sql: "CREATE TABLE question_import_jobs (stage TEXT NOT NULL DEFAULT 'stage:queued', status TEXT)",
  }]), /不可信/);
});

test('schema identity detects a tampered current aggregate view', async () => {
  const sqlite = new DatabaseSync(':memory:');
  await migrateDatabase(expoDatabase(sqlite));
  const entries = () => sqlite.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'view', 'trigger', 'index') AND sql IS NOT NULL
    ORDER BY type, name
  `).all() as unknown as SqliteSchemaEntry[];
  const expected = entries();

  sqlite.exec(`
    DROP VIEW question_stats;
    CREATE VIEW question_stats AS
    SELECT id AS question_id, 0 AS attempts, 0 AS correct_count,
      0 AS incorrect_count, NULL AS last_answered_at
    FROM questions
  `);

  assert.throws(() => assertSqliteSchemaIdentity(expected, entries()), /不可信.*question_stats/);
  sqlite.close();
});
