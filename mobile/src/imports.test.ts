import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import JSZip from 'jszip';

import {
  assertImportFileSize,
  DOCX_MIME_TYPE,
  extractDocx,
  inspectImportBytes,
  MAX_IMPORT_BYTES,
  normalizeQuestions,
} from './features/imports/parser';
import {
  cancelImport,
  importRequestController,
  PENDING_IMPORTS_SQL,
  queueImport,
  quiesceImportRuntime,
  resumePendingImports,
  retryImport,
  setImportOutputNeedsReview,
} from './features/imports/runtime';
import {
  QUESTION_IMPORT_SOURCE_MIGRATION_SQL,
} from './database/migrations';
import { IMPORT_STAGE } from './import-status';
import { expoDatabase } from './test-database';

function importSourceDatabase(setup: string) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE question_import_jobs (
      id INTEGER PRIMARY KEY,
      stored_uri TEXT NOT NULL
    );
    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      uri TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      metadata_json TEXT
    );
    ${setup}
  `);
  return sqlite;
}

function migrateImportSources(sqlite: DatabaseSync) {
  sqlite.exec('BEGIN');
  try {
    sqlite.exec(QUESTION_IMPORT_SOURCE_MIGRATION_SQL);
    sqlite.exec('COMMIT');
  } catch (reason) {
    sqlite.exec('ROLLBACK');
    throw reason;
  }
}

test('validates import extension, MIME, header and text encoding together', () => {
  assert.throws(() => assertImportFileSize(0), /空文件/);
  assert.throws(() => assertImportFileSize(MAX_IMPORT_BYTES + 1), /25 MB/);
  const text = new TextEncoder().encode('1. 题目\n答案：正确');
  assert.equal(inspectImportBytes({ name: '题库.txt', mimeType: 'text/plain', bytes: text }).text, '1. 题目\n答案：正确');
  assert.equal(inspectImportBytes({
    name: '题库.docx',
    mimeType: DOCX_MIME_TYPE,
    bytes: Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
    size: 10_000,
  }).size, 10_000);
  assert.throws(
    () => inspectImportBytes({ name: '伪装.docx', mimeType: DOCX_MIME_TYPE, bytes: text }),
    /文件头无效/,
  );
  assert.throws(
    () => inspectImportBytes({ name: '题库.txt', mimeType: DOCX_MIME_TYPE, bytes: text }),
    /MIME 类型.*不一致/,
  );
});

test('rejects empty, partial, binary, and malformed TXT input', () => {
  const inspect = (bytes: Uint8Array, size = bytes.byteLength) => inspectImportBytes({
    name: '题库.txt',
    mimeType: 'text/plain',
    bytes,
    size,
  });
  assert.throws(() => inspect(new TextEncoder().encode(' \n\t ')), /没有可解析文本/);
  assert.throws(() => inspect(Uint8Array.of(0x61, 0, 0x62)), /二进制内容/);
  assert.throws(() => inspect(Uint8Array.of(0xc3, 0x28)), /UTF-8.*UTF-16/);
  assert.throws(() => inspect(Uint8Array.of(0xff, 0xfe, 0x41)), /编码无效/);
  assert.throws(() => inspect(new TextEncoder().encode('题目'), 100), /读取不完整/);
  assert.throws(
    () => inspectImportBytes({
      name: `${'x'.repeat(256)}.txt`,
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode('题目'),
    }),
    /文件名无效或过长/,
  );
});

test('keeps the AI import question limit aligned with the AI response schema', () => {
  const questions = Array.from({ length: 201 }, (_, index) => ({
    stem: `判断题 ${index + 1}`,
    type: 'true_false' as const,
    options: [],
    answer: { values: ['true'] },
    explanation: '',
    confidence: 1,
  }));
  assert.throws(() => normalizeQuestions(questions, 'ai'), /200 道题/);
  assert.doesNotThrow(() => normalizeQuestions(questions, 'local'));
});

test('normalizes local and AI questions at the shared persistence boundary', () => {
  const question = {
    stem: ' 2 + 2 = ? ',
    type: 'single_choice' as const,
    options: [
      { label: 'a', content: ' 4 ', sort_order: 9 },
      { label: 'A', content: 'duplicate', sort_order: 10 },
      { label: 'b', content: ' 5 ', sort_order: 11 },
    ],
    answer: { values: ['A'] },
    explanation: ' explanation ',
    confidence: 2,
  };
  const [ai] = normalizeQuestions([question], 'ai');
  assert.deepEqual(ai.options, [
    { label: 'A', content: '4', sort_order: 0 },
    { label: 'B', content: '5', sort_order: 1 },
  ]);
  assert.equal(ai.stem, '2 + 2 = ?');
  assert.equal(ai.explanation, 'explanation');
  assert.equal(ai.confidence, 1);
  assert.deepEqual(ai.metadata, { parser: 'ai', fallback: false });
  assert.deepEqual(normalizeQuestions([question], 'local')[0].metadata, {
    parser: 'local',
    fallback: true,
  });
  assert.throws(
    () => normalizeQuestions([{ ...question, stem: 'x'.repeat(20_001) }], 'ai'),
    /题干过长/,
  );
});

test('extracts bounded DOCX text locally', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', `
    <w:document><w:body>
      <w:p><w:r><w:t>1. 写出 H2O 的名称</w:t></w:r></w:p>
      <w:p><m:oMath><m:r><m:t>E=mc²</m:t></m:r></m:oMath></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格值</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:t>答案：水</w:t></w:r></w:p>
    </w:body></w:document>`);
  zip.file('word/charts/chart1.xml', '<c:chart><c:v>42</c:v></c:chart>');
  zip.file('word/media/image1.png', new Uint8Array([137, 80, 78, 71]));

  const result = await extractDocx(await zip.generateAsync({ type: 'uint8array' }));
  assert.match(result, /H2O/);
  assert.match(result, /E=mc²/);
  assert.match(result, /表格值/);
});

test('rejects malformed and excessive-entry DOCX archives', async () => {
  const wrongType = new JSZip();
  wrongType.file('[Content_Types].xml', '<Types />');
  wrongType.file('word/document.xml', '<w:document><w:p><w:r><w:t>题目</w:t></w:r></w:p></w:document>');
  await assert.rejects(
    extractDocx(await wrongType.generateAsync({ type: 'uint8array' })),
    /内容类型不是 DOCX/,
  );

  const empty = new JSZip();
  empty.file('[Content_Types].xml', 'wordprocessingml.document.main+xml');
  empty.file('word/document.xml', '<w:document><w:body /></w:document>');
  await assert.rejects(
    extractDocx(await empty.generateAsync({ type: 'uint8array' })),
    /没有可解析文本/,
  );

  const excessive = new JSZip();
  for (let index = 0; index <= 5_000; index += 1) excessive.file(`entries/${index}.xml`, '');
  await assert.rejects(
    extractDocx(await excessive.generateAsync({ type: 'uint8array', compression: 'STORE' })),
    /包含过多文件/,
  );
});

test('v11 migration backfills import source columns and drops artifacts', () => {
  const sqlite = importSourceDatabase(`
    INSERT INTO question_import_jobs VALUES (1, 'file:///imports/source.txt');
    INSERT INTO artifacts VALUES (
      7, 1, 'source', 'file:///imports/source.txt', 'text/plain', 17,
      '{"parsedTextCharacters":17}'
    );
  `);

  migrateImportSources(sqlite);

  const source = sqlite.prepare(`
    SELECT source_mime_type, source_size, source_metadata_json
    FROM question_import_jobs WHERE id = 1
  `).get();
  assert.equal(source?.source_mime_type, 'text/plain');
  assert.equal(source?.source_size, 17);
  assert.equal(source?.source_metadata_json, '{"parsedTextCharacters":17}');
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'artifacts'").get()?.count,
    0,
  );
  sqlite.close();
});

test('v11 migration rolls back instead of dropping inconsistent artifacts', () => {
  const cases = new Map([
    ['missing source', `INSERT INTO question_import_jobs VALUES (1, 'file:///imports/source.txt');`],
    ['duplicate source', `
      INSERT INTO question_import_jobs VALUES (1, 'file:///imports/source.txt');
      INSERT INTO artifacts VALUES
        (1, 1, 'source', 'file:///imports/source.txt', 'text/plain', 1, NULL),
        (2, 1, 'source', 'file:///imports/source.txt', 'text/plain', 1, NULL);
    `],
    ['mismatched URI', `
      INSERT INTO question_import_jobs VALUES (1, 'file:///imports/source.txt');
      INSERT INTO artifacts VALUES (1, 1, 'source', 'file:///imports/other.txt', 'text/plain', 1, NULL);
    `],
    ['non-source artifact', `
      INSERT INTO question_import_jobs VALUES (1, 'file:///imports/source.txt');
      INSERT INTO artifacts VALUES
        (1, 1, 'source', 'file:///imports/source.txt', 'text/plain', 1, NULL),
        (2, 1, 'preview', 'file:///imports/preview.txt', 'text/plain', 1, NULL);
    `],
    ['orphan artifact', `
      INSERT INTO question_import_jobs VALUES (1, 'file:///imports/source.txt');
      INSERT INTO artifacts VALUES
        (1, 1, 'source', 'file:///imports/source.txt', 'text/plain', 1, NULL),
        (2, 99, 'source', 'file:///imports/orphan.txt', 'text/plain', 1, NULL);
    `],
  ]);

  for (const [name, setup] of cases) {
    const sqlite = importSourceDatabase(setup);
    assert.throws(() => migrateImportSources(sqlite), /CHECK constraint failed/, name);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'artifacts'").get()?.count,
      1,
      name,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('question_import_jobs') WHERE name = 'source_size'").get()?.count,
      0,
      name,
    );
    sqlite.close();
  }
});

test('an import request starts aborted when cancellation wins the send race', () => {
  assert.equal(importRequestController(false).signal.aborted, false);
  assert.equal(importRequestController(true).signal.aborted, true);
});

test('resume selection does not strand pending jobs after an arbitrary first page', () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE question_import_jobs (
      id INTEGER PRIMARY KEY, status TEXT, next_retry_at TEXT, created_at TEXT
    );
    WITH RECURSIVE jobs(id) AS (VALUES(1) UNION ALL SELECT id + 1 FROM jobs WHERE id < 101)
    INSERT INTO question_import_jobs(id, status, created_at)
    SELECT id, CASE WHEN id % 2 THEN 'queued' ELSE 'retry_wait' END, printf('%03d', id) FROM jobs;
  `);
  assert.equal(sqlite.prepare(PENDING_IMPORTS_SQL).all().length, 101);
  sqlite.close();
});

