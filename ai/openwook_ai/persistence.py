from __future__ import annotations

import hashlib
import os
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .documents import DocumentProcessingError
from .schemas import DocumentParseRequest, DocumentParseResult, FileUploadWorkflowRequest


def persist_document_parse(
    request: DocumentParseRequest | FileUploadWorkflowRequest,
    result: DocumentParseResult,
    preprocessing: dict[str, object] | None = None,
) -> None:
    # Existing JSON parse callers retain their Go-owned persistence path.
    if not isinstance(request, FileUploadWorkflowRequest):
        return

    database_url = os.getenv('AI_POSTGRES_URL', '').strip()
    if not database_url:
        raise DocumentProcessingError(503, 'Database persistence is not configured')
    if request.bankId is not None and request.importJobId is None:
        raise DocumentProcessingError(400, 'bankId requires importJobId')

    input_payload: dict[str, Any] = {
        'sourceType': request.sourceType,
        'fileName': request.fileName,
        'mimeType': request.mimeType,
        'preprocessing': _safe_preprocessing_metadata(preprocessing or {}),
    }
    input_payload.update(
        {
            'byteLength': len(request.fileBytes),
            'sha256': hashlib.sha256(request.fileBytes).hexdigest(),
            'parseMethod': request.parseMethod,
        }
    )

    model = os.getenv('OPENAI_MODEL', '').strip() or None
    provider = 'openai-compatible' if model and os.getenv('OPENAI_BASE_URL', '').strip() else 'fallback'
    if provider == 'fallback':
        model = None
    output_payload = result.model_dump(mode='json')
    for question in output_payload['questions']:
        question['sourceText'] = None
    try:
        with psycopg.connect(database_url) as connection:
            if request.importJobId is not None:
                inserted = connection.execute(
                    '''
                    WITH target_job AS (
                        SELECT id, created_by, bank_id
                        FROM question_import_jobs
                        WHERE id = %s
                          AND (%s::bigint IS NULL OR bank_id = %s::bigint)
                    )
                    INSERT INTO ai_artifacts (
                        artifact_type,
                        user_id,
                        bank_id,
                        import_job_id,
                        provider,
                        model,
                        input_payload,
                        output_payload,
                        status
                    )
                    SELECT
                        'document_parse',
                        created_by,
                        bank_id,
                        id,
                        %s,
                        %s,
                        %s,
                        %s,
                        'completed'
                    FROM target_job
                    RETURNING id
                    ''',
                    (
                        request.importJobId,
                        request.bankId,
                        request.bankId,
                        provider,
                        model,
                        Jsonb(input_payload),
                        Jsonb(output_payload),
                    ),
                ).fetchone()
                if inserted is None:
                    raise DocumentProcessingError(400, 'Import job and bank do not match')
            else:
                connection.execute(
                    '''
                    INSERT INTO ai_artifacts (
                        artifact_type,
                        provider,
                        model,
                        input_payload,
                        output_payload,
                        status
                    ) VALUES ('document_parse', %s, %s, %s, %s, 'completed')
                    ''',
                    (
                        provider,
                        model,
                        Jsonb(input_payload),
                        Jsonb(output_payload),
                    ),
                )
    except psycopg.Error as exc:
        raise DocumentProcessingError(503, 'Database persistence failed') from exc


def _safe_preprocessing_metadata(metadata: dict[str, object]) -> dict[str, object]:
    safe = dict(metadata)
    mineru = safe.get('mineru')
    if isinstance(mineru, dict):
        safe['mineru'] = {key: value for key, value in mineru.items() if key != 'contentList'}
    return safe
