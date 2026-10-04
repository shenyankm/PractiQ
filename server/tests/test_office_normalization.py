"""Office preparation retains raw provenance and deterministic sheet boundaries."""

import hashlib
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal, cast
from uuid import uuid4

import pytest

from practiq_ai import execution, normalization, office_service, task_api
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskCreate,
    DocumentTaskReparse,
    DocumentUploadRequest,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document
from tests.db_support import setup_api
from tests.support import MemoryStore, make_blank_pdf, make_image, object_store, parsed

pytestmark = pytest.mark.usefixtures("disposable_databases")


async def setup_office(monkeypatch, tmp_path, kind: Literal["docx", "xlsx"] = "xlsx", responses=None):
    service, _, model = await setup_api(monkeypatch, responses or [parsed("First"), parsed("Second")])
    engine = tmp_path / "soffice"
    engine.write_bytes(b"fake engine identity")
    monkeypatch.setenv("AI_OFFICE_EXECUTABLE", str(engine))
    monkeypatch.setenv("AI_OFFICE_VERSION", "LibreOffice 26.8.0.3")
    store = object_store(tmp_path / "files")
    fixture = Path(__file__).parents[2] / f'app/fixtures/office/{"中文 表格" if kind in {"xls", "xlsx"} else "中文 试卷"}.{kind}'
    payload = fixture.read_bytes()
    media = {"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
             "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}[kind]
    reference = await store.put_document(payload, DocumentUploadRequest(sourceType=kind, mediaType=media,
        fileName=fixture.name, sizeBytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
    for owner in (task_api, execution, document, normalization):
        monkeypatch.setattr(owner, "get_object_store", lambda: store)
    identity = {"version": "LibreOffice 26.8.0.3", "sha256": hashlib.sha256(engine.read_bytes()).hexdigest()}
    monkeypatch.setattr(office_service, "engine_identity", lambda _: identity)
    return service, reference, model, store, identity


async def test_two_sheet_import_retains_raw_source_order_mode_and_per_call_usage(monkeypatch, tmp_path):
    def respond(messages, schema):
        return parsed("First" if messages[-1].content.endswith("First") else "Second")

    service, reference, model, store, identity = await setup_office(monkeypatch, tmp_path, responses=[respond] * 4)
    conversions = []

    async def convert(raw, payload, **options):
        conversions.append((raw, payload, options))
        return [office_service.ConvertedSource("Sheet1.csv", "csv", "text/csv", b"First", True),
                office_service.ConvertedSource("Hidden.csv", "csv", "text/csv", b"Second", True),
                office_service.ConvertedSource("Empty.csv", "csv", "text/csv", b"", False)]

    async def extract(kind, payload):
        assert kind == "csv"
        return ExtractedDocument(payload.decode())

    monkeypatch.setattr(office_service, "convert_office", convert)
    monkeypatch.setattr(document, "extract", extract)
    request = DocumentTaskCreate(requestId=uuid4(), document=reference, officeMode="text")
    receipt = await task_api.create_task(request)
    assert await task_api.create_task(request) == receipt
    await service.wait_idle()
    detail = await task_api.get_task(receipt["threadId"])
    assert detail["state"] == "COMPLETED", detail
    assert len(model.calls) == 2 and len(detail["usage"]) == 2
    assert [q["stem"] for q in detail["result"]["questions"]] == ["First", "Second"]
    task, snapshot, _ = await task_api._read_task(service, receipt["threadId"])
    assert task["document"] == reference.model_dump(mode="json")
    assert snapshot.values["execution"]["document"] == reference.model_dump(mode="json")
    manifest = snapshot.values["normalization"]
    assert manifest["engine"] == identity and manifest["mode"] == "text"
    assert [item["name"] for item in manifest["sources"]] == ["Sheet1.csv", "Hidden.csv", "Empty.csv"]
    assert [item["hasContent"] for item in manifest["sources"]] == [True, True, False]
    assert len(conversions) == 1 and conversions[0][0] == reference
    assert conversions[0][1] == await store.get_verified(reference)
    assert 0 < conversions[0][2]["timeout"] <= 180
    assert snapshot.values["chunkSources"] == [{"fileName": "Sheet1.csv", "sourceType": "csv", "sourceIndex": 0},
                                               {"fileName": "Hidden.csv", "sourceType": "csv", "sourceIndex": 1}]
    assert len((await task_api.list_tasks(sha256=reference.sha256, office_mode="text"))["items"]) == 1
    assert not (await task_api.list_tasks(sha256=reference.sha256, office_mode="pdf"))["items"]
    with pytest.raises(DocumentProcessingError) as conflict:
        await task_api.create_task(request.model_copy(update={"officeMode": "pdf"}))
    assert conflict.value.code == "REQUEST_CONFLICT"
    child = await task_api.reparse_task(receipt["threadId"], DocumentTaskReparse(requestId=uuid4()))
    await service.wait_idle()
    _, child_snapshot, _ = await task_api._read_task(service, child["threadId"])
    assert child_snapshot.values["officeMode"] == "text" and len(conversions) == 2


async def test_durable_manifest_replays_without_conversion_and_rejects_cross_source_or_engine(monkeypatch, tmp_path):
    _, reference, _, store, identity = await setup_office(monkeypatch, tmp_path, kind="docx")
    calls = []

    async def convert(*args, **kwargs):
        calls.append(args)
        return [office_service.ConvertedSource("source.txt", "text", "text/plain", b"First", True)]

    monkeypatch.setattr(office_service, "convert_office", convert)
    runtime = cast(Any, SimpleNamespace(store=MemoryStore(), execution_info=SimpleNamespace(thread_id="task", run_id="run")))
    state = {"document": reference.model_dump(mode="json"), "officeMode": "text"}
    first = await normalization.normalize_source(state, runtime)
    assert await normalization.normalize_source(state, runtime) == first
    assert len(calls) == 1
    manifest = first["normalization"]
    altered = {**manifest, "engine": {**identity, "sha256": "0" * 64}}
    with pytest.raises(DocumentProcessingError) as changed:
        await normalization.verified_normalization(reference, altered, mode="text", store=store, config=normalization.load())
    assert changed.value.code == "EXECUTION_VERSION_MISMATCH"
    item = manifest["sources"][0]
    unrelated = {**manifest, "sources": [{**item, "reference": {**item["reference"], "objectKey": item["reference"]["objectKey"].replace(reference.sha256, "0" * 64, 1)}}]}
    with pytest.raises(DocumentProcessingError) as invalid:
        await normalization.verified_normalization(reference, unrelated, mode="text", store=store, config=normalization.load())
    assert invalid.value.code == "INVALID_OBJECT_REFERENCE"
    target = store._path(item["reference"]["objectKey"])
    target.write_bytes(b"wrong")
    with pytest.raises(DocumentProcessingError):
        await normalization.normalize_source(state, runtime)
    assert len(calls) == 1


async def test_sheet_text_limit_is_shared_and_does_not_merge_sheet_chunks(monkeypatch, tmp_path):
    _, reference, _, store, identity = await setup_office(monkeypatch, tmp_path)
    monkeypatch.setenv("AI_MAX_TOTAL_INPUT_CHARS", "9")
    refs = [await store.put_artifact(payload, source_sha256=reference.sha256, kind="office", index=index, media_type="text/csv")
            for index, payload in enumerate((b"First", b"Second"))]
    manifest = normalization.OfficeNormalization(sourceSha256=reference.sha256, mode="text", engine=identity,
        sources=[normalization.NormalizedSource(index=index, name=f"Sheet{index}.csv", sourceType="csv", hasContent=True, reference=ref)
                 for index, ref in enumerate(refs)])

    async def extract(kind, payload):
        return ExtractedDocument(payload.decode())

    monkeypatch.setattr(document, "extract", extract)
    state = cast(Any, {"document": reference.model_dump(mode="json"), "normalization": manifest.model_dump(mode="json")})
    prepared = await document._prepare(state)
    assert prepared["truncated"] and len(prepared["textUnits"]) == 2
    assert await store.get_verified(DocumentReference.model_validate(reference))
    state.update(prepared)
    chunks = await document._assemble(state)
    assert len(chunks["chunkRefs"]) == 2
    assert chunks["chunkSpans"][0]["end"] <= chunks["chunkSpans"][1]["start"]


async def test_failed_manifest_write_cannot_advance_to_extraction_or_models(monkeypatch, tmp_path):
    service, reference, model, _, _ = await setup_office(monkeypatch, tmp_path, kind="docx")

    async def convert(*args, **kwargs):
        return [office_service.ConvertedSource("source.txt", "text", "text/plain", b"First", True)]

    original = service.db.store.aput

    async def fail(namespace, key, value, **options):
        if namespace[-1] == "normalization":
            raise OSError("durable write unavailable")
        return await original(namespace, key, value, **options)

    monkeypatch.setattr(office_service, "convert_office", convert)
    monkeypatch.setattr(service.db.store, "aput", fail)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference, officeMode="text"))
    await service.wait_idle()
    result = await task_api.get_task(receipt["threadId"])
    assert result["state"] == "FAILED" and result["blocking"] == ["EXECUTION_STORE_UNAVAILABLE"]
    _, snapshot, _ = await task_api._read_task(service, receipt["threadId"])
    assert not snapshot.values["normalization"] and not snapshot.values["textRef"]
    assert not model.calls


async def test_separate_sheets_with_same_printed_source_id_remain_separate_questions(monkeypatch, tmp_path):
    def respond(messages, schema):
        result = parsed("First" if messages[-1].content.endswith("First") else "Second")
        result["questions"][0]["id"] = "printed:1"
        return result

    service, reference, model, _, _ = await setup_office(monkeypatch, tmp_path, responses=[respond] * 2)

    async def convert(*args, **kwargs):
        return [office_service.ConvertedSource("A.csv", "csv", "text/csv", b"First", True),
                office_service.ConvertedSource("B.csv", "csv", "text/csv", b"Second", True)]

    async def extract(kind, payload):
        return ExtractedDocument(payload.decode())

    monkeypatch.setattr(office_service, "convert_office", convert)
    monkeypatch.setattr(document, "extract", extract)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference, officeMode="text"))
    await service.wait_idle()
    detail = await task_api.get_task(receipt["threadId"])
    assert detail["state"] == "COMPLETED", detail
    assert [q["stem"] for q in detail["result"]["questions"]] == ["First", "Second"]
    assert [q["id"] for q in detail["result"]["questions"]] == ["q0", "q1"]
    assert len(model.calls) == 2


