import 'server-only';

import { sql } from '../db';
import { ApiError } from '../api';
import { inferImportSourceType, isUploadedFile, readObjectBuffer, storeImportSourceFile } from '../object-storage';
import { requireImportSourceType } from '../permissions';
import { getImportJob } from './imports';
import type { User } from '../types';

export async function addImportJobUploadedFile(user: User, jobId: number, file: FormDataEntryValue | null) {
  const job = await getImportJob(user, jobId);
  if (!isUploadedFile(file)) {
    throw new ApiError(400, 'FILE_REQUIRED', 'Upload file is required');
  }

  const stored = await storeImportSourceFile(user.id, jobId, file);
  const inferredSourceType = inferImportSourceType(file);
  const sourceType = requireImportSourceType(user, inferredSourceType === 'unknown' ? job.source_type : inferredSourceType);
  const content: Record<string, unknown> = {
    objectUrl: stored.objectUrl,
    objectKey: stored.relativePath,
    originalName: stored.originalName,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sourceType
  };

  if (sourceType === 'txt') {
    const buffer = await readObjectBuffer(stored.relativePath);
    content.text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  }

  const rows = await sql`
    UPDATE question_import_jobs
    SET source_type = ${sourceType}, file_name = COALESCE(file_name, ${stored.originalName})
    WHERE id = ${jobId}
    RETURNING *
  `;
  const artifactRows = await sql`
    INSERT INTO question_import_job_artifacts (job_id, artifact_type, storage_path, content_json)
    VALUES (${jobId}, 'source_file', ${stored.objectUrl}, ${JSON.stringify(content)})
    RETURNING *
  `;
  void rows;
  return artifactRows[0];
}
