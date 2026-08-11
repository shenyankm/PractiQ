"""Import job service. Mirrors backend/internal/services/imports.go + imports_helpers.go."""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Any

from psycopg_pool import AsyncConnectionPool

from .. import envelope, redisx
from ..auth.runtime import User
from . import helpers, users as users_svc
from .pagination import Page, build_page, clamp_positive, parse_page_cursor

IMPORT_WORKER_FAILED_CODE = 'IMPORT_WORKER_FAILED'
IMPORT_ATTEMPTS_EXHAUSTED_CODE = 'IMPORT_ATTEMPTS_EXHAUSTED'
IMPORT_PERSISTENCE_INTERRUPTED_CODE = 'IMPORT_PERSISTENCE_INTERRUPTED'

IMPORT_SOURCE_MAX_BYTES = 25 * 1024 * 1024

INSERT_SOURCE_ARTIFACT_SQL = """
    WITH inserted AS (
        INSERT INTO question_import_job_artifacts (job_id, artifact_type, storage_path, content_json)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (job_id) WHERE artifact_type = 'source_file' DO NOTHING
        RETURNING *
    )
    SELECT row_to_json(inserted)::text FROM inserted
"""

ALLOWED_STATUSES = {'queued', 'processing', 'completed', 'failed', 'cancelled'}


def _decode_job(raw) -> dict:
    if isinstance(raw, str):
        return json.loads(raw)
    return dict(raw)


def _decode_map(raw) -> dict:
    if isinstance(raw, str):
        return json.loads(raw)
    return dict(raw)


def _marshal_json_string(value) -> str:
    return json.dumps(value if value is not None else {}, separators=(',', ':'))


def normalize_import_source_type(value: str) -> str:
    normalized = value.strip().lower() or 'txt'
    if normalized in ('text', 'txt'):
        return 'txt'
    if normalized in ('docx', 'pdf', 'xlsx'):
        return normalized
    raise envelope.new_error(
        400, 'UNSUPPORTED_SOURCE_TYPE', 'Only txt, docx, pdf, and xlsx imports are supported'
    )


def _source_type_from_name(value: str) -> str:
    lower = value.lower()
    for kind in ('docx', 'pdf', 'xlsx', 'txt'):
        if lower.endswith('.' + kind):
            return kind
    return ''


def _extract_source_type_from_artifact(storage_path: str, content: dict) -> str:
    value = content.get('sourceType')
    if isinstance(value, str) and value.strip():
        return value.strip().lower()
    value = content.get('originalName')
    if isinstance(value, str):
        kind = _source_type_from_name(value)
        if kind:
            return kind
    return _source_type_from_name(storage_path)


def decode_bounded_import_base64(raw: str, max_bytes: int) -> bytes:
    if len(raw) * 3 // 4 > max_bytes + 2:
        raise envelope.new_error(413, 'FILE_TOO_LARGE', 'Import content exceeds the 25 MiB limit')
    try:
        payload = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise envelope.new_error(400, 'INVALID_FILE_CONTENT', 'fileBase64 must contain valid base64') from exc
    if not payload:
        raise envelope.new_error(400, 'EMPTY_FILE', 'Uploaded file is empty')
    if len(payload) > max_bytes:
        raise envelope.new_error(413, 'FILE_TOO_LARGE', 'Import content exceeds the 25 MiB limit')
    return payload


DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
PDF_MIME_TYPE = 'application/pdf'
XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

SOURCE_EXTENSION_MIME_TYPES = {
    '.txt': 'text/plain',
    '.docx': DOCX_MIME_TYPE,
    '.pdf': PDF_MIME_TYPE,
    '.xlsx': XLSX_MIME_TYPE,
}


