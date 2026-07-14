from __future__ import annotations

import hmac
import os
from io import BytesIO
from pathlib import Path
from tempfile import SpooledTemporaryFile
from typing import Annotated, Any
from zipfile import BadZipFile, ZipFile

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .documents import (
    MAX_DOCX_ENTRIES,
    MAX_DOCX_EXPANDED_BYTES,
    DocumentProcessingError,
    get_upload_max_bytes,
)
from .schemas import (
    DocumentParseRequest,
    DocumentParseResult,
    FileUploadWorkflowRequest,
    ParseMethod,
)
from .workflows import Operation, invoke_workflow

TEXT_EXTENSIONS = frozenset({'.txt'})
DOCUMENT_EXTENSIONS = frozenset({'.docx', '.pdf'})
SCAN_EXTENSIONS = frozenset({'.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff'})
MIME_TYPES = {
    '.txt': frozenset({'text/plain'}),
    '.docx': frozenset({'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),
    '.pdf': frozenset({'application/pdf'}),
    '.jpg': frozenset({'image/jpeg'}),
    '.jpeg': frozenset({'image/jpeg'}),
    '.png': frozenset({'image/png'}),
    '.gif': frozenset({'image/gif'}),
    '.webp': frozenset({'image/webp'}),
    '.bmp': frozenset({'image/bmp', 'image/x-ms-bmp'}),
    '.tif': frozenset({'image/tiff'}),
    '.tiff': frozenset({'image/tiff'}),
}
UPLOAD_PATHS = frozenset(
    {
        '/internal/ai/upload-text',
        '/internal/ai/upload-document',
        '/internal/ai/upload-scan',
    }
)
LEGACY_DOCUMENT_PATH = '/internal/ai/parse-document'
GUARDED_DOCUMENT_PATHS = UPLOAD_PATHS | {LEGACY_DOCUMENT_PATH}
UPLOAD_BODY_OVERHEAD_BYTES = 1024 * 1024


class UploadGuardMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        path = scope.get('path')
        if scope['type'] != 'http' or path not in GUARDED_DOCUMENT_PATHS:
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope['headers']}
        authorization = headers.get(b'authorization', b'').decode('latin-1')
        auth_error = _authentication_error(authorization)
        if auth_error:
            await _error_response(*auth_error)(scope, receive, send)
            return

        max_file_bytes = get_upload_max_bytes()
        max_body_bytes = (
            max_file_bytes
            if path in UPLOAD_PATHS
            else ((max_file_bytes + 2) // 3) * 4
        ) + UPLOAD_BODY_OVERHEAD_BYTES
        content_length = headers.get(b'content-length')
        if content_length:
            try:
                if int(content_length) > max_body_bytes:
                    await _error_response(413, 'Uploaded request is too large')(scope, receive, send)
                    return
            except ValueError:
                await _error_response(400, 'Invalid Content-Length header')(scope, receive, send)
                return

        with SpooledTemporaryFile(max_size=1024 * 1024) as body:
            received_bytes = 0
            while True:
                message = await receive()
                if message['type'] != 'http.request':
                    return
                chunk = message.get('body', b'')
                received_bytes += len(chunk)
                if received_bytes > max_body_bytes:
                    await _error_response(413, 'Uploaded request is too large')(
                        scope, receive, send
                    )
                    return
                body.write(chunk)
                if not message.get('more_body', False):
                    break

            body.seek(0)

            async def replay_receive() -> Message:
                chunk = body.read(1024 * 1024)
                return {
                    'type': 'http.request',
                    'body': chunk,
                    'more_body': body.tell() < received_bytes,
                }

            await self.app(scope, replay_receive, send)


def _authentication_error(authorization: str | None) -> tuple[int, str] | None:
    expected = os.getenv('AI_SERVICE_TOKEN', '').strip()
    if not expected:
        return 503, 'AI service authentication is not configured'
    if not authorization or not hmac.compare_digest(authorization, f'Bearer {expected}'):
        return 401, 'Unauthorized'
    return None


def _error_response(status_code: int, detail: str) -> JSONResponse:
    headers = {'WWW-Authenticate': 'Bearer'} if status_code == 401 else None
    return JSONResponse({'detail': detail}, status_code=status_code, headers=headers)


app = FastAPI()
app.add_middleware(UploadGuardMiddleware)


def _require_token(authorization: Annotated[str | None, Header()] = None) -> None:
    error = _authentication_error(authorization)
    if error:
        status_code, detail = error
        raise HTTPException(
            status_code=status_code,
            detail=detail,
            headers={'WWW-Authenticate': 'Bearer'} if status_code == 401 else None,
        )


@app.get('/internal/health/live')
def live() -> dict[str, bool]:
    return {'ok': True}


@app.get('/internal/health/ready')
def ready() -> dict[str, bool]:
    if not os.getenv('AI_SERVICE_TOKEN', '').strip():
        raise HTTPException(
            status_code=503,
            detail='AI service authentication is not configured',
        )
    return {'ok': True}


@app.post('/internal/ai/parse-document', dependencies=[Depends(_require_token)])
def parse_document(payload: DocumentParseRequest) -> dict[str, Any]:
    return _run_document_workflow('parse_document', payload).model_dump()


@app.post(
    '/internal/ai/upload-text',
    dependencies=[Depends(_require_token)],
    response_model=DocumentParseResult,
)
def upload_text(
    file: Annotated[UploadFile, File()],
    importJobId: Annotated[int | None, Form(gt=0)] = None,
    bankId: Annotated[int | None, Form(gt=0)] = None,
) -> DocumentParseResult:
    return _run_upload(file, TEXT_EXTENSIONS, 'auto', importJobId, bankId)


@app.post(
    '/internal/ai/upload-document',
    dependencies=[Depends(_require_token)],
    response_model=DocumentParseResult,
)
def upload_document(
    file: Annotated[UploadFile, File()],
    importJobId: Annotated[int | None, Form(gt=0)] = None,
    bankId: Annotated[int | None, Form(gt=0)] = None,
) -> DocumentParseResult:
    return _run_upload(file, DOCUMENT_EXTENSIONS, 'auto', importJobId, bankId)


@app.post(
    '/internal/ai/upload-scan',
    dependencies=[Depends(_require_token)],
    response_model=DocumentParseResult,
)
def upload_scan(
    file: Annotated[UploadFile, File()],
    importJobId: Annotated[int | None, Form(gt=0)] = None,
    bankId: Annotated[int | None, Form(gt=0)] = None,
) -> DocumentParseResult:
    return _run_upload(file, SCAN_EXTENSIONS, 'ocr', importJobId, bankId)


@app.post('/internal/ai/generate-answer', dependencies=[Depends(_require_token)])
def generate_answer(payload: dict[str, Any]) -> dict[str, Any]:
    return invoke_workflow('generate_answer', payload).model_dump()


@app.post('/internal/ai/learning-report', dependencies=[Depends(_require_token)])
def learning_report(payload: dict[str, Any]) -> dict[str, Any]:
    return invoke_workflow('learning_report', payload).model_dump()


def _run_upload(
    file: UploadFile,
    allowed_extensions: frozenset[str],
    parse_method: ParseMethod,
    import_job_id: int | None,
    bank_id: int | None,
) -> DocumentParseResult:
    file_name, extension, mime_type, content = _read_upload(file, allowed_extensions)
    source_type = (
        'txt'
        if extension == '.txt'
        else 'docx'
        if extension == '.docx'
        else 'pdf'
        if extension == '.pdf'
        else 'image'
    )
    payload = FileUploadWorkflowRequest(
        importJobId=import_job_id,
        bankId=bank_id,
        sourceType=source_type,
        fileName=file_name,
        fileBytes=content,
        mimeType=mime_type,
        parseMethod=parse_method,
    )
    return _run_document_workflow('parse_upload', payload)


def _run_document_workflow(
    operation: Operation,
    payload: DocumentParseRequest | FileUploadWorkflowRequest,
) -> DocumentParseResult:
    try:
        result = invoke_workflow(operation, payload)
    except DocumentProcessingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    if not isinstance(result, DocumentParseResult):
        raise RuntimeError('document workflow returned an unexpected result')
    return result


def _read_upload(
    file: UploadFile,
    allowed_extensions: frozenset[str],
) -> tuple[str, str, str, bytes]:
    file_name = Path(file.filename or '').name
    extension = Path(file_name).suffix.lower()
    if not file_name or extension not in allowed_extensions:
        raise HTTPException(status_code=415, detail='Unsupported file type')
    if len(file_name) > 255:
        raise HTTPException(status_code=400, detail='File name is too long')

    mime_type = (file.content_type or 'application/octet-stream').split(';', 1)[0].strip().lower()
    if mime_type != 'application/octet-stream' and mime_type not in MIME_TYPES[extension]:
        raise HTTPException(status_code=415, detail='File MIME type does not match its extension')

    max_bytes = get_upload_max_bytes()
    content = file.file.read(max_bytes + 1)
    if not content:
        raise HTTPException(status_code=400, detail='Uploaded file is empty')
    if len(content) > max_bytes:
        raise HTTPException(status_code=413, detail='Uploaded file is too large')
    _validate_file_signature(extension, content)
    return file_name, extension, mime_type, content


def _validate_file_signature(extension: str, content: bytes) -> None:
    valid = True
    if extension == '.txt':
        try:
            content.decode('utf-8-sig')
        except UnicodeDecodeError:
            valid = False
    elif extension == '.docx':
        try:
            with ZipFile(BytesIO(content)) as archive:
                infos = archive.infolist()
                valid = 'word/document.xml' in {info.filename for info in infos}
                if len(infos) > MAX_DOCX_ENTRIES or sum(
                    info.file_size for info in infos
                ) > MAX_DOCX_EXPANDED_BYTES:
                    raise HTTPException(status_code=413, detail='DOCX expanded content is too large')
        except BadZipFile:
            valid = False
    elif extension == '.pdf':
        valid = b'%PDF-' in content[:1024]
    elif extension in {'.jpg', '.jpeg'}:
        valid = content.startswith(b'\xff\xd8\xff')
    elif extension == '.png':
        valid = content.startswith(b'\x89PNG\r\n\x1a\n')
    elif extension == '.gif':
        valid = content.startswith((b'GIF87a', b'GIF89a'))
    elif extension == '.webp':
        valid = len(content) >= 12 and content.startswith(b'RIFF') and content[8:12] == b'WEBP'
    elif extension == '.bmp':
        valid = content.startswith(b'BM')
    elif extension in {'.tif', '.tiff'}:
        valid = content.startswith((b'II*\x00', b'MM\x00*'))

    if not valid:
        raise HTTPException(status_code=400, detail='File content does not match its extension')
