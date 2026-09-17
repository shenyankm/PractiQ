"""Typed upload metadata route mounted by Agent Server."""

import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response

from practiq_ai.config import load, service_token
from practiq_ai.contracts import (
    ArtifactReference,
    DocumentReference,
    DocumentUploadRequest,
    DocumentUploadResponse,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.product.app import create_app
from practiq_ai.storage import get_object_store


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    load()
    yield


app = create_app(fallback=False)
app.router.lifespan_context = lifespan


def authorize(authorization: str | None = Header(default=None)) -> None:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(token, service_token()):
        raise HTTPException(401, "Invalid service token")



@app.post(
    "/api/uploads",
    status_code=201,
    response_model=DocumentUploadResponse,
    dependencies=[Depends(authorize)],
)
async def upload_document(request: DocumentUploadRequest) -> DocumentUploadResponse:
    try:
        return await get_object_store().prepare_document(request)
    except DocumentProcessingError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.detail},
        ) from exc


@app.post("/api/artifacts/read", dependencies=[Depends(authorize)])
async def read_artifact(reference: ArtifactReference) -> Response:
    """Private verified download; never expose service credentials to clients."""
    try:
        payload = await get_object_store().get_verified(reference)
    except DocumentProcessingError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code, "message": exc.detail}) from exc
    return Response(payload, media_type=reference.mediaType,
                    headers={"Cache-Control": "no-store"})


@app.put("/api/uploads/content", dependencies=[Depends(authorize)])
async def upload_content(request: Request, metadata: Annotated[DocumentUploadRequest, Query()]) -> DocumentReference:
    """Private, bounded binary upload; references never expose filesystem paths."""
    try:
        store = get_object_store()
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
