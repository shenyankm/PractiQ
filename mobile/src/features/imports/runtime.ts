import type { SQLiteDatabase, SQLiteStatement } from 'expo-sqlite';

import { assertManagedFileCapacity } from '../../backup';
import { writeTransaction } from '../../database-core';
import {
  IMPORT_STAGE,
  importCompletedStage,
  importRetryStage,
  importWritingStage,
} from '../../import-status';
import { parsePlainText } from '../../logic';
import type { ParsedQuestion } from '../../types';
import {
  assertImportFileSize,
  expectedMimeType,
  extractDocx,
  importFileTypeFromName,
  IMPORT_MIME_TYPES,
  inspectImportBytes,
  MAX_AI_DOCUMENT_CHARACTERS,
  MAX_FIELD_CHARACTERS,
  normalizeQuestions,
  type ImportFileType,
} from './parser';

export const MAX_AUTO_RETRIES = 3;
export const PENDING_IMPORTS_SQL = `
  SELECT id, status, next_retry_at FROM question_import_jobs
  WHERE status IN ('queued', 'retry_wait') ORDER BY created_at, id`;

const REVIEW_THRESHOLD = 0.75;
const MAX_AI_TEXT_BYTES = MAX_AI_DOCUMENT_CHARACTERS * 4 + 2;

function assertAiDocumentLength(text: string) {
  if (text.trim().length > MAX_AI_DOCUMENT_CHARACTERS) {
    throw new Error(`AI 解析文档不能超过 ${MAX_AI_DOCUMENT_CHARACTERS.toLocaleString('en-US')} 个字符`);
  }
}

async function withPreparedStatements<T>(
  db: SQLiteDatabase,
  sources: readonly string[],
  work: (statements: SQLiteStatement[]) => Promise<T>,
) {
  const statements: SQLiteStatement[] = [];
  try {
    for (const source of sources) statements.push(await db.prepareAsync(source));
    return await work(statements);
  } finally {
    await Promise.allSettled(statements.map((statement) => statement.finalizeAsync()));
  }
}

export interface AiImportConfirmationDetails {
  endpoint: string;
  fileName: string;
  size: number;
}

export type ConfirmAiImport = (details: AiImportConfirmationDetails) => Promise<boolean>;

interface ImportJobSource {
  id: number;
  bank_id: number;
  file_name: string;
  file_type: ImportFileType;
  stored_uri: string;
  parser: 'local' | 'ai';
  ai_profile: string | null;
  ai_profile_revision: number | null;
  status: 'queued' | 'running' | 'retry_wait' | 'completed' | 'failed' | 'cancelled';
  next_retry_at: string | null;
  subject_id: number;
}

class ImportCancelledError extends Error {
  constructor() {
    super('导入已取消');
  }
}

const runningJobIds = new Set<number>();
const rerunJobIds = new Set<number>();
const cancelledJobIds = new Set<number>();
const runningControllers = new Map<number, AbortController>();
const retryTimers = new Map<number, ReturnType<typeof setTimeout>>();
let queueTail: Promise<void> = Promise.resolve();
let importsQuiescing = false;

function safeFileName(name: string) {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\\/:\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || 'import.txt').slice(-140);
}