def validate_import_source_payload(extension: str, content_type: str, payload: bytes, original_name: str) -> None:
    mime = content_type.strip().lower()
    if mime and mime not in ('application/octet-stream', 'binary/octet-stream'):
        expected_mime = SOURCE_EXTENSION_MIME_TYPES.get(extension)
        if expected_mime is not None and mime != expected_mime:
            raise envelope.new_error(400, 'UNSUPPORTED_FILE_TYPE', f'Unsupported file type: {original_name}')
    if extension == '.txt':
        try:
            text = payload.decode('utf-8')
        except UnicodeDecodeError as exc:
            raise envelope.new_error(400, 'INVALID_FILE_CONTENT', 'TXT files must use UTF-8 encoding') from exc
        if b'\x00' in payload:
            raise envelope.new_error(400, 'UNSUPPORTED_FILE_TYPE', 'TXT files must be plain text')
        if not text.removeprefix('﻿').strip():
            raise envelope.new_error(400, 'EMPTY_FILE', 'TXT files must contain non-whitespace text')
        return
    if extension == '.pdf':
        if len(payload) < 5 or payload[:5] != b'%PDF-':
            raise envelope.new_error(400, 'UNSUPPORTED_FILE_TYPE', 'PDF files must be valid PDF documents')
        return
    if len(payload) < 2 or payload[:2] != b'PK':
        label = extension.lstrip('.').upper() or 'DOCX'
        raise envelope.new_error(
            400, 'UNSUPPORTED_FILE_TYPE', f'{label} files must be valid Office Open XML documents'
        )


def _validate_import_artifact_content(source_type: str, content: dict) -> None:
    if source_type in ('docx', 'pdf', 'xlsx'):
        raw = content.get('fileBase64')
        if not isinstance(raw, str) or not raw.strip():
            raise envelope.new_error(400, 'FILE_REQUIRED', f'{source_type.upper()} artifacts require fileBase64')
        payload = decode_bounded_import_base64(raw, IMPORT_SOURCE_MAX_BYTES)
        mime = content.get('mimeType') if isinstance(content.get('mimeType'), str) else ''
        fallback_name = f'source.{source_type}'
        name = content.get('originalName') if isinstance(content.get('originalName'), str) else fallback_name
        validate_import_source_payload(f'.{source_type}', mime, payload, name.strip() or fallback_name)
        return

    total_bytes = 0
    found = False
    if 'text' in content:
        text = content['text']
        if not isinstance(text, str):
            raise envelope.new_error(400, 'INVALID_FILE_CONTENT', 'text must be a string')
        if len(text.encode()) > IMPORT_SOURCE_MAX_BYTES:
            raise envelope.new_error(413, 'FILE_TOO_LARGE', 'Import content exceeds the 25 MiB limit')
        validate_import_source_payload('.txt', 'text/plain', text.encode(), 'source.txt')
        total_bytes += len(text.encode())
        found = True
    if 'fileBase64' in content:
        raw = content['fileBase64']
        if not isinstance(raw, str):
            raise envelope.new_error(400, 'INVALID_FILE_CONTENT', 'fileBase64 must be a string')
        payload = decode_bounded_import_base64(raw, IMPORT_SOURCE_MAX_BYTES)
        validate_import_source_payload('.txt', 'text/plain', payload, 'source.txt')
        total_bytes += len(payload)
        found = True
    if not found:
        raise envelope.new_error(400, 'FILE_REQUIRED', 'TXT artifacts require text or fileBase64')
    if total_bytes > IMPORT_SOURCE_MAX_BYTES:
        raise envelope.new_error(413, 'FILE_TOO_LARGE', 'Import content exceeds the 25 MiB limit')


