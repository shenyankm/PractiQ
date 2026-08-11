"""Import source file upload + object storage paths.

Mirrors backend/internal/services/imports_upload.go.
"""

from __future__ import annotations

import base64
import os
import re
import secrets
import time
from dataclasses import dataclass
from pathlib import Path

from psycopg_pool import AsyncConnectionPool

from .. import envelope
from ..auth.runtime import User
from . import helpers
from .imports import (
    DOCX_MIME_TYPE,
    IMPORT_SOURCE_MAX_BYTES,
    INSERT_SOURCE_ARTIFACT_SQL,
    PDF_MIME_TYPE,
    SOURCE_EXTENSION_MIME_TYPES,
    XLSX_MIME_TYPE,
    _decode_map,
    _marshal_json_string,
    _source_type_from_name,
    get_import_job,
    normalize_import_source_type,
    validate_import_source_payload,
)

DEFAULT_OBJECT_STORAGE_MOUNT_DIR = '/lhcos-data'
DEFAULT_OBJECT_STORAGE_PREFIX = 'oss://practiq'

GENERIC_UPLOAD_MIME_TYPES = {'application/octet-stream', 'binary/octet-stream'}


@dataclass
class UploadedImportFile:
    name: str
    content_type: str
    content: bytes


@dataclass
class _StoredImportSource:
    relative_path: str
    object_url: str
    original_name: str
    mime_type: str
    size_bytes: int


def _first_non_empty(*values: str) -> str:
    for value in values:
        if value.strip():
            return value
    return ''


def _sanitize_storage_segment(value: str) -> str:
    trimmed = value.strip()
    if trimmed in ('', '.', '..'):
        return ''
    sanitized = re.sub(r'[ /\\:?#]', '-', trimmed)
    out = []
    last_dash = False
    for char in sanitized:
        allowed = char.isascii() and (char.isalnum() or char in '._-')
        if not allowed:
            char = '-'
        if char == '-':
            if last_dash:
                continue
            last_dash = True
        else:
            last_dash = False
        out.append(char)
    return ''.join(out).strip('-. ')


def _clean_storage_relative_path(value: str) -> str:
    segments = value.replace('\\', '/').split('/')
    cleaned = [_sanitize_storage_segment(segment) for segment in segments]
    return '/'.join(segment for segment in cleaned if segment)


def resolve_storage_path(relative_path: str) -> Path:
    mount_dir = _first_non_empty(
        os.environ.get('OBJECT_STORAGE_MOUNT_DIR', ''),
        os.environ.get('OSS_MOUNT_DIR', ''),
        DEFAULT_OBJECT_STORAGE_MOUNT_DIR,
    ).strip()
    clean_relative = _clean_storage_relative_path(relative_path)
    if not clean_relative:
        raise envelope.new_error(400, 'INVALID_STORAGE_PATH', 'Storage path is empty')
    absolute = Path(mount_dir, clean_relative).resolve()
    clean_mount = Path(mount_dir).resolve()
    if absolute != clean_mount and clean_mount not in absolute.parents:
        raise envelope.new_error(400, 'INVALID_STORAGE_PATH', 'Invalid object storage path')
    return absolute


def object_url_for_relative_path(relative_path: str) -> str:
    base = os.environ.get('OSS_PUBLIC_BASE_URL', '').strip().rstrip('/')
    clean_relative = _clean_storage_relative_path(relative_path)
    if base:
        return f'{base}/{clean_relative}'
    prefix = _first_non_empty(os.environ.get('OSS_URL_PREFIX', ''), DEFAULT_OBJECT_STORAGE_PREFIX).strip().rstrip('/')
    return f'{prefix}/{clean_relative}'


def _infer_uploaded_source_type(file: UploadedImportFile) -> str:
    kind = _source_type_from_name(file.name)
    if kind:
        return kind
    content_type = file.content_type.strip().lower()
    if content_type == DOCX_MIME_TYPE:
        return 'docx'
    if content_type == PDF_MIME_TYPE:
        return 'pdf'
    if content_type == XLSX_MIME_TYPE:
        return 'xlsx'
    if content_type == 'text/plain':
        return 'txt'
    return ''


