"""Import job routes. Mirrors the import half of imports_ai_handlers.go."""

from __future__ import annotations

from fastapi import APIRouter, Request
from starlette.datastructures import UploadFile

from .. import envelope
from ..services import imports as imports_svc
from ..services import imports_upload
from . import deps

router = APIRouter()

MAX_IMPORT_ARTIFACT_JSON_BYTES = imports_svc.IMPORT_SOURCE_MAX_BYTES * 4 // 3 + 1024 * 1024


@router.get('/api/v1/import-jobs')
async def list_jobs(request: Request):
    user = await deps.current_user(request)
    limit = deps.query_page_limit(request, 100)
    data = await imports_svc.list_import_jobs(
        deps.pool(request), user,
        request.query_params.get('status', '').strip(),
        request.query_params.get('cursor', ''),
        limit,
    )
    return envelope.ok(request, data.items, data.page_info.as_meta())


@router.post('/api/v1/import-jobs')
async def create_job(request: Request):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'bankId', 'fileName', 'sourceType', 'requestPayload'})
    bank_id = body.get('bankId') if isinstance(body.get('bankId'), int) else None
    file_name = body.get('fileName') if isinstance(body.get('fileName'), str) else None
    source_type = body.get('sourceType') if isinstance(body.get('sourceType'), str) else ''
    request_payload = body.get('requestPayload') if isinstance(body.get('requestPayload'), dict) else None
    job = await imports_svc.create_import_job(
        deps.pool(request), user, bank_id, file_name, source_type, request_payload
    )
    return envelope.created(request, job)


@router.get('/api/v1/import-jobs/{job_id}')
async def get_job(request: Request, job_id: str):
    user = await deps.current_user(request)
    job = await imports_svc.get_import_job(
        deps.pool(request), user, deps.parse_path_id(job_id, 'jobId')
    )
    return envelope.ok(request, job)


@router.post('/api/v1/import-jobs/{job_id}/file')
async def upload_job_file(request: Request, job_id: str):
    user = await deps.current_user(request)
    parsed_job_id = deps.parse_path_id(job_id, 'jobId')
    content_type = request.headers.get('content-type', '').lower()
    if 'multipart/form-data' in content_type:
        form = await request.form()
        upload = form.get('file')
        if not isinstance(upload, UploadFile):
            raise envelope.new_error(400, 'FILE_REQUIRED', 'Upload file is required')
        payload = await upload.read()
        artifact = await imports_upload.add_import_job_uploaded_file(
            deps.pool(request), user, parsed_job_id,
            imports_upload.UploadedImportFile(
                name=upload.filename or '',
                content_type=upload.content_type or '',
                content=payload,
            ),
        )
        return envelope.created(request, artifact)

    body_bytes = await request.body()
    if len(body_bytes) > MAX_IMPORT_ARTIFACT_JSON_BYTES:
        raise envelope.new_error(
            413, 'FILE_TOO_LARGE', 'Import artifact exceeds the 25 MiB file limit'
        )
    import json

    try:
        body = json.loads(body_bytes) if body_bytes else {}
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise envelope.invalid_json() from exc
    if not isinstance(body, dict) or any(
        key not in ('artifactType', 'storagePath', 'content', 'sourceType') for key in body
    ):
        raise envelope.invalid_json()
    storage_path = body.get('storagePath')
    artifact = await imports_svc.add_import_job_file(
        deps.pool(request), user, parsed_job_id,
        imports_svc.AddImportJobFileInput(
            artifact_type=body.get('artifactType') if isinstance(body.get('artifactType'), str) else 'source_file',
            storage_path=storage_path.strip() or None if isinstance(storage_path, str) else None,
            content=body.get('content') if isinstance(body.get('content'), dict) else None,
            source_type=body.get('sourceType') if isinstance(body.get('sourceType'), str) else '',
        ),
    )
    return envelope.created(request, artifact)


@router.post('/api/v1/import-jobs/{job_id}/{action}')
async def job_action(request: Request, job_id: str, action: str):
    user = await deps.current_user(request)
    parsed_job_id = deps.parse_path_id(job_id, 'jobId')
    if action in ('retry', 'cancel'):
        job = await imports_svc.update_import_job_status(
            deps.pool(request), user, parsed_job_id, action,
            request.app.state.config.llm_key_encryption_secret,
        )
        return envelope.ok(request, job)
    if action == 'parse':
        body = await deps.decode_json_body(request, {'persistQuestions'}, allow_empty=True)
        persist = body.get('persistQuestions') if isinstance(body.get('persistQuestions'), bool) else None
        job = await imports_svc.queue_import_job_for_user(
            deps.pool(request), user, parsed_job_id, persist,
            request.app.state.config.llm_key_encryption_secret,
        )
        return envelope.ok(request, job)
    raise envelope.new_error(404, 'NOT_FOUND', 'Endpoint not found')


@router.get('/api/v1/import-jobs/{job_id}/{kind}')
async def job_children(request: Request, job_id: str, kind: str):
    user = await deps.current_user(request)
    if kind not in ('events', 'artifacts', 'outputs'):
        raise envelope.validation_error(
            [envelope.ValidationDetail('kind', 'unsupported import child kind')]
        )
    items = await imports_svc.list_import_job_children(
        deps.pool(request), user, deps.parse_path_id(job_id, 'jobId'), kind
    )
    return envelope.ok(request, items)
