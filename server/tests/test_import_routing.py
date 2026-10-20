"""All supported formats use Tencent; CSV cannot enter new imports."""

import hashlib
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from practiq_ai import execution
from practiq_ai.contracts import (
    DOCUMENT_MEDIA_TYPES,
    DocumentReference,
    DocumentTaskCreate,
    DocumentUploadRequest,
    ImportSourceType,
    document_source_key,
)
from practiq_ai.graphs import document
from tests.support import (
    FakeModel,
    FakeObjectStore,
    local_graph,
    ocr_text_page,
    parsed,
    run_config,
    tencent_provider,
)


@pytest.mark.parametrize("kind", ["text", "markdown"])
async def test_text_formats_also_submit_to_tencent(monkeypatch, kind):
    payload = b"First"
    digest = hashlib.sha256(payload).hexdigest()
    reference = DocumentReference(sourceType=kind, objectKey=document_source_key(kind, digest), sha256=digest,
                                  mediaType=next(iter(DOCUMENT_MEDIA_TYPES[kind])), sizeBytes=len(payload))
    files = FakeObjectStore({reference.objectKey: payload})
    model = FakeModel(responses=[parsed("First")])
    for module in (document, execution):
        monkeypatch.setattr(module, "get_object_store", lambda: files)
    monkeypatch.setattr(document, "get_model", lambda: model)
    monkeypatch.setattr(document, "extract", AsyncMock(side_effect=AssertionError("Text recognition belongs to Tencent")))
    calls = tencent_provider(monkeypatch, [ocr_text_page("First")])
    graph = local_graph(InMemorySaver())
    config = run_config()
    output = await graph.ainvoke({"document": reference.model_dump(mode="json")}, config)
    assert output["status"] == "SUCCEEDED"
    assert calls[0][0] == "SubmitMultimodalDocParseJob"
    assert calls[0][1]["FileType"] == (6 if kind == "text" else 5)
    saved = await graph.aget_state(config)
    assert len(saved.values["ocrPageRefs"]) == len(saved.values["chunkRefs"]) == 1
    assert saved.values["pageRefs"] == []
    assert files.blobs[saved.values["textRef"]["objectKey"]] == payload
    assert (await graph.ainvoke(None, config))["result"] == output["result"]
    assert len(calls) == 2 and len(model.calls) == 1


def test_csv_cannot_enter_uploads_or_new_tasks_but_saved_references_still_validate():
    from typing import get_args
    from uuid import uuid4

    from pydantic import ValidationError

    assert "csv" not in get_args(ImportSourceType)
    reference = DocumentReference(sourceType="csv", objectKey=document_source_key("csv", "a" * 64), sha256="a" * 64,
                                  mediaType="text/csv", sizeBytes=1)
    with pytest.raises(ValidationError):
        DocumentUploadRequest.model_validate({"sourceType": "csv", "fileName": "old.csv", "sha256": "a" * 64,
                                              "sizeBytes": 1, "mediaType": "text/csv"})
    with pytest.raises(ValidationError, match="CSV document import is no longer supported"):
        DocumentTaskCreate(requestId=uuid4(), document=reference)
    assert DocumentReference.model_validate(reference.model_dump()).sourceType == "csv"


