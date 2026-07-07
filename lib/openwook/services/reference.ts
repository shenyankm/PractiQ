import 'server-only';

import { sql } from '../db';
import { ApiError } from '../api';
import { hashKey, redisGetOrSetJson, redisKey } from '../redis';
import { cacheVersion, referenceCacheTtl } from './internal';
import type { AnswerMode, QuestionType, Subject } from '../types';

export async function resolveQuestionTypeIdForSubject(
  subject: string,
  requestedTypeId: string | null | undefined,
  answerMode?: AnswerMode | null,
  preferredScope: 'question' | 'group' | 'hybrid' = 'question'
) {
  const requested = requestedTypeId?.trim() || null;
  if (requested) {
    const requestedRows = await sql<Array<{ type_id: string }>>`
      SELECT type_id
      FROM question_types
      WHERE subject_id = ${subject}
        AND type_id = ${requested}
      LIMIT 1
    `;
    if (requestedRows[0]) return requestedRows[0].type_id;
  }

  const fallbackRows = await sql<Array<{ type_id: string }>>`
    SELECT type_id
    FROM question_types
    WHERE subject_id = ${subject}
    ORDER BY
      CASE WHEN default_answer_mode = ${answerMode ?? null} THEN 0 ELSE 1 END,
      CASE WHEN default_answer_mode IS NULL THEN 0 ELSE 1 END,
      CASE WHEN scope = ${preferredScope} THEN 0 WHEN scope = 'hybrid' THEN 1 ELSE 2 END,
      type_id
    LIMIT 1
  `;
  if (fallbackRows[0]) return fallbackRows[0].type_id;

  throw new ApiError(422, 'INVALID_QUESTION_TYPE', `No compatible question type exists for subject ${subject}`);
}

export async function listSubjects() {
  return redisGetOrSetJson<Subject[]>(
    redisKey('cache', 'subjects'),
    referenceCacheTtl,
    () => sql<Subject[]>`
      SELECT subject_id, display_name
      FROM subjects
      ORDER BY display_name
    `
  );
}

export async function listQuestionTypes(subject?: string, scope?: string) {
  return redisGetOrSetJson<QuestionType[]>(
    redisKey('cache', 'question-types', hashKey({ subject: subject ?? null, scope: scope ?? null })),
    referenceCacheTtl,
    () => sql<QuestionType[]>`
      SELECT type_id, subject_id, display_name, scope, default_answer_mode
      FROM question_types
      WHERE (${subject ?? null}::text IS NULL OR subject_id = ${subject ?? null})
        AND (${scope ?? null}::text IS NULL OR scope = ${scope ?? null})
      ORDER BY subject_id, display_name
    `
  );
}

export async function listKnowledgePoints(subject?: string, parentId?: number) {
  const version = await cacheVersion('knowledge-points');
  return redisGetOrSetJson(
    redisKey('cache', 'knowledge-points', version, hashKey({ subject: subject ?? null, parentId: parentId ?? null })),
    referenceCacheTtl,
    () => sql`
      SELECT id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at
      FROM knowledge_points
      WHERE (${subject ?? null}::text IS NULL OR subject_id = ${subject ?? null})
        AND (
          ${parentId ?? null}::bigint IS NULL AND parent_id IS NULL
          OR parent_id = ${parentId ?? null}
        )
      ORDER BY display_name
    `
  );
}
