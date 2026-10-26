"""Office preparation retains raw provenance and deterministic sheet boundaries."""

import base64
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal, cast
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from practiq_ai import execution, messaging, normalization, office_service, task_api
from practiq_ai.contracts import (
    DocumentTaskControl,
    DocumentTaskCreate,
    DocumentTaskReparse,
    DocumentUploadRequest,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document
from tests.db_support import setup_api
from tests.support import (
    MemoryStore,
    make_blank_pdf,
    make_image,
    object_store,
    ocr_text_page,
    parsed,
    tencent_provider,
)

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


async def test_tencent_office_pages_retain_raw_source_order_receipts_and_usage(monkeypatch, tmp_path):
    def respond(messages, schema):
        return parsed("First" if "PRIMARY is page 1" in messages[1].content else "Second")

    service, reference, model, _, _ = await setup_office(monkeypatch, tmp_path, responses=[respond] * 4)
    calls = tencent_provider(monkeypatch, [ocr_text_page("First"), ocr_text_page("Second")])
    convert = AsyncMock(side_effect=AssertionError("Small Office sources go directly to Tencent"))
    monkeypatch.setattr(office_service, "convert_office", convert)
    request = DocumentTaskCreate(requestId=uuid4(), document=reference)
    receipt = await task_api.create_task(request)
    assert await task_api.create_task(request) == receipt
    await service.wait_idle()
    detail = await task_api.get_task(receipt["threadId"])
    assert detail["state"] == "COMPLETED", detail
    assert len(model.calls) == len(detail["usage"]) == 2
    assert [q["stem"] for q in detail["result"]["questions"]] == ["First", "Second"]
    task, snapshot, _ = await task_api._read_task(service, receipt["threadId"])
    assert task["document"] == snapshot.values["execution"]["document"] == reference.model_dump(mode="json")
    assert snapshot.values["normalization"] is None and len(snapshot.values["ocrPageRefs"]) == 2
    from practiq_ai.office import prepare_workbook
    original_bytes = await document.get_object_store().get_verified(reference)
    assert base64.b64decode(calls[0][1]["FileBase64"]) == prepare_workbook(original_bytes)[0]
    assert snapshot.values["inputParts"][0]["preparation"] == "visible_excel_sheets"
    assert snapshot.values["inputParts"][0]["reference"]["sha256"] != reference.sha256
    assert detail["parserJobs"][0]["resultSaved"] and detail["parserJobs"][0]["successPageCount"] == 2
    convert.assert_not_awaited()
    assert len(calls) == 2
    child = await task_api.reparse_task(receipt["threadId"], DocumentTaskReparse(requestId=uuid4()))
    await service.wait_idle()
    child_detail = await task_api.get_task(child["threadId"])
    assert child_detail["state"] == "COMPLETED" and len(model.calls) == 4
    assert len(calls) == 4  # Only explicit parse-again creates a second Tencent job.


async def test_durable_manifest_replays_without_conversion_and_rejects_cross_source_or_engine(monkeypatch, tmp_path):
    _, reference, _, store, identity = await setup_office(monkeypatch, tmp_path, kind="docx")
    calls = []

    async def convert(*args, **kwargs):
        calls.append(args)
        return [office_service.ConvertedSource("source.txt", "text", "text/plain", b"First", True)]

    monkeypatch.setattr(office_service, "convert_office", convert)
    runtime = cast(Any, SimpleNamespace(store=MemoryStore(), execution_info=SimpleNamespace(thread_id="task", run_id="run")))
    state = {"document": reference.model_dump(mode="json"), "officeMode": "text"}
    verified = AsyncMock(wraps=store.get_verified)
    monkeypatch.setattr(store, "get_verified", verified)
    first = await normalization.normalize_source(state, runtime)
    assert sum(call.args[0] == reference for call in verified.call_args_list) == 1
    verified.reset_mock()
    assert await normalization.normalize_source(state, runtime) == first
    assert sum(call.args[0] == reference for call in verified.call_args_list) == 1
    assert len(verified.call_args_list) == 2  # Original and cached derived artifact.
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


async def test_tencent_sheet_text_limit_is_shared_and_never_silently_truncates(monkeypatch, tmp_path):
    service, reference, model, store, _ = await setup_office(monkeypatch, tmp_path)
    monkeypatch.setenv("AI_MAX_TOTAL_INPUT_CHARS", "100")
    tencent_provider(monkeypatch, [ocr_text_page("First" * 30), ocr_text_page("Second" * 30)])
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference))
    await service.wait_idle()
    detail = await task_api.get_task(receipt["threadId"])
    assert detail["state"] == "FAILED" and detail["blocking"] == ["TENCENT_RESULT_INVALID"], detail
    assert not model.calls
    assert await store.get_verified(reference)
    assert detail["parserJobs"][0]["resultSaved"]


