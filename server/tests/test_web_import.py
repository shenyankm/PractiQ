"""Authenticated Web APIs export the reviewed checkpoint without model calls."""

import hashlib
import io
import json
from uuid import uuid4
from zipfile import ZipFile

import httpx
import pytest
from fastapi import FastAPI

from practiq_ai import execution, task_api, webapp
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskCreate,
    DocumentUploadRequest,
)
from practiq_ai.graphs import document
from practiq_ai.middleware import WEB_CONTENT_SECURITY_POLICY, SecurityHeadersMiddleware
from tests.db_support import setup_api
from tests.support import make_image, object_store, upload

pytestmark = pytest.mark.usefixtures("disposable_databases")


@pytest.fixture(autouse=True)
def service_token(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_TOKEN", "test-service-token")


async def test_capabilities_are_authenticated_and_expose_only_configured_office(monkeypatch, tmp_path):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url="http://test") as client:
        assert (await client.get("/api/import-capabilities")).status_code == 401
        client.headers["Authorization"] = "Bearer test-service-token"
        response = await client.get("/api/import-capabilities")
        assert response.status_code == 200, response.text
        assert set(response.json()["sourceTypes"]) == {"csv", "image", "text", "pdf"}
        assert not response.json()["officeAvailable"] and response.json()["officeModes"] == []
        engine = tmp_path / "soffice"
        engine.write_bytes(b"fake deployed engine")
        monkeypatch.setenv("AI_OFFICE_EXECUTABLE", str(engine))
        monkeypatch.setenv("AI_OFFICE_VERSION", "LibreOffice 26.8.0.3")
        monkeypatch.setenv("AI_SOURCE_MAX_BYTES", "1234")
        response = await client.get("/api/import-capabilities")
        assert set(response.json()["sourceTypes"]) == {"csv", "image", "text", "pdf", "doc", "docx", "xls", "xlsx"}
        assert response.json()["officeAvailable"] and response.json()["officeModes"] == ["pdf", "text"]
        assert response.json()["sourceMaxBytes"] == 1234
        monkeypatch.setenv("AI_READ_ONLY", "1")
        for key in ("LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL"):
            monkeypatch.delenv(key, raising=False)
        assert not (await client.get("/api/import-capabilities")).json()["modelConfigured"]


async def test_http_bank_export_requires_current_completed_checkpoint_and_preserves_portable_result(monkeypatch, tmp_path):
    service, _, model = await setup_api(monkeypatch)
    store = object_store(tmp_path)
    reference = await store.put_document(b"quiz", upload())
    for owner in (task_api, execution, document, webapp):
        monkeypatch.setattr(owner, "get_object_store", lambda: store)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference))
    await service.wait_idle()
    detail = await task_api.get_task(receipt["threadId"])
    endpoint = f'/api/document-tasks/{receipt["threadId"]}/export'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url="http://test") as client:
        assert (await client.get(endpoint)).status_code == 401
        client.headers["Authorization"] = "Bearer test-service-token"
        stale = await client.get(endpoint, params={"checkpoint_id": "old"})
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "STALE_CHECKPOINT"
        exported = await client.get(endpoint, params={"checkpoint_id": detail["checkpointId"]})
        assert exported.status_code == 200, exported.text
        assert exported.headers["content-type"] == "application/zip"
        assert exported.headers["cache-control"] == "no-store"
        assert exported.headers["content-disposition"] == f'attachment; filename="practiq-bank-{receipt["threadId"]}.zip"'
        with ZipFile(io.BytesIO(exported.content)) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            questions = json.loads(archive.read("questions.json"))
        assert set(manifest) == {"format", "version", "bank"}
        assert questions == {key: detail[key] for key in ("status", "result", "processing")}
        assert len(model.calls) == 1
        missing = await client.get(f"/api/document-tasks/{uuid4()}/export")
        assert missing.status_code == 404


async def test_upload_remains_available_in_service_read_only_mode_but_start_is_blocked(monkeypatch, tmp_path):
    await setup_api(monkeypatch)
    store = object_store(tmp_path)
    monkeypatch.setattr(webapp, "get_object_store", lambda: store)
    monkeypatch.setenv("AI_READ_ONLY", "1")
    metadata = upload().model_dump(mode="json")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url="http://test",
                                headers={"Authorization": "Bearer test-service-token"}) as client:
        prepared = await client.post("/api/uploads", json=metadata)
        assert prepared.status_code == 201
        sent = await client.put(prepared.json()["upload"]["url"], content=b"quiz")
        assert sent.status_code == 200
        reference = DocumentReference.model_validate(sent.json())
        created = await client.post("/api/document-tasks", json={"requestId": str(uuid4()), "document": reference.model_dump(mode="json")})
        assert created.status_code == 409 and created.json()["detail"]["code"] == "MODEL_NOT_CONFIGURED"


async def test_original_image_source_is_checked_downloadable_but_other_source_keys_are_rejected(monkeypatch, tmp_path):
    store = object_store(tmp_path)
    payload = make_image()
    source = await store.put_document(payload, DocumentUploadRequest(sourceType="image", mediaType="image/png",
        fileName="original.png", sizeBytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
    monkeypatch.setattr(webapp, "get_object_store", lambda: store)
    reference = source.model_dump(include={"objectKey", "sha256", "mediaType", "sizeBytes"})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url="http://test",
                                headers={"Authorization": "Bearer test-service-token"}) as client:
        image = await client.post("/api/artifacts/read", json=reference)
        assert image.status_code == 200 and image.content == payload
        assert image.headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"
        assert (await client.post("/api/artifacts/read", json={**reference, "sha256": "0" * 64})).status_code == 422
        assert (await client.post("/api/artifacts/read", json={**reference, "sizeBytes": source.sizeBytes + 1})).status_code == 409
        assert (await client.post("/api/artifacts/read", json={**reference, "objectKey": source.objectKey.replace("source.png", "source.txt"), "mediaType": "text/plain"})).status_code == 422


async def test_optional_web_assets_preserve_api_precedence_and_missing_assets(tmp_path):
    application = FastAPI()
    application.add_middleware(SecurityHeadersMiddleware)

    @application.get("/ok")
    def ok():
        return {"ok": True}

    webapp.mount_web(application, tmp_path / "missing")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url="http://test") as client:
        assert (await client.get("/ok")).json() == {"ok": True}
        assert (await client.get("/")).status_code == 404
    (tmp_path / "index.html").write_text("<html>Import workspace</html>", encoding="utf-8")
    webapp.mount_web(application, tmp_path)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url="http://test") as client:
        assert (await client.get("/ok")).json() == {"ok": True}
        page = await client.get("/")
        assert "Import workspace" in page.text
        assert page.headers["content-security-policy"] == WEB_CONTENT_SECURITY_POLICY
        assert (await client.get("/ok")).headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"
        assert (await client.get("/../outside")).status_code == 404
        assert (await client.post("/api/v1/ai/parse-document", json={})).status_code == 404
        assert (await client.post("/threads", json={})).status_code == 404


def test_openapi_exposes_strict_shared_receipts_and_office_create_mode():
    schema = webapp.app.openapi()
    for suffix in ("", "/{thread_id}/control", "/{thread_id}/reparse"):
        assert schema["paths"]["/api/document-tasks" + suffix]["post"]["responses"]["202"]["content"]["application/json"]["schema"] == {"$ref": "#/components/schemas/DocumentTaskReceipt"}
    assert schema["components"]["schemas"]["DocumentTaskCreate"]["additionalProperties"] is False
    assert "officeMode" in schema["components"]["schemas"]["DocumentTaskCreate"]["properties"]
