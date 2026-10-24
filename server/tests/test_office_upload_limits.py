"""Office's converter ceiling applies before upload IO or queue admission."""

import hashlib
import struct
from pathlib import Path
from urllib.parse import urlencode
from uuid import uuid4

import httpx
import pytest

from practiq_ai import office, office_service, task_api, webapp
from practiq_ai.contracts import (
    DOCUMENT_MEDIA_TYPES,
    DocumentReference,
    DocumentTaskCreate,
    DocumentUploadRequest,
)
from practiq_ai.errors import DocumentProcessingError
from tests.db_support import setup_api
from tests.support import object_store

OFFICE_LIMIT = 25 * 1024 * 1024


def metadata(source_type, size):
    return DocumentUploadRequest(sourceType=source_type, fileName=f"source.{source_type}",
        mediaType=next(iter(DOCUMENT_MEDIA_TYPES[source_type])), sizeBytes=size, sha256="a" * 64)


@pytest.mark.parametrize("source_type", ["doc", "docx", "xls", "xlsx"])
async def test_office_metadata_is_rejected_before_storage_io(tmp_path, monkeypatch, source_type):
    store = object_store(tmp_path, source_max_bytes=30 * 1024 * 1024)
    async def unexpected_io(_key):
        pytest.fail("Oversized Office metadata must not access storage")
    monkeypatch.setattr(store, "_head_size", unexpected_io)
    with pytest.raises(DocumentProcessingError) as error:
        await store.prepare_document(metadata(source_type, OFFICE_LIMIT + 1))
    assert error.value.status_code == 413 and error.value.code == "DOCUMENT_TOO_LARGE"

    request = metadata(source_type, OFFICE_LIMIT + 1)
    reference = DocumentReference(objectKey=f"practiq-agent/sources/{request.sha256}/source.{source_type}", **request.model_dump())
    with pytest.raises(DocumentProcessingError) as error:
        await store.get_verified(reference)
    assert error.value.status_code == 413 and error.value.code == "DOCUMENT_TOO_LARGE"


async def test_source_specific_boundary_preserves_larger_non_office_limit(tmp_path):
    store = object_store(tmp_path, source_max_bytes=30 * 1024 * 1024)
    assert (await store.prepare_document(metadata("docx", OFFICE_LIMIT))).document.sizeBytes == OFFICE_LIMIT
    assert (await store.prepare_document(metadata("pdf", OFFICE_LIMIT + 1))).document.sizeBytes == OFFICE_LIMIT + 1
    with pytest.raises(DocumentProcessingError):
        await object_store(tmp_path, source_max_bytes=1234).prepare_document(metadata("docx", 1235))
    assert office.FILE_LIMIT == office_service.FILE_LIMIT == OFFICE_LIMIT


@pytest.mark.parametrize("configured", [1234, 30 * 1024 * 1024])
async def test_capabilities_report_effective_office_limit(monkeypatch, tmp_path, configured):
    engine = tmp_path / "soffice"
    engine.write_bytes(b"fake deployed engine")
    monkeypatch.setenv("AI_OFFICE_EXECUTABLE", str(engine))
    monkeypatch.setenv("AI_OFFICE_VERSION", "LibreOffice 26.8.0.3")
    monkeypatch.setenv("AI_SOURCE_MAX_BYTES", str(configured))
    monkeypatch.setenv("AI_TENCENT_SECRET_ID", "synthetic-id")
    monkeypatch.setenv("AI_TENCENT_SECRET_KEY", "synthetic-key")
    response = await webapp.import_capabilities()
    assert response.sourceMaxBytes == configured
    assert response.model_dump()["officeSourceMaxBytes"] == min(OFFICE_LIMIT, configured)
    monkeypatch.delenv("AI_OFFICE_EXECUTABLE")
    monkeypatch.delenv("AI_OFFICE_VERSION")
    assert (await webapp.import_capabilities()).model_dump()["officeSourceMaxBytes"] == min(8 * 1024 * 1024, configured)
    monkeypatch.delenv("AI_TENCENT_SECRET_KEY")
    assert (await webapp.import_capabilities()).model_dump()["officeSourceMaxBytes"] is None