async def test_failed_manifest_write_cannot_advance_to_extraction_or_models(monkeypatch, tmp_path):
    service, reference, model, _, _ = await setup_office(monkeypatch, tmp_path, kind="docx")

    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", "1024")
    cloud_calls = tencent_provider(monkeypatch, [ocr_text_page("First")])

    async def convert(*args, **kwargs):
        return [office_service.ConvertedSource("source.pdf", "pdf", "application/pdf", make_blank_pdf(1), True)]

    original = service.db.store.aput

    async def fail(namespace, key, value, **options):
        if namespace[-1] == "normalization":
            raise OSError("durable write unavailable")
        return await original(namespace, key, value, **options)

    monkeypatch.setattr(office_service, "convert_office", convert)
    monkeypatch.setattr(service.db.store, "aput", fail)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference))
    await service.wait_idle()
    result = await task_api.get_task(receipt["threadId"])
    assert result["state"] == "FAILED" and result["blocking"] == ["EXECUTION_STORE_UNAVAILABLE"]
    _, snapshot, _ = await task_api._read_task(service, receipt["threadId"])
    assert not snapshot.values["normalization"] and not snapshot.values["textRef"]
    assert not model.calls and not cloud_calls


async def test_separate_sheets_with_same_printed_source_id_remain_separate_questions(monkeypatch, tmp_path):
    def respond(messages, schema):
        result = parsed("First" if "PRIMARY is page 1" in messages[1].content else "Second")
        result["questions"][0]["id"] = "page:1:printed:1" if "PRIMARY is page 1" in messages[1].content else "page:2:printed:1"
        return result

    service, reference, model, _, _ = await setup_office(monkeypatch, tmp_path, responses=[respond] * 4)

    tencent_provider(monkeypatch, [ocr_text_page("First"), ocr_text_page("Second")])

    async def convert(*args, **kwargs):
        return [office_service.ConvertedSource("A.csv", "csv", "text/csv", b"First", True),
                office_service.ConvertedSource("B.csv", "csv", "text/csv", b"Second", True)]

    async def extract(kind, payload):
        return ExtractedDocument(payload.decode())

    monkeypatch.setattr(office_service, "convert_office", convert)
    monkeypatch.setattr(document, "extract", extract)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference))
    await service.wait_idle()
    detail = await task_api.get_task(receipt["threadId"])
    assert detail["state"] == "COMPLETED", detail
    assert [q["stem"] for q in detail["result"]["questions"]] == ["First", "Second"]
    assert [q["id"] for q in detail["result"]["questions"]] == ["q0", "q1"]
    assert len(model.calls) == 4


async def test_material_and_blank_anchors_remain_with_their_own_sheet(monkeypatch, tmp_path):
    def respond(messages, schema):
        stem = "First" if "PRIMARY is page 1" in messages[1].content else "Second"
        prefix = "page:1" if "PRIMARY is page 1" in messages[1].content else "page:2"
        return {"questions": [
            {"id": prefix + ":bank", "stem": stem, "sourceText": stem, "answerMode": "word_bank",
             "options": [{"label": "A", "content": "word"}], "passage": [
                 {"partType": "text", "textValue": stem}, {"partType": "blank", "questionId": prefix + ":bank:1"}]},
            {"id": prefix + ":bank:1", "parentId": prefix + ":bank", "optionSourceId": prefix + ":bank",
             "stem": stem + " gap", "sourceText": stem, "answerMode": "choice", "choiceVariant": "single",
             "answerPayload": {"correct": ["A"]}}], "groups": []}

    service, reference, model, _, _ = await setup_office(monkeypatch, tmp_path, responses=[respond] * 4)

    tencent_provider(monkeypatch, [ocr_text_page("First"), ocr_text_page("Second")])

    async def convert(*args, **kwargs):
        return [office_service.ConvertedSource("A.csv", "csv", "text/csv", b"First", True),
                office_service.ConvertedSource("B.csv", "csv", "text/csv", b"Second", True)]

    async def extract(kind, payload):
        return ExtractedDocument(payload.decode())

    monkeypatch.setattr(office_service, "convert_office", convert)
    monkeypatch.setattr(document, "extract", extract)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference))
    await service.wait_idle()
    detail = await task_api.get_task(receipt["threadId"])
    assert detail["state"] == "COMPLETED", detail
    questions = detail["result"]["questions"]
    assert len(questions) == 4
    assert [(q["parentId"], q["optionSourceId"]) for q in (questions[1], questions[3])] == [("q0", "q0"), ("q2", "q2")]
    assert [q["passage"][-1]["questionId"] for q in (questions[0], questions[2])] == ["q1", "q3"]
    assert len(model.calls) == 4


