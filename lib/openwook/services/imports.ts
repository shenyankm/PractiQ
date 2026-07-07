import 'server-only';

import { sql } from '../db';
import { ApiError } from '../api';
import { errorToLog, logger } from '../logger';
import { publishImportEvent } from '../import-events';
import { isImportQueueConfigured, enqueueImportJob, removeQueuedImportJob } from '../import-queue';
import { requireImportSourceType } from '../permissions';
import { invalidateUserAnalytics } from './internal';
import { requireBankOwner } from './banks';
import type { ImportJob, User } from '../types';

async function ensureImportJobHasSourceArtifact(jobId: number) {
  const rows = await sql<Array<{ id: number }>>`
    SELECT id
    FROM question_import_job_artifacts
    WHERE job_id = ${jobId}
      AND artifact_type = 'source_file'
      AND (storage_path IS NOT NULL OR content_json IS NOT NULL)
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(409, 'SOURCE_FILE_REQUIRED', 'Import job requires an uploaded TXT or DOCX source file before parsing');
  }
}

function extractSourceTypeFromArtifact(storagePath?: string | null, content?: Record<string, unknown> | null) {
  const explicit = typeof content?.sourceType === 'string' ? content.sourceType : null;
  if (explicit) return explicit;
  const originalName = typeof content?.originalName === 'string' ? content.originalName : '';
  const pathValue = storagePath || originalName;
  if (/\.docx(?:$|[?#])/i.test(pathValue)) return 'docx';
  if (/\.txt(?:$|[?#])/i.test(pathValue)) return 'txt';
  return null;
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
  data: { artifactType?: string; storagePath?: string | null; content?: Record<string, unknown> | null; sourceType?: string | null }
) {
  const job = await getImportJob(user, jobId);
  if (!data.storagePath && !data.content) {
    throw new ApiError(400, 'SOURCE_FILE_REQUIRED', 'Import artifact requires storagePath or content');
  }
  const sourceType = requireImportSourceType(user, data.sourceType ?? extractSourceTypeFromArtifact(data.storagePath, data.content) ?? job.source_type);
  const rows = await sql`
    UPDATE question_import_jobs
    SET source_type = ${sourceType}
    WHERE id = ${jobId}
    RETURNING *
  `;
  const artifactRows = await sql`
    INSERT INTO question_import_job_artifacts (job_id, artifact_type, storage_path, content_json)
    VALUES (
      ${jobId},
      ${data.artifactType ?? 'source_file'},
      ${data.storagePath ?? null},
      ${JSON.stringify({ ...(data.content ?? {}), sourceType })}
    )
    RETURNING *
  `;
  void rows;
  return artifactRows[0];
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
  if (action === 'start' || action === 'retry') {
    await ensureImportJobHasSourceArtifact(jobId);
    if (!isImportQueueConfigured()) {
      throw new ApiError(503, 'IMPORT_QUEUE_UNAVAILABLE', 'Redis import queue is not configured');
    }
  }
  const values = action === 'cancel'
    ? { status: 'failed', stage: 'failed', lastError: '任务已取消。', completed: true }
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
  await ensureImportJobHasSourceArtifact(jobId);
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
  const internalMessage = error instanceof Error ? error.message : String(error);
  logger.error({ ...errorToLog(error), jobId }, 'import job reached terminal failure');
  const message = '导入失败，请稍后重试或联系管理员。';
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
        metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object('last_internal_error', ${internalMessage}),
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

type ImportJobChildKind = 'events' | 'pages' | 'blocks' | 'review-items' | 'outputs' | 'artifacts';

export async function listImportJobChildren(user: User, jobId: number, kind: ImportJobChildKind) {
  await getImportJob(user, jobId);
  return listImportJobChildrenForJob(jobId, kind);
}

export async function getImportJobDetail(user: User, jobId: number) {
  const job = await getImportJob(user, jobId);
  const [events, pages, blocks, reviewItems, outputs] = await Promise.all([
    listImportJobChildrenForJob(jobId, 'events'),
    listImportJobChildrenForJob(jobId, 'pages'),
    listImportJobChildrenForJob(jobId, 'blocks'),
    listImportJobChildrenForJob(jobId, 'review-items'),
    listImportJobChildrenForJob(jobId, 'outputs')
  ]);

  return { job, events, pages, blocks, reviewItems, outputs };
}

async function listImportJobChildrenForJob(jobId: number, kind: ImportJobChildKind) {
  if (kind === 'events') return sql`SELECT * FROM question_import_job_events WHERE job_id = ${jobId} ORDER BY id DESC LIMIT 100`;
  if (kind === 'pages') return sql`SELECT * FROM question_import_job_pages WHERE job_id = ${jobId} ORDER BY page_no`;
  if (kind === 'blocks') return sql`SELECT * FROM question_import_job_blocks WHERE job_id = ${jobId} ORDER BY id LIMIT 200`;
  if (kind === 'review-items') return sql`SELECT * FROM question_import_job_review_items WHERE job_id = ${jobId} ORDER BY id LIMIT 200`;
  if (kind === 'artifacts') return sql`SELECT * FROM question_import_job_artifacts WHERE job_id = ${jobId} ORDER BY id`;
  return sql`SELECT * FROM question_import_job_outputs WHERE job_id = ${jobId} ORDER BY id LIMIT 200`;
}