test('quiescing import runtime clears stale job identities before database restore', async () => {
  let reads = 0;
  const database = {
    getFirstAsync: async () => {
      reads += 1;
      return null;
    },
  } as unknown as Parameters<typeof queueImport>[0];
  queueImport(database, 42);
  const resume = await quiesceImportRuntime();
  queueImport(database, 42);
  assert.equal(reads, 1);
  resume();
  queueImport(database, 42);
  const resumeAgain = await quiesceImportRuntime();
  resumeAgain();
  assert.equal(reads, 2);
});

test('a queue request made while a job is running is not stranded', async () => {
  let releaseFirst!: () => void;
  let markSecondStarted!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  let reads = 0;
  const database = {
    getFirstAsync: async () => {
      reads += 1;
      if (reads === 1) await firstBlocked;
      else markSecondStarted();
      return null;
    },
  } as unknown as Parameters<typeof queueImport>[0];

  queueImport(database, 42);
  await new Promise((resolve) => setTimeout(resolve, 0));
  queueImport(database, 42);
  releaseFirst();
  await secondStarted;
  const resume = await quiesceImportRuntime();
  resume();
  assert.equal(reads, 2);
});

test('a stale resume query cannot recreate retry work across database restore', async () => {
  let finishQuery!: (rows: { id: number; status: 'retry_wait'; next_retry_at: string }[]) => void;
  let jobReads = 0;
  const rows = new Promise<{ id: number; status: 'retry_wait'; next_retry_at: string }[]>((resolve) => {
    finishQuery = resolve;
  });
  const database = {
    getAllAsync: async () => rows,
    getFirstAsync: async () => {
      jobReads += 1;
      return null;
    },
  } as unknown as Parameters<typeof resumePendingImports>[0];

  const pendingResume = resumePendingImports(database);
  const release = await quiesceImportRuntime();
  finishQuery([{ id: 77, status: 'retry_wait', next_retry_at: new Date(Date.now() + 10).toISOString() }]);
  await pendingResume;
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(jobReads, 0);
});