async def list_import_jobs(
    pool: AsyncConnectionPool, user: User, status: str, cursor_str: str, requested_limit: int
) -> Page[dict]:
    statuses = [s.strip() for s in status.split(',') if s.strip()]
    if not status.strip():
        status = ''
    else:
        for value in statuses:
            if value not in ALLOWED_STATUSES:
                raise envelope.validation_error(
                    [envelope.ValidationDetail('status', 'must contain only queued, processing, completed, failed, cancelled')]
                )
        status = ','.join(statuses)
    limit = clamp_positive(requested_limit, 30, 100)
    offset = parse_page_cursor(cursor_str)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT row_to_json(job)::text
            FROM (
                SELECT *
                FROM question_import_jobs
                WHERE created_by = %s
                  AND (%s::text IS NULL OR status = ANY(string_to_array(%s, ',')))
                ORDER BY created_at DESC
                LIMIT %s OFFSET %s
            ) job
            """,
            (user.id, helpers.trimmed_or_none(status), helpers.trimmed_or_none(status), limit + 1, offset),
        )
        jobs = [_decode_job(row[0]) for row in await cursor.fetchall()]
    return build_page(jobs, limit, offset)


async def create_import_job(
    pool: AsyncConnectionPool, user: User,
    bank_id: int | None, file_name: str | None, source_type: str, request_payload: dict | None,
) -> dict:
    async with pool.connection() as conn:
        await users_svc.require_pro_entitlement(conn, user, 'AI document imports')
        if bank_id is not None:
            from .banks import require_bank_owner
            await require_bank_owner(conn, user, bank_id)
        normalized = normalize_import_source_type(source_type)
        cursor = await conn.execute(
            """
            WITH inserted AS (
                INSERT INTO question_import_jobs (created_by, bank_id, file_name, source_type, request_payload)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING *
            )
            SELECT row_to_json(inserted)::text FROM inserted
            """,
            (user.id, bank_id, helpers.trimmed_or_none(file_name), normalized, _marshal_json_string(request_payload)),
        )
        return _decode_job((await cursor.fetchone())[0])


async def get_import_job(pool: AsyncConnectionPool, user: User, job_id: int) -> dict:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT row_to_json(job)::text
            FROM (
                SELECT *
                FROM question_import_jobs
                WHERE id = %s AND created_by = %s
                LIMIT 1
            ) job
            """,
            (job_id, user.id),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Import job not found')
    return _decode_job(row[0])


@dataclass
class AddImportJobFileInput:
    artifact_type: str = 'source_file'
    storage_path: str | None = None
    content: dict | None = None
    source_type: str = ''


async def add_import_job_file(
    pool: AsyncConnectionPool, user: User, job_id: int, input: AddImportJobFileInput
) -> dict:
    artifact_type = input.artifact_type.strip() or 'source_file'
    if artifact_type != 'source_file':
        raise envelope.validation_error(
            [envelope.ValidationDetail('artifactType', 'must be source_file')]
        )
    job = await get_import_job(pool, user, job_id)
    content = dict(input.content or {})
    if input.storage_path is None and not content:
        raise envelope.new_error(400, 'SOURCE_FILE_REQUIRED', 'Import artifact requires storagePath or content')

    job_source_type = job.get('source_type') or ''
    source_hint = input.source_type.strip() or _extract_source_type_from_artifact(
        input.storage_path or '', content
    ) or job_source_type
    async with pool.connection() as conn:
        await users_svc.require_pro_entitlement(conn, user, 'AI document imports')
    source_type = normalize_import_source_type(source_hint)

    _validate_import_artifact_content(source_type, content)
    content['sourceType'] = source_type
    raw_content = _marshal_json_string(content)

    async with pool.connection() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                WITH updated AS (
                    UPDATE question_import_jobs
                    SET source_type = %s
                    WHERE id = %s
                    RETURNING *
                )
                SELECT row_to_json(updated)::text FROM updated
                """,
                (source_type, job_id),
            )
            cursor = await conn.execute(
                INSERT_SOURCE_ARTIFACT_SQL, (job_id, artifact_type, input.storage_path, raw_content)
            )
            row = await cursor.fetchone()
            if row is None:
                raise envelope.new_error(409, 'IMPORT_SOURCE_EXISTS', 'Import job already has a source file')
            return _decode_map(row[0])


@dataclass
class _QueueTransition:
    status: str
    stage: str
    step_code: str
    step_label: str
    event_status: str
    message: str | None = None
    completed: bool = False
    available: bool = False
    reset_attempts: bool = False
    persist_questions: bool | None = None


def _queue_transition_for_action(action: str) -> _QueueTransition:
    if action == 'retry':
        return _QueueTransition(
            status='queued', stage='queued', step_code='retry', step_label='重新排队',
            event_status='queued', available=True, reset_attempts=True,
        )
    if action == 'cancel':
        return _QueueTransition(
            status='cancelled', stage='cancelled', step_code='cancel', step_label='取消任务',
            event_status='cancelled', message='任务已取消。', completed=True,
        )
    raise envelope.new_error(400, 'INVALID_IMPORT_ACTION', 'Unsupported import action')


def _queue_transition_for_parse(persist_questions: bool) -> _QueueTransition:
    return _QueueTransition(
        status='queued', stage='queued', step_code='queue_parse', step_label='加入导入队列',
        event_status='queued', available=True, reset_attempts=True, persist_questions=persist_questions,
    )


def _ensure_import_job_queue_action_allowed(job: dict, action: str) -> None:
    if action in ('retry', 'parse') and (job.get('last_error_code') or '') == IMPORT_PERSISTENCE_INTERRUPTED_CODE:
        raise envelope.new_error(
            409, 'IMPORT_RETRY_UNSAFE', 'Import persistence was interrupted and cannot be retried automatically'
        )
    if job['status'] == 'completed':
        raise envelope.new_error(409, 'IMPORT_ALREADY_COMPLETED', 'Completed import jobs cannot be queued again')
    if action == 'cancel' and job['status'] not in ('queued', 'processing'):
        raise envelope.new_error(
            409, 'IMPORT_CANCEL_NOT_ALLOWED', 'Only queued or processing import jobs can be cancelled'
        )
    if action == 'retry' and job['status'] != 'failed':
        raise envelope.new_error(409, 'IMPORT_RETRY_NOT_ALLOWED', 'Only failed import jobs can be retried')


def _import_job_already_scheduled(job: dict) -> bool:
    return job['status'] == 'processing' or (job['status'] == 'queued' and job.get('available_at') is not None)


async def _ensure_import_job_has_source_artifact(pool: AsyncConnectionPool, job_id: int) -> None:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT id
            FROM question_import_job_artifacts
            WHERE job_id = %s
              AND artifact_type = 'source_file'
              AND (storage_path IS NOT NULL OR content_json IS NOT NULL)
            LIMIT 1
            """,
            (job_id,),
        )
        if await cursor.fetchone() is None:
            raise envelope.new_error(
                409, 'SOURCE_FILE_REQUIRED',
                'Import job requires an uploaded TXT, DOCX, PDF or XLSX source file before parsing',
            )