@pytest.mark.parametrize("kind", ["doc", "docx", "xlsx"])
async def test_office_original_enters_tencent_without_local_conversion(monkeypatch, kind):
    fixture = Path(__file__).parents[2] / "app/fixtures/office" / (f"中文 试卷.{kind}" if kind.startswith("doc") else f"中文 表格.{kind}")
    payload = fixture.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    reference = DocumentReference(sourceType=kind, objectKey=document_source_key(kind, digest), sha256=digest,
                                  mediaType=next(iter(DOCUMENT_MEDIA_TYPES[kind])), sizeBytes=len(payload))
    files = FakeObjectStore({reference.objectKey: payload})
    model = FakeModel(responses=[parsed("First")])
    for module in (document, execution):
        monkeypatch.setattr(module, "get_object_store", lambda: files)
    monkeypatch.setattr(document, "get_model", lambda: model)
    monkeypatch.setattr(document, "extract", AsyncMock(side_effect=AssertionError("Office must not use local format extraction")))
    calls = tencent_provider(monkeypatch, [ocr_text_page("First")])
    graph = local_graph(InMemorySaver())
    config = run_config()
    output = await graph.ainvoke({"document": reference.model_dump(mode="json")}, config)
    assert output["status"] == ("PARTIAL" if kind == "xlsx" else "SUCCEEDED")
    assert calls[0][0] == "SubmitMultimodalDocParseJob"
    import base64
    submitted = base64.b64decode(calls[0][1]["FileBase64"])
    if kind == "xlsx":
        from practiq_ai.office import prepare_workbook
        assert submitted == prepare_workbook(payload)[0] and submitted != payload
    else:
        assert submitted == payload
    assert calls[0][1]["FileType"] == (2 if kind.startswith("doc") else 4)
    if kind in {"xls", "xlsx"}:
        assert output["result"]["questions"][0]["needsReview"]
        assert any("hidden sheets" in warning for warning in output["result"]["warnings"])
    saved = await graph.aget_state(config)
    assert saved.values["normalization"] is None
    assert (await graph.ainvoke(None, config))["result"] == output["result"]
    assert len(calls) == 2 and len(model.calls) == 1


async def test_changed_tencent_text_cannot_enable_original_text_proofs(monkeypatch):
    from tests.support import setup_graph

    graph, _, files, reference, model = setup_graph(monkeypatch, [parsed("Changed")])
    calls = tencent_provider(monkeypatch, [ocr_text_page("Changed")])
    config = run_config()
    result = await graph.ainvoke({"document": reference, "deduplicateQuestions": True}, config)
    saved = (await graph.aget_state(config)).values
    assert saved["textRef"] is None and saved["chunkRefs"] == []
    assert len(saved["pageRefs"]) == 1
    assert result["result"]["questions"][0]["needsReview"]
    assert any("original-text source proofs are unavailable" in warning for warning in result["result"]["warnings"])
    assert len(calls) == 2 and len(model.calls) == 1
    assert files.blobs[reference["objectKey"]] == b"1. First\n2. Second"


@pytest.mark.parametrize("returned_count", [0, 1, 2])
async def test_native_workbook_missing_sheet_coverage_stays_partial(monkeypatch, returned_count):
    from practiq_ai.office import prepare_workbook

    payload = (Path(__file__).parents[2] / "app/fixtures/office/中文 表格.xlsx").read_bytes()
    _, names = prepare_workbook(payload)
    assert len(names) == 2
    returned = names[:returned_count]
    complete = returned_count == len(names)
    digest = hashlib.sha256(payload).hexdigest()
    reference = DocumentReference(sourceType="xlsx", objectKey=document_source_key("xlsx", digest), sha256=digest,
                                  mediaType=next(iter(DOCUMENT_MEDIA_TYPES["xlsx"])), sizeBytes=len(payload))
    files = FakeObjectStore({reference.objectKey: payload})
    for module in (document, execution):
        monkeypatch.setattr(module, "get_object_store", lambda: files)
    model = FakeModel(responses=[parsed(name) for name in returned] or [parsed("First")])
    monkeypatch.setattr(document, "get_model", lambda: model)
    calls = tencent_provider(monkeypatch, [{"table_name": name, "fields": [], "rows": []} for name in returned] or [ocr_text_page("First")])
    output = await local_graph().ainvoke({"document": reference.model_dump(mode="json")}, run_config())
    assert output["status"] == ("SUCCEEDED" if complete else "PARTIAL")
    assert len(output["result"]["questions"]) == max(1, returned_count)
    assert output["processing"]["truncated"] is not complete
    assert ("questions" in output["result"]["missingFields"]) is not complete
    assert any("coverage of every workbook sheet" in warning for warning in output["result"]["warnings"]) is not complete
    assert sum(action == "SubmitMultimodalDocParseJob" for action, _ in calls) == 1