test('persists clearing and reopening an import output review flag', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE outputs (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL,
      needs_review INTEGER NOT NULL CHECK (needs_review IN (0, 1))
    );
    INSERT INTO outputs(id, job_id, needs_review) VALUES (7, 3, 1);
  `);
  const db = expoDatabase(sqlite);

  await setImportOutputNeedsReview(db, 3, 7, false);
  assert.equal(sqlite.prepare('SELECT needs_review FROM outputs WHERE id = 7').get()?.needs_review, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM outputs WHERE needs_review = 1').get()?.count, 0);
  await setImportOutputNeedsReview(db, 3, 7, true);
  assert.equal(sqlite.prepare('SELECT needs_review FROM outputs WHERE id = 7').get()?.needs_review, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM outputs WHERE needs_review = 1').get()?.count, 1);
  await assert.rejects(setImportOutputNeedsReview(db, 4, 7, false), /不存在/);
});

test('cancel and retry preserve the persisted import state machine', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE question_import_jobs (
      id INTEGER PRIMARY KEY,
      parser TEXT NOT NULL,
      ai_profile TEXT,
      ai_profile_revision INTEGER,
      file_name TEXT NOT NULL,
      source_size INTEGER NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL,
      stage TEXT NOT NULL,
      retry_count INTEGER NOT NULL,
      next_retry_at TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT
    );
    INSERT INTO question_import_jobs VALUES
      (1, 'local', NULL, NULL, 'queued.txt', 10, 'queued', 0, 'stage:queued', 0, NULL, NULL, NULL, NULL),
      (2, 'local', NULL, NULL, 'failed.txt', 10, 'failed', 80, 'stage:failed', 2, 'soon', 'boom', 'old', 'old'),
      (3, 'local', NULL, NULL, 'done.txt', 10, 'completed', 100, 'stage:completed:1', 0, NULL, NULL, 'old', 'old'),
      (4, 'ai', NULL, NULL, 'ai.txt', 10, 'failed', 0, 'stage:failed', 0, NULL, NULL, NULL, 'old');
  `);
  const db = expoDatabase(sqlite);
  const resume = await quiesceImportRuntime();
  try {
    await cancelImport(db, 1);
    assert.deepEqual(
      { ...sqlite.prepare(`
        SELECT status, stage, error, next_retry_at, finished_at IS NOT NULL AS finished
        FROM question_import_jobs WHERE id = 1
      `).get() },
      {
        status: 'cancelled',
        stage: IMPORT_STAGE.cancelled,
        error: null,
        next_retry_at: null,
        finished: 1,
      },
    );
    await cancelImport(db, 3);
    assert.equal(sqlite.prepare('SELECT status FROM question_import_jobs WHERE id = 3').get()?.status, 'completed');

    assert.equal(await retryImport(db, 2), true);
    assert.deepEqual(
      { ...sqlite.prepare(`
        SELECT status, progress, stage, retry_count, next_retry_at, error, started_at, finished_at
        FROM question_import_jobs WHERE id = 2
      `).get() },
      {
        status: 'queued',
        progress: 0,
        stage: IMPORT_STAGE.manualRetry,
        retry_count: 0,
        next_retry_at: null,
        error: null,
        started_at: null,
        finished_at: null,
      },
    );
    await assert.rejects(retryImport(db, 3), /当前任务不可重试/);
    await assert.rejects(retryImport(db, 4), /确认数据传输/);
  } finally {
    resume();
    sqlite.close();
  }
});