@pytest.mark.parametrize("kind", ["docx", "xlsx"])
async def test_office_direct_tencent_uses_shared_page_graph_and_preserves_raw_reference(monkeypatch, tmp_path, kind):
    service, reference, model, _, _ = await setup_office(monkeypatch, tmp_path, kind=kind, responses=[parsed()])
    tencent_provider(monkeypatch, [ocr_text_page("First")])

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
    assert snapshot.values["effectiveSourceType"] == kind and not snapshot.values.get("chunkSources") and snapshot.values["normalization"] is None
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


@pytest.mark.parametrize("legacy_mode", ["pdf", "text"])
async def test_reparse_legacy_office_mode_uses_automatic_routing_without_rewriting_parent(monkeypatch, tmp_path, legacy_mode):
    service, reference, _, _, _ = await setup_office(monkeypatch, tmp_path, kind="docx")
    tencent_provider(monkeypatch, [ocr_text_page("First")])
    parent = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference, deduplicateQuestions=True))
    await service.wait_idle()
    async with service.db.connection() as conn:
        await conn.execute("UPDATE document_runs SET input=jsonb_set(input,'{officeMode}',%s::jsonb) WHERE run_id=%s", (json.dumps(legacy_mode),parent['runId']))
    before = await service.db.rows('SELECT input FROM document_runs WHERE run_id=%s', (parent['runId'],))
    child = await task_api.reparse_task(parent['threadId'], DocumentTaskReparse(requestId=uuid4()))
    await service.wait_idle()
    detail = await task_api.get_task(child['threadId'])
    assert detail['state'] == 'COMPLETED'
    child_input = (await service.db.rows('SELECT input FROM document_runs WHERE run_id=%s', (child['runId'],)))[0]['input']
    assert child_input.get('officeMode') is None and child_input['deduplicateQuestions']
    assert await service.db.rows('SELECT input FROM document_runs WHERE run_id=%s', (parent['runId'],)) == before