async def test_material_and_blank_anchors_remain_with_their_own_sheet(monkeypatch, tmp_path):
    def respond(messages, schema):
        stem = "First" if messages[-1].content.endswith("First") else "Second"
        return {"questions": [
            {"id": "fragment:1:bank", "stem": stem, "sourceText": stem, "answerMode": "word_bank",
             "options": [{"label": "A", "content": "word"}], "passage": [
                 {"partType": "text", "textValue": stem}, {"partType": "blank", "questionId": "fragment:1:bank:1"}]},
            {"id": "fragment:1:bank:1", "parentId": "fragment:1:bank", "optionSourceId": "fragment:1:bank",
             "stem": stem + " gap", "sourceText": stem, "answerMode": "choice", "choiceVariant": "single",
             "answerPayload": {"correct": ["A"]}}], "groups": []}

    service, reference, model, _, _ = await setup_office(monkeypatch, tmp_path, responses=[respond] * 2)

    async def convert(*args, **kwargs):
        return [office_service.ConvertedSource("A.csv", "csv", "text/csv", b"First", True),
                office_service.ConvertedSource("B.csv", "csv", "text/csv", b"Second", True)]

    async def extract(kind, payload):
        return ExtractedDocument(payload.decode())

    monkeypatch.setattr(office_service, "convert_office", convert)
    monkeypatch.setattr(document, "extract", extract)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference, officeMode="text"))
    await service.wait_idle()
    detail = await task_api.get_task(receipt["threadId"])
    assert detail["state"] == "COMPLETED", detail
    questions = detail["result"]["questions"]
    assert len(questions) == 4
    assert [(q["parentId"], q["optionSourceId"]) for q in (questions[1], questions[3])] == [("q0", "q0"), ("q2", "q2")]
    assert [q["passage"][-1]["questionId"] for q in (questions[0], questions[2])] == ["q1", "q3"]
    assert len(model.calls) == 2