async def test_binary_upload_rejects_office_metadata_before_consuming_body(tmp_path, monkeypatch):
    store = object_store(tmp_path, source_max_bytes=30 * 1024 * 1024)
    monkeypatch.setattr(webapp, "get_object_store", lambda: store)
    monkeypatch.setenv("AI_SERVICE_TOKEN", "test-service-token")
    async def body():
        pytest.fail("Oversized Office upload must not consume its body")
        yield b"unreachable"
    request = metadata("docx", OFFICE_LIMIT + 1)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url="http://test",
                                headers={"Authorization": "Bearer test-service-token"}) as client:
        response = await client.put("/api/uploads/content?" + urlencode(request.model_dump()), content=body())
    assert response.status_code == 413 and response.json()["detail"]["code"] == "DOCUMENT_TOO_LARGE"
    assert not list(tmp_path.rglob("source.docx"))


@pytest.mark.parametrize("corruption", ["extract_version", "utf8_filename"])
async def test_malformed_ooxml_central_directory_returns_structured_upload_error(tmp_path, monkeypatch, corruption):
    source = (Path(__file__).parents[2] / "app/fixtures/office/中文 试卷.docx").read_bytes()
    store = object_store(tmp_path)
    monkeypatch.setattr(webapp, "get_object_store", lambda: store)
    monkeypatch.setenv("AI_SERVICE_TOKEN", "test-service-token")
    payload = bytearray(source)
    central = payload.index(b"PK\x01\x02")
    if corruption == "extract_version":
        struct.pack_into("<H", payload, central + 6, 200)
    else:
        flags = struct.unpack_from("<H", payload, central + 8)[0]
        struct.pack_into("<H", payload, central + 8, flags | 0x800)
        payload[central + 46] = 0xff

    async def upload(client, data):
        request = DocumentUploadRequest(sourceType="docx", fileName="source.docx",
            mediaType=next(iter(DOCUMENT_MEDIA_TYPES["docx"])), sizeBytes=len(data),
            sha256=hashlib.sha256(data).hexdigest())
        prepared = await client.post("/api/uploads", json=request.model_dump())
        assert prepared.status_code == 201
        return await client.put(prepared.json()["upload"]["url"], content=data,
                                headers=prepared.json()["upload"]["headers"])

    transport = httpx.ASGITransport(app=webapp.app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test",
                                headers={"Authorization": "Bearer test-service-token"}) as client:
        valid = await upload(client, source)
        assert valid.status_code == 200
        response = await upload(client, bytes(payload))
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "OFFICE_INPUT_INVALID"
    assert await store.get_verified(DocumentReference.model_validate(valid.json())) == source
    assert len(list(tmp_path.rglob("source.docx"))) == 1


@pytest.mark.usefixtures("disposable_databases")
async def test_direct_office_task_is_rejected_before_queue_admission(monkeypatch, tmp_path):
    service, _, model = await setup_api(monkeypatch)
    engine = tmp_path / "soffice"
    engine.write_bytes(b"fake deployed engine")
    monkeypatch.setenv("AI_OFFICE_EXECUTABLE", str(engine))
    monkeypatch.setenv("AI_OFFICE_VERSION", "LibreOffice 26.8.0.3")
    monkeypatch.setenv("AI_SOURCE_MAX_BYTES", str(30 * 1024 * 1024))
    request = metadata("docx", OFFICE_LIMIT + 1)
    reference = DocumentReference(objectKey=f"practiq-agent/sources/{request.sha256}/source.docx", **request.model_dump())
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference))
    assert error.value.status_code == 413 and error.value.code == "DOCUMENT_TOO_LARGE"
    assert await service.db.rows("SELECT thread_id FROM document_tasks") == []
    assert await service.db.rows("SELECT run_id FROM document_runs") == []
    assert model.calls == []


@pytest.mark.usefixtures("disposable_databases")
@pytest.mark.parametrize("source_type,size", [("docx",9 * 1024 * 1024), ("xls",1024)])
async def test_missing_converter_rejects_office_task_before_queueing(monkeypatch, source_type, size):
    service, _, model = await setup_api(monkeypatch)
    monkeypatch.delenv('AI_OFFICE_EXECUTABLE', raising=False)
    monkeypatch.delenv('AI_OFFICE_VERSION', raising=False)
    request = metadata(source_type,size)
    reference = DocumentReference(objectKey=f"practiq-agent/sources/{request.sha256}/source.{source_type}", **request.model_dump())
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference))
    assert error.value.code == 'OFFICE_NOT_CONFIGURED'
    assert not await service.db.rows('SELECT thread_id FROM document_tasks') and not model.calls
