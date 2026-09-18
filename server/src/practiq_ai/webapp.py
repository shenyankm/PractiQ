"""Typed upload metadata route mounted by Agent Server."""

import asyncio
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response

from practiq_ai import task_api
from practiq_ai.config import load, service_token
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


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await asyncio.to_thread(load)
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(JsonBodyLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)


def authorize(authorization: str | None = Header(default=None)) -> None:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(token, service_token()):
        raise HTTPException(401, "Invalid service token")


async def _task_response(operation: Any) -> dict[str, Any]:
    try:
        return await operation
    except DocumentProcessingError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code, "message": exc.detail}) from exc
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        raise HTTPException(code if code in {404, 409, 410, 422} else 503,
                            {"code": "TASK_SERVICE_ERROR", "message": "Agent Server request failed"}) from exc
    except httpx.RequestError as exc:
        raise HTTPException(503, {"code": "TASK_SERVICE_UNAVAILABLE", "message": "Agent Server is unavailable"}) from exc


@app.post("/api/document-tasks", status_code=202, dependencies=[Depends(authorize)])
async def create_document_task(request: DocumentTaskCreate) -> dict[str, Any]:
    return await _task_response(task_api.create_task(request))


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
    dependencies=[Depends(authorize)],
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


@app.put("/api/uploads/content", dependencies=[Depends(authorize)])
async def upload_content(request: Request, metadata: Annotated[DocumentUploadRequest, Query()]) -> DocumentReference:
    """Private, bounded binary upload; references never expose filesystem paths."""
    try:
        store = await asyncio.to_thread(get_object_store)
        await store.prepare_document(metadata)
        assert metadata.sizeBytes is not None
        payload = bytearray()
        async for chunk in request.stream():
            if len(payload) + len(chunk) > metadata.sizeBytes:
                raise DocumentProcessingError(413, "Uploaded file exceeds declared size", "DOCUMENT_TOO_LARGE")
            payload.extend(chunk)
        document = await store.put_document(bytes(payload), metadata)
        return document
    except DocumentProcessingError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code, "message": exc.detail}) from exc
