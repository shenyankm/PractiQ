"""Authenticated document APIs with a SQLite-backed LangGraph runtime."""

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from sqlite3 import Error as DatabaseError
from typing import Annotated, Any
from uuid import UUID
from weakref import WeakKeyDictionary

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from practiq_ai import task_api
from practiq_ai.config import load
from practiq_ai.contracts import (
    ArtifactReference,
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
    DocumentUploadRequest,
    DocumentUploadResponse,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.middleware import JsonBodyLimitMiddleware, SecurityHeadersMiddleware
from practiq_ai.storage import get_object_store
from practiq_ai.telemetry import configure_logging, registry


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    from . import runtime
    from .database import Database
    configure_logging()
    settings = await asyncio.to_thread(load)
    service = runtime.Service(Database())
    await service.start()
    runtime.current = service
    try:
        yield
    finally:
        await service.stop(timeout=10 if settings.desktop_mode else 60)
        runtime.current = None


app = FastAPI(lifespan=lifespan)
app.add_middleware(JsonBodyLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
_uploads: WeakKeyDictionary[asyncio.AbstractEventLoop, int] = WeakKeyDictionary()


def authorize(authorization: str | None = Header(default=None)) -> None:
    from .auth import authenticate
    authenticate(authorization)


async def upload_slot() -> AsyncGenerator[None]:
    config = load()
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


@app.get("/api/metrics", dependencies=[Depends(authorize)])
async def application_metrics() -> Response:
    from .runtime import current
    body = generate_latest(registry)
    if current:
        rows = await current.db.rows("SELECT status,count(*) AS n FROM document_runs WHERE status IN ('pending','running') GROUP BY status")
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


async def _task_response(operation: Any) -> dict[str, Any]:
    try:
        return await operation
    except DocumentProcessingError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code, "message": exc.detail}) from exc
    except TimeoutError as exc:
        raise HTTPException(504, {"code": "CONTROL_TIMEOUT", "message": "Task preflight timed out"}) from exc
    except DatabaseError as exc:
        raise HTTPException(503, {"code": "TASK_SERVICE_UNAVAILABLE", "message": "Task database is unavailable"}) from exc


@app.post("/api/document-tasks", status_code=202, dependencies=[Depends(authorize)])
async def create_document_task(request: DocumentTaskCreate) -> dict[str, Any]:
    return await _task_response(task_api.create_task(request))


@app.get("/api/document-tasks", dependencies=[Depends(authorize)])
async def list_document_tasks(limit: int = Query(default=20, ge=1, le=100), offset: int = Query(default=0, ge=0)):
    return await _task_response(task_api.list_tasks(limit, offset))


@app.get("/api/document-tasks/{thread_id}", dependencies=[Depends(authorize)])
async def get_document_task(thread_id: UUID) -> dict[str, Any]:
    return await _task_response(task_api.get_task(str(thread_id)))


@app.post("/api/document-tasks/{thread_id}/control", status_code=202, dependencies=[Depends(authorize)])
async def control_document_task(thread_id: UUID, request: DocumentTaskControl) -> dict[str, Any]:
    return await _task_response(task_api.control_task(str(thread_id), request))



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
        payload = await (await asyncio.to_thread(get_object_store)).get_verified(reference)
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
