"""Authenticated document APIs with a PostgreSQL-backed LangGraph runtime."""

import asyncio
import os
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, BinaryIO, get_args
from uuid import UUID
from weakref import WeakKeyDictionary

from anyio import CancelScope
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.staticfiles import StaticFiles
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from psycopg import Error as DatabaseError
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from practiq_ai import task_api
from practiq_ai.bank_export import ZIP_CHUNK_BYTES
from practiq_ai.config import load, require_model_config
from practiq_ai.contracts import (
    OFFICE_SOURCE_TYPES,
    ArtifactReference,
    DocumentReference,
    DocumentSourceType,
    DocumentTaskControl,
    DocumentTaskCreate,
    DocumentTaskDetail,
    DocumentTaskHead,
    DocumentTaskList,
    DocumentTaskReceipt,
    DocumentTaskReparse,
    DocumentTaskReview,
    DocumentUploadRequest,
    DocumentUploadResponse,
    ImportCapabilities,
    OfficeMode,
    document_source_key,
    document_source_limit,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.execution import supported_task_sql
from practiq_ai.extractors.isolated import _thread_io
from practiq_ai.grading import GradeWireRequest, grade
from practiq_ai.middleware import JsonBodyLimitMiddleware, SecurityHeadersMiddleware
from practiq_ai.storage import get_object_store
from practiq_ai.telemetry import configure_logging, registry


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    from . import runtime
    from .database import Database
    configure_logging()
    await asyncio.to_thread(load)
    service = runtime.Service(Database())
    await service.start()
    runtime.current = service
    try:
        yield
    finally:
        await service.stop(timeout=60)
        runtime.current = None


app = FastAPI(lifespan=lifespan)
app.add_middleware(JsonBodyLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
_uploads: WeakKeyDictionary[asyncio.AbstractEventLoop, int] = WeakKeyDictionary()
_exports: WeakKeyDictionary[asyncio.AbstractEventLoop, int] = WeakKeyDictionary()


async def export_slot() -> AsyncGenerator[None]:
    # Hold one bounded archive build/download per loop until its response closes.
    loop = asyncio.get_running_loop()
    if _exports.get(loop, 0):
        raise HTTPException(429, {"code": "BANK_EXPORT_BUSY"}, headers={"Retry-After": "1"})
    _exports[loop] = 1
    try:
        yield
    finally:
        _exports[loop] = 0


class BankZipResponse(StreamingResponse):
    def __init__(self, payload: BinaryIO, filename: str):
        self.file = payload
        payload.seek(0, 2)
        size = payload.tell()
        payload.seek(0)
        super().__init__(self.chunks(), media_type="application/zip", headers={
            "Content-Length": str(size), "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{filename}"'})

    async def chunks(self) -> AsyncIterator[bytes]:
        while chunk := await _thread_io(self.file.read, ZIP_CHUNK_BYTES):
            yield chunk

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            # Includes disconnect before the iterator starts and cancelled reads.
            self.file.close()


def authorize(authorization: str | None = Header(default=None)) -> None:
    from .auth import authenticate
    authenticate(authorization)


async def upload_slot() -> AsyncGenerator[None]:
    try:
        config = load()
    except DocumentProcessingError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code, "message": exc.detail}) from exc
    loop = asyncio.get_running_loop()
    if config.maintenance:
        raise HTTPException(503, {"code": "MAINTENANCE"})
    if _uploads.get(loop, 0) >= config.upload_concurrency:
        raise HTTPException(429, {"code": "UPLOAD_BUSY"}, headers={"Retry-After": "1"})
    _uploads[loop] = _uploads.get(loop, 0) + 1
    try:
        yield
    finally:
        _uploads[loop] -= 1


def model_configured() -> None:
    try:
        require_model_config()
    except DocumentProcessingError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code, "message": exc.detail}) from exc


@app.get("/api/metrics", dependencies=[Depends(authorize)])
async def application_metrics() -> Response:
    from .runtime import current
    body = generate_latest(registry)
    if current:
        rows = await current.db.rows(f"SELECT r.status,count(*) AS n FROM document_runs r JOIN document_tasks t ON t.thread_id=r.thread_id WHERE r.status IN ('pending','running') AND {supported_task_sql('t')} GROUP BY r.status")
        counts = {row['status']: row['n'] for row in rows}
        jobs = load().jobs_per_worker
        body += (f"practiq_pending_runs {counts.get('pending', 0)}\n"
                 f"practiq_running_runs {counts.get('running', 0)}\n"
                 f"practiq_queue_capacity {load().max_busy_threads}\n"
                 f"practiq_workers_max {jobs}\n"
                 f"practiq_workers_available {max(0, jobs - len(current.active))}\n").encode()
    return Response(body, headers={"Content-Type": CONTENT_TYPE_LATEST})