def _resolve_import_file_extension(name: str, content_type: str) -> str:
    extension = Path(name.strip()).suffix.lower()
    if extension in ('.txt', '.docx', '.pdf', '.xlsx'):
        return extension
    content_type = content_type.strip().lower()
    if content_type == DOCX_MIME_TYPE:
        return '.docx'
    if content_type == PDF_MIME_TYPE:
        return '.pdf'
    if content_type == XLSX_MIME_TYPE:
        return '.xlsx'
    if content_type == 'text/plain':
        return '.txt'
    raise envelope.new_error(400, 'UNSUPPORTED_FILE_TYPE', f'Unsupported file type: {name.strip()}')


def _normalize_import_mime_type(extension: str, content_type: str) -> str:
    if content_type.strip():
        return content_type.strip()
    return SOURCE_EXTENSION_MIME_TYPES.get(extension, 'text/plain')


def _store_import_source_file(user_id: int, job_id: int, file: UploadedImportFile) -> tuple[_StoredImportSource, bytes]:
    payload = file.content
    if not payload:
        raise envelope.new_error(400, 'EMPTY_FILE', 'Uploaded file is empty')
    if len(payload) > IMPORT_SOURCE_MAX_BYTES:
        raise envelope.new_error(
            413, 'FILE_TOO_LARGE', f'Uploaded file exceeds {IMPORT_SOURCE_MAX_BYTES} bytes'
        )
    extension = _resolve_import_file_extension(file.name, file.content_type)
    validate_import_source_payload(extension, file.content_type, payload, file.name)

    directory = Path('imports', _sanitize_storage_segment(str(user_id)), _sanitize_storage_segment(str(job_id)))
    file_name = f'source-{int(time.time() * 1000)}-{secrets.token_hex(8)}{extension}'
    relative_path = (directory / file_name).as_posix()
    absolute_path = resolve_storage_path(relative_path)
    absolute_path.parent.mkdir(parents=True, exist_ok=True)
    absolute_path.write_bytes(payload)

    return (
        _StoredImportSource(
            relative_path=relative_path,
            object_url=object_url_for_relative_path(relative_path),
            original_name=file.name,
            mime_type=_normalize_import_mime_type(extension, file.content_type),
            size_bytes=len(payload),
        ),
        payload,
    )


def _build_import_source_artifact_content(stored: _StoredImportSource, source_type: str, payload: bytes) -> dict:
    content = {
        'objectUrl': stored.object_url,
        'objectKey': stored.relative_path,
        'originalName': stored.original_name,
        'mimeType': stored.mime_type,
        'sizeBytes': stored.size_bytes,
        'sourceType': source_type,
    }
    if source_type in ('txt', 'text'):
        content['text'] = payload.decode('utf-8').removeprefix('﻿')
    elif source_type in ('docx', 'pdf', 'xlsx'):
        content['fileBase64'] = base64.b64encode(payload).decode()
    return content


async def add_import_job_uploaded_file(
    pool: AsyncConnectionPool, user: User, job_id: int, file: UploadedImportFile
) -> dict:
    job = await get_import_job(pool, user, job_id)
    if not file.name.strip():
        raise envelope.new_error(400, 'FILE_REQUIRED', 'Upload file is required')
    if len(file.name) > 255:
        raise envelope.new_error(400, 'INVALID_FILE_NAME', 'Upload file name exceeds 255 characters')
    inferred = _infer_uploaded_source_type(file) or (job.get('source_type') or '')
    source_type = normalize_import_source_type(user, inferred)
    stored, payload = _store_import_source_file(user.id, job_id, file)
    committed = False
    try:
        content = _build_import_source_artifact_content(stored, source_type, payload)
        raw_content = _marshal_json_string(content)
        async with pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    WITH updated AS (
                        UPDATE question_import_jobs
                        SET source_type = %s, file_name = COALESCE(file_name, %s)
                        WHERE id = %s
                        RETURNING *
                    )
                    SELECT row_to_json(updated)::text FROM updated
                    """,
                    (source_type, stored.original_name, job_id),
                )
                cursor = await conn.execute(
                    INSERT_SOURCE_ARTIFACT_SQL, (job_id, 'source_file', stored.object_url, raw_content)
                )
                row = await cursor.fetchone()
                if row is None:
                    raise envelope.new_error(
                        409, 'IMPORT_SOURCE_EXISTS', 'Import job already has a source file'
                    )
                artifact = _decode_map(row[0])
        committed = True
        return artifact
    finally:
        if not committed:
            try:
                resolve_storage_path(stored.relative_path).unlink(missing_ok=True)
            except Exception:
                pass
