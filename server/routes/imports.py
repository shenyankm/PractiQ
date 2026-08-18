"""Import-job routes."""

import asyncio
import json
import time
from typing import Any, Literal

from fastapi import APIRouter, Body, Request
from pydantic import ValidationError
from starlette.background import BackgroundTask
from starlette.datastructures import UploadFile
from starlette.responses import StreamingResponse

from .. import envelope
from ..services import imports as imports_svc
from ..services import imports_upload
from . import deps

router = APIRouter()
SSE_POLL_SECONDS = 1.0
SSE_HEARTBEAT_SECONDS = 15.0
SSE_MAX_CONNECTION_SECONDS = 60.0
SSE_MAX_CONNECTIONS = 100
TERMINAL_IMPORT_STATUSES = {'completed', 'failed', 'cancelled'}
_active_import_streams: set[tuple[int, int]] = set()

class CreateImportJobBody(deps.RequestBody):
    bank_id: int | None = None
    file_name: str | None = None
    source_type: str = ''
    request_payload: dict[str, Any] | None = None


class UploadArtifactBody(deps.RequestBody):
    artifact_type: str = 'source_file'
    storage_path: str | None = None
    content: dict[str, Any] | None = None
    source_type: str = ''


class ParseImportBody(deps.RequestBody):
    persist_questions: bool | None = None


@router.get('/api/v1/import-jobs')
async def list_jobs(
    request: Request,
    status: str = '',
    cursor: str = '',
    limit: deps.PageLimit100 = None,
):
    user = await deps.current_user(request)
    data = await imports_svc.list_import_jobs(
        deps.pool(request), user, status.strip(), cursor, limit or 0
    )
    return envelope.ok(request, data.items, data.page_info.as_meta())


@router.post('/api/v1/import-jobs')
async def create_job(request: Request, body: CreateImportJobBody):
    user = await deps.current_user(request)
    job = await imports_svc.create_import_job(
        deps.pool(request),
        user,
        body.bank_id,
        body.file_name,
        body.source_type,
        body.request_payload,
    )
    return envelope.created(request, job)


@router.get('/api/v1/import-jobs/{job_id}')
async def get_job(request: Request, job_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request, await imports_svc.get_import_job(deps.pool(request), user, job_id)
    )


@router.post('/api/v1/import-jobs/{job_id}/file')
async def upload_job_file(request: Request, job_id: deps.PositiveId):
    """Accept multipart uploads or the legacy JSON artifact representation."""
    user = await deps.current_user(request)
    content_type = request.headers.get('content-type', '').lower()
    if 'multipart/form-data' in content_type:
        upload = (await request.form()).get('file')
        if not isinstance(upload, UploadFile):
            raise envelope.new_error(400, 'FILE_REQUIRED', 'Upload file is required')
        artifact = await imports_upload.add_import_job_uploaded_file(
            deps.pool(request),
            user,
            job_id,
            imports_upload.UploadedImportFile(
                name=upload.filename or '',
                content_type=upload.content_type or '',
                content=await upload.read(),
            ),
        )
        return envelope.created(request, artifact)

    body_bytes = await request.body()
    try:
        body = UploadArtifactBody.model_validate_json(body_bytes or b'{}')
    except ValidationError as exc:
        raise envelope.invalid_json() from exc
    artifact = await imports_svc.add_import_job_file(
        deps.pool(request),
        user,
        job_id,
        imports_svc.AddImportJobFileInput(
            artifact_type=body.artifact_type,
            storage_path=(body.storage_path or '').strip() or None,
            content=body.content,
            source_type=body.source_type,
        ),
    )
    return envelope.created(request, artifact)


@router.get('/api/v1/import-jobs/{job_id}/stream')
async def stream_job_events(request: Request, job_id: deps.PositiveId):
    user = await deps.current_user(request)
    pool = deps.pool(request)
    await imports_svc.get_import_job(pool, user, job_id)
    raw_cursor = request.headers.get('last-event-id', '').strip()
    try:
        after_id = int(raw_cursor or '0')
    except ValueError as exc:
        raise envelope.new_error(
            400, 'INVALID_LAST_EVENT_ID', 'Last-Event-ID must be a non-negative integer'
        ) from exc
    if after_id < 0:
        raise envelope.new_error(
            400, 'INVALID_LAST_EVENT_ID', 'Last-Event-ID must be a non-negative integer'
        )
    if after_id and not await imports_svc.import_job_event_exists(
        pool, job_id, after_id
    ):
        raise envelope.new_error(
            400, 'INVALID_LAST_EVENT_ID', 'Last-Event-ID does not belong to this import job'
        )

    stream_key = (user.id, job_id)
    if (
        stream_key in _active_import_streams
        or len(_active_import_streams) >= SSE_MAX_CONNECTIONS
    ):
        raise envelope.new_error(
            429, 'IMPORT_STREAM_LIMIT', 'Too many active import event streams'
        )
    _active_import_streams.add(stream_key)

    async def events():
        cursor = after_id
        started = last_heartbeat = time.monotonic()
        try:
            while (
                time.monotonic() - started < SSE_MAX_CONNECTION_SECONDS
                and not await request.is_disconnected()
            ):
                items = await imports_svc.list_import_job_events_after(
                    pool, job_id, cursor
                )
                for item in items:
                    cursor = item['id']
                    yield (
                        f'id: {cursor}\n'
                        f'data: {json.dumps(item, ensure_ascii=False, separators=(",", ":"))}\n\n'
                    )
                    if item.get('status') in TERMINAL_IMPORT_STATUSES:
                        return
                if not items:
                    current = await imports_svc.get_import_job(pool, user, job_id)
                    if current.get('status') in TERMINAL_IMPORT_STATUSES:
                        return
                now = time.monotonic()
                if now - last_heartbeat >= SSE_HEARTBEAT_SECONDS:
                    yield ': heartbeat\n\n'
                    last_heartbeat = now
                await asyncio.sleep(
                    min(SSE_POLL_SECONDS, SSE_MAX_CONNECTION_SECONDS - (now - started))
                )
        finally:
            _active_import_streams.discard(stream_key)

    return StreamingResponse(
        events(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
        background=BackgroundTask(_active_import_streams.discard, stream_key),
    )


@router.post('/api/v1/import-jobs/{job_id}/{action}')
async def job_action(
    request: Request,
    job_id: deps.PositiveId,
    action: Literal['retry', 'cancel', 'parse'],
    body: ParseImportBody | None = Body(default=None),
):
    user = await deps.current_user(request)
    if action in ('retry', 'cancel'):
        job = await imports_svc.update_import_job_status(
            deps.pool(request),
            user,
            job_id,
            action,
            request.app.state.config.llm_key_encryption_secret,
        )
    else:
        job = await imports_svc.queue_import_job_for_user(
            deps.pool(request),
            user,
            job_id,
            body.persist_questions if body else None,
            request.app.state.config.llm_key_encryption_secret,
        )
    return envelope.ok(request, job)


@router.get('/api/v1/import-jobs/{job_id}/{kind}')
async def job_children(
    request: Request,
    job_id: deps.PositiveId,
    kind: Literal['events', 'artifacts', 'outputs'],
):
    user = await deps.current_user(request)
    items = await imports_svc.list_import_job_children(
        deps.pool(request), user, job_id, kind
    )
    return envelope.ok(request, items)