@pytest.mark.parametrize("legacy_mode", ["pdf", "text"])
@pytest.mark.parametrize("action", ["interrupt", "pause"])
@pytest.mark.parametrize("deduplicate", [False, True])
async def test_resume_legacy_office_without_checkpoint_uses_current_options_and_preserves_audit(monkeypatch, tmp_path, legacy_mode, action, deduplicate):
    service, reference, model, _, _ = await setup_office(monkeypatch, tmp_path, kind="docx")
    parser_calls = tencent_provider(monkeypatch, [ocr_text_page("First")])
    publish = messaging.publish
    monkeypatch.setattr(messaging, "publish", AsyncMock())
    parent = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference, deduplicateQuestions=deduplicate))
    await task_api.control_task(parent["threadId"], DocumentTaskControl(requestId=uuid4(), action=action, runId=parent["runId"]))
    await service.wait_idle()
    async with service.db.connection() as conn:
        await conn.execute("UPDATE document_runs SET input=jsonb_set(input,'{officeMode}',%s::jsonb) WHERE run_id=%s",
                           (json.dumps(legacy_mode), parent["runId"]))
        if not deduplicate:
            await conn.execute("UPDATE document_runs SET input=input-'deduplicateQuestions' WHERE run_id=%s", (parent["runId"],))
    task, snapshot, _ = await task_api._read_task(service, parent["threadId"])
    assert not snapshot.values and not model.calls and not parser_calls
    before_run = await service.db.rows("SELECT * FROM document_runs WHERE run_id=%s", (parent["runId"],))
    before_receipts = await service.db.rows("SELECT * FROM document_receipts WHERE thread_id=%s ORDER BY request_id", (parent["threadId"],))
    detail = await task_api.get_task(parent["threadId"])
    assert detail["state"] == ("CANCELLED" if action == "interrupt" else "PAUSED")
    assert detail["allowedActions"] == ["resume"] and detail["checkpointId"] == f'pending:{parent["runId"]}'
    monkeypatch.setattr(messaging, "publish", publish)
    request = DocumentTaskControl(requestId=uuid4(), action="resume", checkpointId=detail["checkpointId"])
    resumed = await task_api.control_task(parent["threadId"], request)
    assert await task_api.control_task(parent["threadId"], request) == resumed
    await service.wait_idle()
    detail = await task_api.get_task(parent["threadId"])
    assert detail["state"] == "COMPLETED", detail
    new_input = (await service.db.rows("SELECT input FROM document_runs WHERE run_id=%s", (resumed["runId"],)))[0]["input"]
    assert new_input == {"document": task["document"], "failurePolicy": task["failure_policy"], "deduplicateQuestions": deduplicate}
    _, snapshot, _ = await task_api._read_task(service, parent["threadId"])
    assert snapshot.values["officeMode"] is None and snapshot.values["execution"]["officeMode"] is None
    assert snapshot.values["deduplicateQuestions"] is deduplicate and snapshot.values["normalization"] is None
    assert snapshot.values["effectiveSourceType"] == "docx" and snapshot.values["execution"]["signature"] == execution.signature()
    assert len(model.calls) == 1 and len(parser_calls) == 2
    assert await service.db.rows("SELECT * FROM document_runs WHERE run_id=%s", (parent["runId"],)) == before_run
    assert await service.db.rows("SELECT * FROM document_receipts WHERE thread_id=%s AND request_id<>%s ORDER BY request_id",
                                 (parent["threadId"], str(request.requestId))) == before_receipts


@pytest.mark.parametrize("legacy_mode", ["pdf", "text"])
@pytest.mark.parametrize("action", ["resume", "retry_failed"])
async def test_control_legacy_office_checkpoint_still_requires_original_execution(monkeypatch, tmp_path, legacy_mode, action):
    invalid = {"questions": [{"stem": ""}]}
    service, reference, model, _, _ = await setup_office(monkeypatch, tmp_path, kind="docx", responses=[invalid, invalid])
    parser_calls = tencent_provider(monkeypatch, [ocr_text_page("First")])
    parent = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=reference, failurePolicy="review"))
    await service.wait_idle()
    _, snapshot, _ = await task_api._read_task(service, parent["threadId"])
    old_execution = {**snapshot.values["execution"], "officeMode": legacy_mode,
                     "signature": {**snapshot.values["execution"]["signature"], "version": "pre-Tencent"}}
    await service.graph.aupdate_state(snapshot.config, {"officeMode": legacy_mode, "execution": old_execution})
    async with service.db.connection() as conn:
        await conn.execute("UPDATE document_runs SET status='interrupted',cancel_requested=true WHERE run_id=%s", (parent["runId"],))
    _, snapshot, _ = await task_api._read_task(service, parent["threadId"])
    detail = await task_api.get_task(parent["threadId"])
    assert action in detail["allowedActions"] and not detail["resumeCompatible"], detail
    before_runs = await service.db.rows("SELECT * FROM document_runs WHERE thread_id=%s", (parent["threadId"],))
    before_receipts = await service.db.rows("SELECT * FROM document_receipts WHERE thread_id=%s", (parent["threadId"],))
    with pytest.raises(DocumentProcessingError) as failure:
        await task_api.control_task(parent["threadId"], DocumentTaskControl(requestId=uuid4(), action=action, checkpointId=detail["checkpointId"]))
    assert failure.value.code == "EXECUTION_VERSION_MISMATCH"
    _, after, _ = await task_api._read_task(service, parent["threadId"])
    assert after == snapshot
    assert await service.db.rows("SELECT * FROM document_runs WHERE thread_id=%s", (parent["threadId"],)) == before_runs
    assert await service.db.rows("SELECT * FROM document_receipts WHERE thread_id=%s", (parent["threadId"],)) == before_receipts
    assert len(model.calls) == 2 and len(parser_calls) == 2