function uniqueStoredName(name: string) {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeFileName(name)}`;
}

async function authorizeAiImport(fileName: string, size: number, confirmAi?: ConfirmAiImport) {
  if (!confirmAi) throw new Error('AI 解析必须先由使用者确认数据传输');
  const { CLOUD_API_URL, hasSession } = await import('../../cloud');
  if (!(await hasSession())) {
    throw new Error('请先在设置中登录 PractiQ 云端账户');
  }
  return confirmAi({ endpoint: CLOUD_API_URL, fileName, size });
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function assertNotCancelled(jobId: number) {
  if (cancelledJobIds.has(jobId)) throw new ImportCancelledError();
}

export function importRequestController(alreadyCancelled: boolean) {
  const controller = new AbortController();
  if (alreadyCancelled) controller.abort();
  return controller;
}

function databaseTime(milliseconds: number) {
  return new Date(milliseconds).toISOString().slice(0, 19).replace('T', ' ');
}

function timestampMilliseconds(value: string | null) {
  if (!value) return 0;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

function sourceMetadata(text: string) {
  return JSON.stringify({ parsedTextCharacters: text.length });
}

export async function pickAndQueueImport(
  db: SQLiteDatabase,
  bankId: number,
  confirmAi?: ConfirmAiImport,
) {
  const bank = await db.getFirstAsync<{ id: number }>('SELECT id FROM question_banks WHERE id = ?', bankId);
  if (!bank) throw new Error('请选择有效题库');

  const [DocumentPicker, FileSystem, Sandbox] = await Promise.all([
    import('expo-document-picker'),
    import('expo-file-system'),
    import('../../files/sandbox'),
  ]);
  const { Directory, File, Paths } = FileSystem;
  const result = await DocumentPicker.getDocumentAsync({
    type: [...IMPORT_MIME_TYPES],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) throw new Error('没有读取到所选文件');

  const source = new File(asset.uri);
  try {
    if (!source.exists) throw new Error('所选文件不可读取');
    const size = source.size || asset.size || 0;
    assertImportFileSize(size);
    const fileType = importFileTypeFromName(asset.name);
    if (fileType === 'txt' && size > MAX_AI_TEXT_BYTES) {
      throw new Error('AI 解析 TXT 文件过大');
    }
    let bytes: Uint8Array;
    if (fileType === 'docx') {
      const handle = source.open(FileSystem.FileMode.ReadOnly);
      try {
        bytes = handle.readBytes(Math.min(64, size));
      } finally {
        handle.close();
      }
    } else {
      bytes = await source.bytes();
    }
    const inspection = inspectImportBytes({
      name: asset.name,
      mimeType: asset.mimeType,
      bytes,
      size,
    });
    bytes = new Uint8Array();
    if (inspection.text) assertAiDocumentLength(inspection.text);
    const authorized = await authorizeAiImport(asset.name, inspection.size, confirmAi);
    if (!authorized) return null;
    const jobId = await Sandbox.withFileMaintenance(async () => {
      const currentBank = await db.getFirstAsync<{ id: number }>(
        'SELECT id FROM question_banks WHERE id = ?',
        bankId,
      );
      if (!currentBank) throw new Error('所选题库已不存在');
      assertManagedFileCapacity(Sandbox.managedSandboxBytes(), inspection.size);
      const importsDirectory = new Directory(Paths.document, 'imports');
      importsDirectory.create({ idempotent: true, intermediates: true });
      const stored = new File(importsDirectory, uniqueStoredName(asset.name));
      await source.copy(stored);

      let insertedJobId = 0;
      try {
        await writeTransaction(db, ['question_import_jobs'], async (transaction) => {
          const job = await transaction.runAsync(
            `INSERT INTO question_import_jobs
              (bank_id, file_name, file_type, source_uri, stored_uri, source_mime_type, source_size,
               source_metadata_json, parser, ai_profile, ai_profile_revision, status, progress, stage)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
            bankId,
            asset.name,
            inspection.fileType,
            asset.uri,
            stored.uri,
            inspection.mimeType,
            inspection.size,
            inspection.fileType === 'txt' ? sourceMetadata(inspection.text ?? '') : null,
            'ai',
            'cloud',
            1,
            IMPORT_STAGE.waitingAi,
          );
          insertedJobId = job.lastInsertRowId;
        });
      } catch (reason) {
        if (stored.exists) stored.delete();
        throw reason;
      }
      return insertedJobId;
    });

    queueImport(db, jobId);
    return jobId;
  } finally {
    Sandbox.deletePickerCacheCopy(source);
  }
}

