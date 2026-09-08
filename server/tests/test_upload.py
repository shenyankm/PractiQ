import hashlib

import pytest
from httpx import ASGITransport, AsyncClient

from practiq_ai import webapp
from practiq_ai.contracts import (
    DocumentReference,
    DocumentUploadResponse,
    document_source_key,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.webapp import app


class UploadStore:
    async def prepare_document(self, request):
        digest = request.sha256
        return DocumentUploadResponse(
            document=DocumentReference(
                objectKey=document_source_key(request.sourceType, digest),
                sha256=digest,
                mediaType=request.mediaType,
                sizeBytes=request.sizeBytes,
                sourceType=request.sourceType,
                fileName=request.fileName,
            ),
            upload=None,
        )


async def test_upload_returns_typed_content_addressed_reference(monkeypatch):
    monkeypatch.setattr(webapp, "get_object_store", lambda: UploadStore())
    request = {
        "sourceType": "text",
        "fileName": "quiz.txt",
        "mediaType": "text/plain",
        "sizeBytes": 4,
        "sha256": hashlib.sha256(b"quiz").hexdigest(),
    }
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test", headers={"Authorization": "Bearer test-token"}
    ) as client:
        first = await client.post("/api/uploads", json=request)
        second = await client.post("/api/uploads", json=request)

    assert first.status_code == 201
    assert first.json() == second.json()
    assert first.json()["upload"] is None
    assert first.json()["document"]["sizeBytes"] == 4
    assert first.json()["document"]["objectKey"].startswith(
        "practiq-agent/sources/"
    )

async def test_upload_maps_storage_errors(monkeypatch):
    class FailingStore:
        async def prepare_document(self, _request):
            raise DocumentProcessingError(
                502, "Object storage is unavailable", "OBJECT_STORE_UNAVAILABLE"
            )

    monkeypatch.setattr(webapp, "get_object_store", lambda: FailingStore())
    request = {
        "sourceType": "pdf",
        "fileName": "quiz.pdf",
        "mediaType": "application/pdf",
        "sizeBytes": 1,
        "sha256": "a" * 64,
    }
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test", headers={"Authorization": "Bearer test-token"}
    ) as client:
        response = await client.post("/api/uploads", json=request)
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "OBJECT_STORE_UNAVAILABLE"


async def test_upload_validation_and_removed_v3_route() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test", headers={"Authorization": "Bearer test-token"}
    ) as client:
        invalid = [
            await client.post("/api/uploads", json=payload)
            for payload in (
                {},
                {"sourceType": "text", "text": "ZmlsZSBjb250ZW50"},
                {"sourceType": "pdf", "url": "https://example.com/quiz.pdf"},
                {"sourceType": "pdf", "base64": "AAAA"},
            )
        ]
        removed = await client.post("/api/v3/uploads", json={})

    assert all(response.status_code == 422 for response in invalid)
    assert removed.status_code == 404


async def test_lifespan_validates_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def loaded() -> None:
        nonlocal calls
        calls += 1

    monkeypatch.setattr(webapp, "load", loaded)
    async with webapp.lifespan(app):
        assert calls == 1

    def invalid() -> None:
        raise ValueError("invalid configuration")

    monkeypatch.setattr(webapp, "load", invalid)
    with pytest.raises(ValueError, match="invalid configuration"):
        async with webapp.lifespan(app):
            pass