async def _apply_import_queue_transition(
    pool: AsyncConnectionPool, job: dict, transition: _QueueTransition
) -> dict:
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                """
                WITH updated AS (
                    UPDATE question_import_jobs
                    SET
                        status = %s,
                        stage = %s,
                        last_error = %s,
                        last_error_code = CASE WHEN %s::text IS NULL THEN NULL ELSE 'IMPORT_CANCELLED' END,
                        error_payload = CASE WHEN %s::text IS NULL THEN NULL ELSE error_payload END,
                        persist_questions = COALESCE(%s::boolean, persist_questions),
                        retry_count = CASE WHEN %s THEN 0 ELSE retry_count END,
                        available_at = CASE WHEN %s THEN NOW() ELSE NULL END,
                        overall_progress_percent = CASE WHEN %s THEN 0 ELSE overall_progress_percent END,
                        step_progress_percent = CASE WHEN %s THEN 0 ELSE step_progress_percent END,
                        completed_at = CASE WHEN %s THEN NOW() ELSE NULL END
                    WHERE id = %s
                      AND status = %s
                      AND (NOT %s::boolean OR available_at IS NULL)
                    RETURNING *
                )
                SELECT row_to_json(updated)::text FROM updated
                """,
                (
                    transition.status, transition.stage,
                    transition.message, transition.message, transition.message,
                    transition.persist_questions, transition.reset_attempts,
                    transition.available, transition.available, transition.available,
                    transition.completed, job['id'], job['status'], transition.available,
                ),
            )
            row = await cursor.fetchone()
            if row is None:
                raise envelope.new_error(
                    409, 'IMPORT_STATE_CHANGED', 'Import job state changed; refresh and try again'
                )
            updated = _decode_job(row[0])
            await conn.execute(
                """
                INSERT INTO question_import_job_events (job_id, stage, step_code, step_label, status, message, overall_progress_percent)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    job['id'], transition.stage, transition.step_code, transition.step_label,
                    transition.event_status, transition.message, updated.get('overall_progress_percent'),
                ),
            )
            return updated


async def _invalidate_user_analytics(user_id: int) -> None:
    await helpers.bump_slice_cache_version('analytics', user_id)


async def update_import_job_status(
    pool: AsyncConnectionPool, user: User, job_id: int, action: str, encryption_secret: str
) -> dict:
    job = await get_import_job(pool, user, job_id)
    transition = _queue_transition_for_action(action)
    _ensure_import_job_queue_action_allowed(job, action)
    if action == 'cancel':
        updated = await _apply_import_queue_transition(pool, job, transition)
        await _invalidate_user_analytics(user.id)
        return updated
    await users_svc.require_llm_config(
        pool, user, encryption_secret, 'AI document imports'
    )
    await _ensure_import_job_has_source_artifact(pool, job_id)
    if _import_job_already_scheduled(job):
        return job
    updated = await _apply_import_queue_transition(pool, job, transition)
    await _invalidate_user_analytics(user.id)
    return updated


async def queue_import_job_for_user(
    pool: AsyncConnectionPool, user: User, job_id: int, persist_questions: bool | None,
    encryption_secret: str,
) -> dict:
    await users_svc.require_llm_config(
        pool, user, encryption_secret, 'AI document imports'
    )
    job = await get_import_job(pool, user, job_id)
    _ensure_import_job_queue_action_allowed(job, 'parse')
    await _ensure_import_job_has_source_artifact(pool, job_id)
    if _import_job_already_scheduled(job):
        return job
    transition = _queue_transition_for_parse(persist_questions if persist_questions is not None else True)
    updated = await _apply_import_queue_transition(pool, job, transition)
    await _invalidate_user_analytics(user.id)
    return updated


async def record_import_job_failure(
    pool: AsyncConnectionPool, job_id: int, claim_version: int, error_code: str, import_err: Exception | None
) -> dict:
    message = '导入失败，请稍后重试或联系管理员。'
    error_code = error_code.strip() or IMPORT_WORKER_FAILED_CODE
    internal_payload = _marshal_json_string(
        {'last_internal_error': str(import_err) if import_err else ''}
    )
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                """
                WITH inserted AS (
                    INSERT INTO question_import_job_events (
                        job_id, stage, step_code, step_label, status, message, overall_progress_percent, step_progress_percent
                    )
                    VALUES (%s, 'failed', 'import_failed', '导入失败', 'failed', %s, 100, 100)
                    RETURNING *
                )
                SELECT row_to_json(inserted)::text FROM inserted
                """,
                (job_id, message),
            )
            event = _decode_map((await cursor.fetchone())[0])
            event_id = event['id']
            cursor = await conn.execute(
                """
                WITH updated AS (
                    UPDATE question_import_jobs
                    SET
                        status = 'failed',
                        stage = 'failed',
                        last_error = %s,
                        last_error_code = %s,
                        error_payload = %s,
                        available_at = NULL,
                        overall_progress_percent = 100,
                        step_progress_percent = 100,
                        last_event_id = %s,
                        last_event_at = NOW(),
                        completed_at = NOW()
                    WHERE id = %s AND status = 'processing' AND claim_version = %s
                    RETURNING *
                )
                SELECT row_to_json(updated)::text FROM updated
                """,
                (message, error_code, internal_payload, event_id, job_id, claim_version),
            )
            row = await cursor.fetchone()
            if row is None:
                raise _NoRowsError()
            return _decode_job(row[0])


class _NoRowsError(Exception):
    pass


_CHILDREN_QUERIES = {
    'events': 'SELECT row_to_json(item)::text FROM (SELECT * FROM question_import_job_events WHERE job_id = %s ORDER BY id DESC LIMIT 100) item',
    'artifacts': 'SELECT row_to_json(item)::text FROM (SELECT * FROM question_import_job_artifacts WHERE job_id = %s ORDER BY id) item',
    'outputs': 'SELECT row_to_json(item)::text FROM (SELECT * FROM question_import_job_outputs WHERE job_id = %s ORDER BY id LIMIT 200) item',
}


async def list_import_job_children(
    pool: AsyncConnectionPool, user: User, job_id: int, kind: str
) -> list[dict]:
    await get_import_job(pool, user, job_id)
    query = _CHILDREN_QUERIES.get(kind)
    if query is None:
        raise envelope.new_error(400, 'INVALID_IMPORT_CHILD_KIND', 'Unsupported import child kind')
    async with pool.connection() as conn:
        cursor = await conn.execute(query, (job_id,))
        return [_decode_map(row[0]) for row in await cursor.fetchall()]