async function jobSource(db: SQLiteDatabase, jobId: number) {
  return db.getFirstAsync<ImportJobSource>(
     `SELECT j.id, j.bank_id, j.file_name, j.file_type, j.stored_uri, j.parser, j.ai_profile,
        j.ai_profile_revision, j.status, j.next_retry_at, b.subject_id
     FROM question_import_jobs j
     JOIN question_banks b ON b.id = j.bank_id
     WHERE j.id = ?`,
    jobId,
  );
}

async function beginAttempt(db: SQLiteDatabase, jobId: number) {
  const result = await writeTransaction(db, ['question_import_jobs'], (transaction) => (
    transaction.runAsync(
      `UPDATE question_import_jobs
       SET status = 'running', progress = 5, stage = ?, error = NULL, next_retry_at = NULL,
           started_at = CURRENT_TIMESTAMP, finished_at = NULL
       WHERE id = ? AND status IN ('queued', 'retry_wait')`,
      IMPORT_STAGE.validatingFile,
      jobId,
    )
  ));
  return result.changes > 0;
}

async function setStage(db: SQLiteDatabase, jobId: number, progress: number, stage: string) {
  assertNotCancelled(jobId);
  const result = await writeTransaction(db, ['question_import_jobs'], (transaction) => (
    transaction.runAsync(
      "UPDATE question_import_jobs SET progress = ?, stage = ? WHERE id = ? AND status = 'running'",
      progress,
      stage,
      jobId,
    )
  ));
  if (!result.changes) throw new ImportCancelledError();
}

async function persistSourceMetadata(
  db: SQLiteDatabase,
  jobId: number,
  text: string,
) {
  await writeTransaction(db, ['question_import_jobs'], (transaction) => transaction.runAsync(
    'UPDATE question_import_jobs SET source_metadata_json = ? WHERE id = ?',
    sourceMetadata(text),
    jobId,
  ));
}