@pytest.mark.parametrize("kind", ["docx", "xlsx"])
async def test_office_default_pdf_uses_existing_page_graph_and_preserves_raw_reference(monkeypatch, tmp_path, kind):
    service, reference, model, _, _ = await setup_office(monkeypatch, tmp_path, kind=kind, responses=[parsed()])

    async def convert(*args, **kwargs):
        assert kwargs["mode"] == "pdf"
        return [office_service.ConvertedSource("source.pdf", "pdf", "application/pdf", make_blank_pdf(1), True)]

    async def extract(source_type, payload):
        assert source_type == "pdf"
        return ExtractedDocument("First", page_images=[make_image()])

    monkeypatch.setattr(office_service, "convert_office", convert)
    monkeypatch.setattr(document, "extract", extract)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference))
    await service.wait_idle()
    detail = await task_api.get_task(receipt["threadId"])
    assert detail["state"] == "COMPLETED", detail
    assert detail["result"]["questions"][0]["stem"] == "First"
    _, snapshot, _ = await task_api._read_task(service, receipt["threadId"])
    assert snapshot.values["effectiveSourceType"] == "pdf" and not snapshot.values["chunkSources"]
    assert snapshot.values["document"] == reference.model_dump(mode="json")
    assert len(model.calls) == 1


@pytest.mark.parametrize("change", ["wrong-mode", "wrong-source", "wrong-type", "two-writer-sources", "unsafe-name", "duplicate-index"])
async def test_invalid_manifest_is_never_treated_as_valid_resume_input(monkeypatch, tmp_path, change):
    _, reference, _, store, identity = await setup_office(monkeypatch, tmp_path, kind="docx")
    artifact = await store.put_artifact(b"First", source_sha256=reference.sha256, kind="office", index=0, media_type="text/plain")
    source = {"index": 0, "name": "source.txt", "sourceType": "text", "hasContent": True, "reference": artifact.model_dump(mode="json")}
    manifest = {"sourceSha256": reference.sha256, "mode": "text", "engine": identity, "sources": [source]}
    if change == "wrong-mode":
        manifest["mode"] = "pdf"
    elif change == "wrong-source":
        manifest["sourceSha256"] = "0" * 64
    elif change == "wrong-type":
        source["sourceType"] = "csv"
    elif change == "two-writer-sources":
        manifest["sources"].append({**source, "index": 1, "name": "other.txt"})
    elif change == "unsafe-name":
        source["name"] = "../outside.txt"
    else:
        source["index"] = 2
    with pytest.raises(DocumentProcessingError) as failure:
        await normalization.verified_normalization(reference, manifest, mode="text", store=store, config=normalization.load())
    assert failure.value.code == "OFFICE_MANIFEST_INVALID"