@app.get("/api/maintenance", dependencies=[Depends(authorize)])
async def maintenance_status() -> dict[str, bool]:
    return {"enabled": load().maintenance}


@app.get("/api/import-capabilities", response_model=ImportCapabilities, dependencies=[Depends(authorize)])
async def import_capabilities() -> ImportCapabilities:
    settings = load()
    office = settings.office_executable is not None and settings.office_executable.is_file()
    return ImportCapabilities(sourceTypes=[kind for kind in get_args(DocumentSourceType) if office or kind not in OFFICE_SOURCE_TYPES],
                              sourceMaxBytes=settings.source_max_bytes, officeAvailable=office,
                              officeSourceMaxBytes=document_source_limit("docx", settings.source_max_bytes) if office else None,
                              officeModes=["pdf", "text"] if office else [], modelConfigured=not settings.read_only)


async def _task_response(operation: Any) -> dict[str, Any]:
    try:
        return await operation
    except DocumentProcessingError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code, "message": exc.detail}) from exc
    except TimeoutError as exc:
        raise HTTPException(504, {"code": "CONTROL_TIMEOUT", "message": "Task preflight timed out"}) from exc
    except DatabaseError as exc:
        raise HTTPException(503, {"code": "TASK_SERVICE_UNAVAILABLE", "message": "Task database is unavailable"}) from exc


@app.post("/api/document-tasks", status_code=202, response_model=DocumentTaskReceipt, dependencies=[Depends(authorize)])
async def create_document_task(request: DocumentTaskCreate) -> dict[str, Any]:
    return await _task_response(task_api.create_task(request))


@app.get("/api/document-tasks", response_model=DocumentTaskList, dependencies=[Depends(authorize)])
async def list_document_tasks(limit: int = Query(default=20, ge=1, le=100), offset: int = Query(default=0, ge=0),
                              sha256: str | None = Query(default=None, pattern=r'^[a-f0-9]{64}$'),
                              state_filter: task_api.TaskFilter | None = None, officeMode: OfficeMode | None = None,
                              cursor: str | None = Query(default=None, max_length=2048)):
    return await _task_response(task_api.list_tasks(limit, offset, sha256, state_filter, officeMode, cursor))


@app.get("/api/document-tasks/{thread_id}", response_model=DocumentTaskDetail, dependencies=[Depends(authorize)])
async def get_document_task(thread_id: UUID) -> dict[str, Any]:
    return await _task_response(task_api.get_task(str(thread_id)))


@app.get("/api/document-tasks/{thread_id}/head", response_model=DocumentTaskHead, dependencies=[Depends(authorize)])
async def get_document_task_head(thread_id: UUID) -> dict[str, Any]:
    return await _task_response(task_api.get_task_head(str(thread_id)))


@app.delete("/api/document-tasks/{thread_id}", dependencies=[Depends(authorize)])
async def delete_document_task(thread_id: UUID) -> dict[str, bool]:
    return await _task_response(task_api.delete_task(str(thread_id)))


@app.get("/api/document-tasks/{thread_id}/preview", response_model=DocumentTaskReview, dependencies=[Depends(authorize)])
async def preview_document_task(thread_id: UUID) -> dict[str, Any]:
    return await _task_response(task_api.review_task(str(thread_id)))


@app.get("/api/document-tasks/{thread_id}/export", dependencies=[Depends(authorize), Depends(export_slot)])
async def export_document_task(thread_id: UUID, checkpoint_id: str | None = Query(default=None, max_length=255)) -> Response:
    try:
        payload = await task_api.export_task(str(thread_id), checkpoint_id)
    except DocumentProcessingError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code, "message": exc.detail}) from exc
    except DatabaseError as exc:
        raise HTTPException(503, {"code": "TASK_SERVICE_UNAVAILABLE"}) from exc
    try:
        return BankZipResponse(payload, f"practiq-bank-{thread_id}.zip")
    except BaseException:
        payload.close()
        raise


@app.post("/api/document-tasks/{thread_id}/control", status_code=202, response_model=DocumentTaskReceipt, dependencies=[Depends(authorize)])
async def control_document_task(thread_id: UUID, request: DocumentTaskControl) -> dict[str, Any]:
    return await _task_response(task_api.control_task(str(thread_id), request))