async function persistQuestions(
  db: SQLiteDatabase,
  job: ImportJobSource,
  questions: ParsedQuestion[],
) {
  const quality = questions.reduce((sum, question) => sum + question.confidence, 0) / questions.length;
  await writeTransaction(db, [
    'questions',
    'bank_question_links',
    'question_options',
    'question_answer_keys',
    'question_content_blocks',
    'outputs',
    'question_banks',
    'question_import_jobs',
  ], async (transaction) => {
    const active = await transaction.getFirstAsync<{ status: string }>(
      'SELECT status FROM question_import_jobs WHERE id = ?',
      job.id,
    );
    if (active?.status !== 'running') throw new ImportCancelledError();
    const order = await transaction.getFirstAsync<{ next_order: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
       FROM bank_question_links WHERE bank_id = ?`,
      job.bank_id,
    );
    const firstOrder = order?.next_order ?? 0;

    await withPreparedStatements(transaction, [
      `INSERT INTO questions
       (subject_id, question_type_code, stem, explanation, status, difficulty, default_score, source)
       VALUES (?, ?, ?, ?, 'draft', 3, 1, ?)`,
      'INSERT INTO bank_question_links(bank_id, question_id, sort_order) VALUES (?, ?, ?)',
      'INSERT INTO question_options(question_id, label, content, sort_order) VALUES (?, ?, ?, ?)',
      `INSERT INTO question_answer_keys(question_id, version, answer_json, is_primary)
       VALUES (?, 1, ?, 1)`,
      `INSERT INTO question_content_blocks
       (question_id, kind, content, metadata_json, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
      `INSERT INTO outputs(job_id, question_id, source_index, confidence, needs_review, raw_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ], async ([
      questionStatement,
      bankLinkStatement,
      optionStatement,
      answerStatement,
      contentBlockStatement,
      outputStatement,
    ]) => {
      for (const [index, question] of questions.entries()) {
        assertNotCancelled(job.id);
        const inserted = await questionStatement.executeAsync(
          job.subject_id,
          question.type,
          question.stem,
          question.explanation,
          `import:${job.id}`,
        );
        const questionId = inserted.lastInsertRowId;
        await bankLinkStatement.executeAsync(job.bank_id, questionId, firstOrder + index);
        for (const [optionIndex, option] of question.options.entries()) {
          assertNotCancelled(job.id);
          await optionStatement.executeAsync(questionId, option.label, option.content, optionIndex);
        }
        const answerJson = JSON.stringify(question.answer);
        await answerStatement.executeAsync(questionId, answerJson);
        const contentBlocks = Array.isArray(question.metadata?.contentBlocks)
          ? question.metadata.contentBlocks
          : [];
        for (const [blockIndex, candidate] of contentBlocks.entries()) {
          if (!candidate || typeof candidate !== 'object') continue;
          const block = candidate as { kind?: unknown; content?: unknown; description?: unknown };
          if (!['formula', 'table', 'chart', 'mathml'].includes(String(block.kind))) continue;
          if (typeof block.content !== 'string' || !block.content.trim() || block.content.length > MAX_FIELD_CHARACTERS) continue;
          await contentBlockStatement.executeAsync(
            questionId,
            String(block.kind),
            block.content.trim(),
            typeof block.description === 'string' && block.description.trim()
              ? JSON.stringify({ description: block.description.trim().slice(0, 1_000), source: 'ai-import' })
              : JSON.stringify({ source: 'ai-import' }),
            blockIndex,
          );
        }
        await outputStatement.executeAsync(
          job.id,
          questionId,
          index,
          question.confidence,
          question.confidence < REVIEW_THRESHOLD ? 1 : 0,
          JSON.stringify(question),
        );
      }
    });

    assertNotCancelled(job.id);
    await transaction.runAsync(
      'UPDATE question_banks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      job.bank_id,
    );
    const completed = await transaction.runAsync(
      `UPDATE question_import_jobs
       SET status = 'completed', progress = 100, stage = ?, quality_score = ?, error = NULL,
           next_retry_at = NULL, finished_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'running'`,
      importCompletedStage(questions.length),
      quality,
      job.id,
    );
    if (!completed.changes) throw new ImportCancelledError();
  });
}

async function markCancelled(db: SQLiteDatabase, jobId: number) {
  await writeTransaction(db, ['question_import_jobs'], (transaction) => transaction.runAsync(
      `UPDATE question_import_jobs
       SET status = 'cancelled', stage = ?, error = NULL, next_retry_at = NULL,
           finished_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('queued', 'running', 'retry_wait')`,
      IMPORT_STAGE.cancelled,
      jobId,
    ));
}

function scheduleRetry(db: SQLiteDatabase, jobId: number, retryAt: number) {
  if (importsQuiescing) return;
  const existing = retryTimers.get(jobId);
  if (existing) clearTimeout(existing);
  const delay = Math.max(0, retryAt - Date.now());
  if (!delay) {
    retryTimers.delete(jobId);
    queueImport(db, jobId);
    return;
  }
  retryTimers.set(
    jobId,
    setTimeout(() => {
      retryTimers.delete(jobId);
      queueImport(db, jobId);
    }, delay),
  );
}

async function handleFailure(db: SQLiteDatabase, jobId: number, reason: unknown) {
  const row = await db.getFirstAsync<{
    status: ImportJobSource['status'];
    parser: ImportJobSource['parser'];
    retry_count: number;
  }>('SELECT status, parser, retry_count FROM question_import_jobs WHERE id = ?', jobId);
  if (!row || row.status === 'completed' || row.status === 'cancelled') return;
  if (reason instanceof ImportCancelledError || cancelledJobIds.has(jobId)) {
    await markCancelled(db, jobId);
    return;
  }

  const message = errorMessage(reason).slice(0, 1_000);
  if (row.parser === 'local' && row.retry_count < MAX_AUTO_RETRIES) {
    const retryCount = row.retry_count + 1;
    const delaySeconds = 2 ** retryCount;
    const retryAt = Date.now() + delaySeconds * 1_000;
    const result = await writeTransaction(db, ['question_import_jobs'], (transaction) => (
      transaction.runAsync(
        `UPDATE question_import_jobs
         SET status = 'retry_wait', stage = ?, retry_count = ?, next_retry_at = ?, error = ?,
             finished_at = NULL
         WHERE id = ? AND status = 'running'`,
        importRetryStage(delaySeconds),
        retryCount,
        databaseTime(retryAt),
        message,
        jobId,
      )
    ));
    if (result.changes) scheduleRetry(db, jobId, retryAt);
    return;
  }

  await writeTransaction(db, ['question_import_jobs'], (transaction) => transaction.runAsync(
      `UPDATE question_import_jobs
       SET status = 'failed', stage = ?, retry_count = ?, next_retry_at = NULL, error = ?,
           finished_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'running'`,
      IMPORT_STAGE.failed,
      row.retry_count,
      message,
      jobId,
    ));
}

async function processImport(db: SQLiteDatabase, jobId: number) {
  const job = await jobSource(db, jobId);
  if (!job || !['queued', 'retry_wait'].includes(job.status)) return;
  if (job.status === 'retry_wait') {
    const retryAt = timestampMilliseconds(job.next_retry_at);
    if (retryAt > Date.now()) {
      scheduleRetry(db, jobId, retryAt);
      return;
    }
  }

  try {
    assertNotCancelled(jobId);
    if (!(await beginAttempt(db, jobId))) return;
    const [{ Directory, File, Paths }, { isDirectManagedFile }] = await Promise.all([
      import('expo-file-system'),
      import('../../files/sandbox'),
    ]);
    if (!isDirectManagedFile(job.stored_uri, new Directory(Paths.document, 'imports'))) {
      throw new Error('沙盒中的导入源文件已丢失，请重新选择文件');
    }
    const stored = new File(job.stored_uri);
    if (!stored.exists) throw new Error('沙盒中的导入源文件已丢失，请重新选择文件');
    assertImportFileSize(stored.size);
    if (job.file_type === 'txt' && job.parser === 'ai' && stored.size > MAX_AI_TEXT_BYTES) {
      throw new Error('AI 解析 TXT 文件过大');
    }
    let bytes = await stored.bytes();
    const inspection = inspectImportBytes({
      name: job.file_name,
      mimeType: expectedMimeType(job.file_type),
      bytes,
    });
    assertNotCancelled(jobId);

    await setStage(
      db,
      jobId,
      30,
      job.file_type === 'docx' ? IMPORT_STAGE.readingDocx : IMPORT_STAGE.readingTxt,
    );
    const docxText = job.file_type === 'docx'
      ? await extractDocx(bytes, () => assertNotCancelled(jobId))
      : null;
    bytes = new Uint8Array();
    const text = docxText ?? inspection.text ?? '';
    if (job.parser === 'ai') assertAiDocumentLength(text);
    await persistSourceMetadata(db, jobId, text);

    await setStage(
      db,
      jobId,
      55,
      job.parser === 'ai' ? IMPORT_STAGE.waitingAiService : IMPORT_STAGE.recognizingQuestions,
    );
    let parsed: ParsedQuestion[];
    if (job.parser === 'ai') {
      const { parseDocumentCloud } = await import('../../cloud');
      const controller = importRequestController(cancelledJobIds.has(jobId));
      runningControllers.set(jobId, controller);
      if (controller.signal.aborted) throw new ImportCancelledError();
      parsed = await parseDocumentCloud(text, safeFileName(job.file_name), {
        abortSignal: controller.signal,
      });
      runningControllers.delete(jobId);
    } else {
      parsed = parsePlainText(text);
    }
    const questions = normalizeQuestions(parsed, job.parser);
    await setStage(db, jobId, 75, importWritingStage(questions.length));
    await persistQuestions(db, job, questions);
    cancelledJobIds.delete(jobId);
  } catch (reason) {
    await handleFailure(db, jobId, reason);
  } finally {
    runningControllers.delete(jobId);
  }
}

export function queueImport(db: SQLiteDatabase, jobId: number) {
  if (importsQuiescing || !Number.isInteger(jobId) || jobId <= 0) return;
  if (runningJobIds.has(jobId)) {
    rerunJobIds.add(jobId);
    return;
  }
  runningJobIds.add(jobId);
  queueTail = queueTail
    .catch(() => undefined)
    .then(() => processImport(db, jobId))
    .catch(() => undefined)
    .finally(() => {
      runningJobIds.delete(jobId);
      if (rerunJobIds.delete(jobId)) queueImport(db, jobId);
      else cancelledJobIds.delete(jobId);
    });
}

/** Stops all in-memory import work before replacing the authoritative database. */
export async function quiesceImportRuntime() {
  importsQuiescing = true;
  for (const jobId of runningJobIds) cancelledJobIds.add(jobId);
  for (const controller of runningControllers.values()) controller.abort();
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  rerunJobIds.clear();
  await queueTail.catch(() => undefined);
  runningControllers.clear();
  runningJobIds.clear();
  rerunJobIds.clear();
  cancelledJobIds.clear();
  queueTail = Promise.resolve();
  return () => { importsQuiescing = false; };
}

export async function resumePendingImports(db: SQLiteDatabase) {
  if (importsQuiescing) return;
  const jobs = await db.getAllAsync<{ id: number; status: 'queued' | 'retry_wait'; next_retry_at: string | null }>(
    PENDING_IMPORTS_SQL,
  );
  if (importsQuiescing) return;
  for (const job of jobs) {
    if (job.status === 'queued') queueImport(db, job.id);
    else scheduleRetry(db, job.id, Math.max(Date.now(), timestampMilliseconds(job.next_retry_at)));
  }
}

export async function setImportOutputNeedsReview(
  db: SQLiteDatabase,
  jobId: number,
  outputId: number,
  needsReview: boolean,
) {
  if (!Number.isInteger(jobId) || jobId <= 0 || !Number.isInteger(outputId) || outputId <= 0) {
    throw new Error('导入产物无效');
  }
  const result = await writeTransaction(db, ['outputs'], (transaction) => transaction.runAsync(
    'UPDATE outputs SET needs_review = ? WHERE id = ? AND job_id = ?',
    needsReview ? 1 : 0,
    outputId,
    jobId,
  ));
  if (!result.changes) throw new Error('导入产物不存在');
}

export async function cancelImport(db: SQLiteDatabase, jobId: number) {
  const running = runningJobIds.has(jobId);
  cancelledJobIds.add(jobId);
  runningControllers.get(jobId)?.abort();
  rerunJobIds.delete(jobId);
  const timer = retryTimers.get(jobId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(jobId);
  try {
    await markCancelled(db, jobId);
  } finally {
    if (!running) cancelledJobIds.delete(jobId);
  }
}

export async function retryImport(db: SQLiteDatabase, jobId: number, confirmAi?: ConfirmAiImport) {
  const job = await db.getFirstAsync<{
    parser: 'local' | 'ai';
    ai_profile: string | null;
    file_name: string;
    size: number;
  }>(
    `SELECT parser, ai_profile, file_name, source_size AS size
     FROM question_import_jobs WHERE id = ?`,
    jobId,
  );
  if (!job) throw new Error('导入任务或源文件不存在');
  if (job.parser === 'ai') {
    const authorized = await authorizeAiImport(job.file_name, job.size, confirmAi);
    if (!authorized) return false;
  }
  cancelledJobIds.delete(jobId);
  const timer = retryTimers.get(jobId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(jobId);
  const result = await writeTransaction(db, ['question_import_jobs'], (transaction) => (
    transaction.runAsync(
      `UPDATE question_import_jobs
       SET status = 'queued', progress = 0, stage = ?, retry_count = 0, next_retry_at = NULL,
           error = NULL, started_at = NULL, finished_at = NULL, ai_profile_revision = ?
       WHERE id = ? AND status IN ('failed', 'retry_wait', 'cancelled')`,
      IMPORT_STAGE.manualRetry,
      job.parser === 'ai' ? 1 : null,
      jobId,
    )
  ));
  if (!result.changes) throw new Error('当前任务不可重试');
  queueImport(db, jobId);
  return true;
}