@app.post("/api/document-tasks/{thread_id}/reparse", status_code=202, response_model=DocumentTaskReceipt, dependencies=[Depends(authorize)])
async def reparse_document_task(thread_id: UUID, request: DocumentTaskReparse) -> dict[str, Any]:
    return await _task_response(task_api.reparse_task(str(thread_id), request))



@app.post(
    "/api/uploads",
    status_code=201,
    response_model=DocumentUploadResponse,
    dependencies=[Depends(authorize), Depends(upload_slot)],
)
async def upload_document(request: DocumentUploadRequest) -> DocumentUploadResponse:
    try:
        return await (await asyncio.to_thread(get_object_store)).prepare_document(request)
    except DocumentProcessingError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.detail},
        ) from exc


@app.post("/api/artifacts/read", dependencies=[Depends(authorize)])
async def read_artifact(reference: ArtifactReference) -> Response:
    """Private verified download; never expose service credentials to clients."""
    try:
        checked: ArtifactReference | DocumentReference = reference
        if (reference.mediaType in {"image/png", "image/jpeg"}
                and reference.objectKey == document_source_key("image", reference.sha256)):
            checked = DocumentReference(sourceType="image", fileName=None, **reference.model_dump())
        payload = await (await asyncio.to_thread(get_object_store)).get_verified(checked)
    except DocumentProcessingError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code, "message": exc.detail}) from exc
    return Response(payload, media_type=reference.mediaType,
                    headers={"Cache-Control": "no-store"})


@app.put("/api/uploads/content", dependencies=[Depends(authorize), Depends(upload_slot)])
async def upload_content(request: Request, metadata: Annotated[DocumentUploadRequest, Query()]) -> DocumentReference:
    """Private, bounded binary upload; references never expose filesystem paths."""
    try:
        store = await asyncio.to_thread(get_object_store)
        await store.prepare_document(metadata)
        assert metadata.sizeBytes is not None
        payload = bytearray()
        try:
            async with asyncio.timeout(load().upload_timeout_seconds):
                async for chunk in request.stream():
                    if len(payload) + len(chunk) > metadata.sizeBytes:
                        raise DocumentProcessingError(413, "Uploaded file exceeds declared size", "DOCUMENT_TOO_LARGE")
                    payload.extend(chunk)
        except TimeoutError as exc:
            raise DocumentProcessingError(408, "Upload reception timed out", "UPLOAD_TIMEOUT") from exc
        document = await store.put_document(bytes(payload), metadata)
        return document
    except DocumentProcessingError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code, "message": exc.detail}) from exc


@app.get("/ok")
async def liveness() -> dict[str, bool]:
    return {"ok": True}


@app.get("/ready")
async def readiness() -> Response:
    from .runtime import current
    ready = current is not None and await current.ready()
    return Response(status_code=200 if ready else 503)


@app.post("/api/subjective-grades", dependencies=[Depends(authorize), Depends(upload_slot), Depends(model_configured)])
async def subjective_grade(request: GradeWireRequest) -> dict:
    validation = asyncio.create_task(asyncio.to_thread(request.verified_request))
    try:
        verified = await asyncio.shield(validation)
    except asyncio.CancelledError:
        # Keep upload capacity until the worker releases its potentially large body.
        with CancelScope(shield=True):
            while not validation.done():
                try:
                    await asyncio.shield(validation)
                except (asyncio.CancelledError, ValueError):
                    pass
        validation.exception()
        raise
    except ValueError as exc:
        raise HTTPException(422, {"code": "GRADING_INPUT_INVALID", "message": "Grading input or digest is invalid", "params": {}}) from exc
    return await _task_response(grade(verified))


class WebStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope) -> Response:
        if scope["method"] not in {"GET", "HEAD"}:
            # Unknown/removed API routes keep their existing 404 semantics even
            # when the optional frontend is mounted at the root.
            raise HTTPException(404, "Not Found")
        return await super().get_response(path, scope)


def mount_web(application: FastAPI, directory: Path) -> None:
    """An absent optional frontend does not prevent API deployments from starting."""
    if (directory / "index.html").is_file():
        application.mount("/", WebStaticFiles(directory=directory, html=True), name="web")


mount_web(app, Path(os.environ.get("AI_WEB_DIR", str(Path(__file__).resolve().parents[3] / "web/dist"))))
