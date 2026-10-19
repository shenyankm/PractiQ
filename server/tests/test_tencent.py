"""Provider substitutes only: no paid Tencent calls."""

import hashlib
import json
import zipfile
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest
from langgraph.store.memory import InMemoryStore

from practiq_ai import tencent
from practiq_ai.config import load
from practiq_ai.contracts import DocumentReference
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.execution import namespace
from practiq_ai.tencent_bundle import decode_bundle
from tests.support import FakeObjectStore


def archive(entries):
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as output:
        for name, value in entries:
            output.writestr(name, value)
    return buffer.getvalue()


def ocr_page(*, figures=False):
    elements = [{"type": 2, "text_info": {"content": "1. Question?"}}]
    if figures:
        elements.append({"index": 9, "figure_info": {}, "polygon": {
            "left_top": {"x": 166, "y": 526}, "right_top": {"x": 396, "y": 526},
            "left_bottom": {"x": 166, "y": 652}, "right_bottom": {"x": 396, "y": 652},
        }})
    return {"width": 591, "height": 867, "elements": elements}


def job_runtime(monkeypatch):
    monkeypatch.setenv("AI_TENCENT_SECRET_ID", "synthetic-id")
    monkeypatch.setenv("AI_TENCENT_SECRET_KEY", "synthetic-key")
    payload = b"source"
    reference = DocumentReference(sourceType="image", mediaType="image/png", objectKey="source",
                                  sizeBytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
    files = FakeObjectStore({"source": payload})
    monkeypatch.setattr(tencent, "get_object_store", lambda: files)
    runtime = SimpleNamespace(store=InMemoryStore(), execution_info=SimpleNamespace(thread_id="t", run_id="r"))
    monkeypatch.setattr(tencent, "guard", AsyncMock())
    monkeypatch.setattr(tencent, "run_remaining", AsyncMock(return_value=60))
    return reference, files, cast(Any, runtime)


async def test_known_job_and_local_result_survive_replay(monkeypatch):
    reference, files, runtime = job_runtime(monkeypatch)
    request = AsyncMock(side_effect=[{"TaskId": "123", "RequestId": "submit"},
                                    {"Status": "Success", "ResultUrl": "https://test.cos.ap-guangzhou.myqcloud.com/result.zip",
                                     "SuccessPageNum": 1, "FailPageNum": 0, "FailedPages": []}])
    monkeypatch.setattr(tencent, "request", request)
    download = AsyncMock(return_value=b"archive")
    monkeypatch.setattr(tencent, "download_result", download)
    result = await tencent.parse_job(reference, runtime)
    assert result["taskId"] == "123"
    assert files.blobs[result["resultRef"]["objectKey"]] == b"archive"
    assert await tencent.parse_job(reference, runtime) == result
    assert request.await_count == 2 and download.await_count == 1


async def test_timeout_after_submission_never_replays_paid_request(monkeypatch):
    reference, _, runtime = job_runtime(monkeypatch)
    request = AsyncMock(side_effect=TimeoutError("simulated lost response"))
    monkeypatch.setattr(tencent, "request", request)
    with pytest.raises(TimeoutError):
        await tencent.parse_job(reference, runtime)
    with pytest.raises(DocumentProcessingError) as error:
        await tencent.parse_job(reference, runtime)
    assert error.value.code == "TENCENT_SUBMISSION_UNKNOWN"
    assert request.await_count == 1


async def test_download_retry_queries_existing_task_without_resubmitting(monkeypatch):
    reference, _, runtime = job_runtime(monkeypatch)
    await runtime.store.aput(namespace("t", "tencent_jobs"), "source",
                             {"sourceSha256": reference.sha256, "taskId": "123", "status": "Success"})
    request = AsyncMock(return_value={"Status": "Success", "ResultUrl": "result", "FailPageNum": 1,
                                     "SuccessPageNum": 1, "FailedPages": [{"PageNum": 2}]})
    monkeypatch.setattr(tencent, "request", request)
    download = AsyncMock(side_effect=[DocumentProcessingError(502, "download failed", "TENCENT_DOWNLOAD_FAILED"), b"archive"])
    monkeypatch.setattr(tencent, "download_result", download)
    with pytest.raises(DocumentProcessingError):
        await tencent.parse_job(reference, runtime)
    result = await tencent.parse_job(reference, runtime)
    assert result["FailPageNum"] == 1 and result["FailedPages"] == [{"PageNum": 2}]
    assert all(call.args[0] == "DescribeMultimodalDocParseJob" for call in request.await_args_list)


@pytest.mark.parametrize("status,code", [("Failed", "TENCENT_JOB_FAILED"), ("Unknown", "TENCENT_JOB_UNKNOWN"),
                                        ("unexpected", "TENCENT_RESULT_INVALID")])
async def test_terminal_or_unknown_provider_state_is_preserved(monkeypatch, status, code):
    reference, _, runtime = job_runtime(monkeypatch)
    monkeypatch.setattr(tencent, "request", AsyncMock(side_effect=[{"TaskId": "123"}, {"Status": status}]))
    with pytest.raises(DocumentProcessingError) as error:
        await tencent.parse_job(reference, runtime)
    assert error.value.code == code
    saved = await runtime.store.aget(namespace("t", "tencent_jobs"), "source")
    assert saved.value["taskId"] == "123"


def test_ocr_coordinates_are_normalized_from_their_own_page():
    payload = archive([("sample_ocr_page0.json", json.dumps(ocr_page(figures=True)))])
    pages = decode_bundle(payload, load(), page_count=1)
    assert pages[0]["figures"][0]["bbox"] == [166 / 591, 526 / 867, 396 / 591, 652 / 867]
    assert pages[0]["elements"][0]["text_info"]["content"] == "1. Question?"


@pytest.mark.parametrize("name,value", [("../evil", "x"), ("/absolute", "x"), ("C:\\evil", "x"),
                                       ("sample_ocr_page1.json", "{}"), ("sample_ocr_page0.json", "[]"),
                                       ("sample_ocr_page0.json", '{"width":0,"height":1,"elements":[]}')])
def test_archive_rejects_unsafe_paths_and_invalid_layouts(name, value):
    with pytest.raises(DocumentProcessingError) as error:
        decode_bundle(archive([(name, value)]), load(), page_count=1)
    assert error.value.code == "TENCENT_RESULT_INVALID"


@pytest.mark.parametrize("url", ["http://test.cos.ap-guangzhou.myqcloud.com/x", "https://127.0.0.1/x",
                                 "https://test.cos.ap-guangzhou.myqcloud.com.attacker.test/x",
                                 "https://user:pass@test.cos.ap-guangzhou.myqcloud.com/x",
                                 "https://test.cos.ap-guangzhou.myqcloud.com:444/x"])
def test_result_urls_cannot_target_arbitrary_hosts(url):
    with pytest.raises(DocumentProcessingError):
        tencent.validate_result_url(url)


async def test_http_request_signs_exact_body_and_suppresses_provider_error_text(monkeypatch):
    import httpx

    monkeypatch.setenv("AI_TENCENT_SECRET_ID", "synthetic-id")
    monkeypatch.setenv("AI_TENCENT_SECRET_KEY", "synthetic-key")
    original = httpx.AsyncClient
    captured = []

    def respond(request):
        captured.append(request)
        return httpx.Response(200, json={"Response": {"Error": {
            "Code": "AuthFailure.SignatureFailure", "Message": "must-not-expose-this-provider-text"}, "RequestId": "rejected-request"}})

    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original(transport=transport, **kwargs))
    with pytest.raises(DocumentProcessingError) as error:
        await tencent.request("DescribeMultimodalDocParseJob", {"TaskId": "123"}, load())
    assert error.value.code == "TENCENT_REQUEST_REJECTED"
    assert "must-not-expose" not in str(error.value)
    sent = captured[0]
    timestamp = int(sent.headers["X-TC-Timestamp"])
    expected = tencent.signed_headers("DescribeMultimodalDocParseJob", sent.content, load(), timestamp)
    assert sent.headers["Authorization"] == expected["Authorization"]
    assert sent.content == b'{"TaskId":"123"}'
    reference, _, runtime = job_runtime(monkeypatch)
    monkeypatch.setattr(tencent, "request", AsyncMock(side_effect=error.value))
    with pytest.raises(DocumentProcessingError):
        await tencent.parse_job(reference, runtime)
    record = await runtime.store.aget(namespace("t", "tencent_jobs"), "source")
    assert record.value["status"] == "REJECTED" and record.value["requestId"] == "rejected-request"



async def test_large_source_is_rejected_before_paid_submission(monkeypatch):
    reference, _, runtime = job_runtime(monkeypatch)
    monkeypatch.setattr(tencent, "BASE64_LIMIT", 2)
    request = AsyncMock()
    monkeypatch.setattr(tencent, "request", request)
    with pytest.raises(DocumentProcessingError) as error:
        await tencent.parse_job(reference, runtime)
    assert error.value.code == "TENCENT_SOURCE_TOO_LARGE"
    request.assert_not_awaited()
    assert not await runtime.store.asearch(namespace("t", "tencent_jobs"))


async def test_unconfigured_import_never_calls_tencent(monkeypatch):
    reference, _, runtime = job_runtime(monkeypatch)
    monkeypatch.delenv("AI_TENCENT_SECRET_KEY")
    request = AsyncMock()
    monkeypatch.setattr(tencent, "request", request)
    with pytest.raises(DocumentProcessingError) as error:
        await tencent.parse_job(reference, runtime)
    assert error.value.code == "TENCENT_NOT_CONFIGURED"
    request.assert_not_awaited()


def test_execution_signature_never_contains_tencent_secrets(monkeypatch):
    from practiq_ai.execution import signature

    monkeypatch.setenv("AI_TENCENT_SECRET_ID", "synthetic-id")
    monkeypatch.setenv("AI_TENCENT_SECRET_KEY", "synthetic-key")
    value = json.dumps(signature())
    assert "synthetic-id" not in value and "synthetic-key" not in value


async def test_real_graph_uses_ocr_evidence_and_preserves_question_contract(monkeypatch):
    from langgraph.checkpoint.memory import InMemorySaver

    from practiq_ai import execution
    from practiq_ai.contracts import document_source_key
    from practiq_ai.graphs import document
    from tests.support import FakeModel, local_graph, make_image, parsed, run_config

    monkeypatch.setenv("AI_TENCENT_SECRET_ID", "synthetic-id")
    monkeypatch.setenv("AI_TENCENT_SECRET_KEY", "synthetic-key")
    payload = make_image()
    digest = hashlib.sha256(payload).hexdigest()
    reference = DocumentReference(objectKey=document_source_key("image", digest), sha256=digest,
                                  mediaType="image/png", sizeBytes=len(payload), sourceType="image")
    files = FakeObjectStore({reference.objectKey: payload})
    for module in (document, execution, tencent):
        monkeypatch.setattr(module, "get_object_store", lambda: files)
    model = FakeModel(responses=[parsed("Question?")])
    monkeypatch.setattr(document, "get_model", lambda: model)
    request = AsyncMock(side_effect=[{"TaskId": "123"}, {"Status": "Success", "SuccessPageNum": 1, "FailPageNum": 0,
                                                        "FailedPages": [], "ResultUrl": "result"}])
    monkeypatch.setattr(tencent, "request", request)
    monkeypatch.setattr(tencent, "download_result", AsyncMock(return_value=archive([
        ("sample_ocr_page0.json", json.dumps(ocr_page())),
    ])))
    graph = local_graph(InMemorySaver())
    config = run_config()
    output = await graph.ainvoke({"document": reference.model_dump(mode="json")}, config)
    assert output["status"] == "SUCCEEDED"
    assert output["result"]["questions"][0]["stem"] == "Question?"
    assert output["processing"]["questionSources"][0]["stage"] == "vision_parse"
    assert "Tencent OCR" in model.calls[0][1].text
    assert "image_url" not in json.dumps([message.content for message in model.calls[0]])
    saved = await graph.aget_state(config)
    assert len(saved.values["ocrPageRefs"]) == len(saved.values["pageRefs"]) == 1
    assert (await graph.ainvoke(None, config))["result"] == output["result"]
    assert request.await_count == 2


def test_figure_associations_cannot_invent_bounds_or_drop_source_figures():
    from pydantic import ValidationError

    from practiq_ai.graphs import document

    token = document.OCR_FIGURES.set([{"elementIndex": 9, "bbox": [0.1, 0.2, 0.3, 0.4]}])
    try:
        association = {"elementIndex": 9, "description": "Source figure", "questionIndexes": []}
        result = document.OcrPageParseResult.model_validate({"questions": [], "groups": [], "figures": [association]})
        assert result.page_result().figures[0].bbox == [0.1, 0.2, 0.3, 0.4]
        for figures in ([], [association, association], [{**association, "elementIndex": 10}],
                        [{**association, "bbox": [0, 0, 1, 1]}]):
            with pytest.raises(ValidationError):
                document.OcrPageParseResult.model_validate({"questions": [], "groups": [], "figures": figures})
    finally:
        document.OCR_FIGURES.reset(token)


@pytest.mark.parametrize("all_failed", [False, True])
async def test_failed_ocr_page_requires_explicit_partial_acceptance(monkeypatch, all_failed):
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.types import Command

    from practiq_ai import execution
    from practiq_ai.contracts import document_source_key
    from practiq_ai.graphs import document
    from tests.support import FakeModel, local_graph, make_blank_pdf, parsed, run_config

    monkeypatch.setenv("AI_TENCENT_SECRET_ID", "synthetic-id")
    monkeypatch.setenv("AI_TENCENT_SECRET_KEY", "synthetic-key")
    payload = make_blank_pdf(2)
    digest = hashlib.sha256(payload).hexdigest()
    reference = DocumentReference(objectKey=document_source_key("pdf", digest), sha256=digest,
                                  mediaType="application/pdf", sizeBytes=len(payload), sourceType="pdf")
    files = FakeObjectStore({reference.objectKey: payload})
    for module in (document, execution, tencent):
        monkeypatch.setattr(module, "get_object_store", lambda: files)
    model = FakeModel(responses=[] if all_failed else [parsed("Question?")])
    monkeypatch.setattr(document, "get_model", lambda: model)
    request = AsyncMock(side_effect=[{"TaskId": "123"}, {"Status": "Success", "SuccessPageNum": 0 if all_failed else 1, "FailPageNum": 2 if all_failed else 1,
                                                        "FailedPages": [{"PageNum": 2}], "ResultUrl": "result"}])
    monkeypatch.setattr(tencent, "request", request)
    monkeypatch.setattr(tencent, "download_result", AsyncMock(return_value=archive([] if all_failed else [
        ("sample_ocr_page0.json", json.dumps(ocr_page())),
    ])))
    graph = local_graph(InMemorySaver())
    config = run_config()
    waiting = await graph.ainvoke({"document": reference.model_dump(mode="json"), "failurePolicy": "review"}, config)
    interruption = waiting["__interrupt__"][0].value
    assert interruption["kind"] == "review" and interruption["canAccept"]
    assert interruption["failures"][0]["code"] == "TENCENT_PAGE_FAILED"
    assert not interruption["failures"][0]["retryable"]
    result = await graph.ainvoke(Command(resume={"action": "accept_partial"}), config)
    assert result["status"] == "PARTIAL" and result["processing"]["quality"]["reviewRequired"]
    assert [q["stem"] for q in result["result"]["questions"]] == ([] if all_failed else ["Question?"])
    assert any(item["page"] == 1 and item["sourceRef"] for item in result["result"]["visualElements"])
    assert request.await_count == 2 and len(model.calls) == (0 if all_failed else 1)


@pytest.mark.parametrize("text", ["First\n\nSecond\n", "题目：2+2？\n\n答案：4\n"])
def test_markdown_result_preserves_all_source_bytes_as_inert_evidence(text):
    payload = archive([("sample_md_full.md", text)])
    pages = decode_bundle(payload, load(), page_count=1, result_type=2)
    assert len(pages) == 1 and pages[0]["figures"] == []
    assert pages[0]["elements"][0]["text_info"]["content"] == text


@pytest.mark.parametrize("entries", [
    [("../escape_md_full.md", "text")],
    [("a_md_full.md", "first"), ("b_md_full.md", "second")],
    [("a_md_full.md", b"bad\xff")], [("a_md_full.md", "  ")],
    [("unrelated.md", "text")],
])
def test_markdown_result_rejects_unsafe_ambiguous_or_invalid_output(entries):
    with pytest.raises(DocumentProcessingError) as error:
        decode_bundle(archive(entries), load(), page_count=1, result_type=2)
    assert error.value.code == "TENCENT_RESULT_INVALID"


def test_markdown_evidence_obeys_shared_character_limit():
    from dataclasses import replace
    with pytest.raises(DocumentProcessingError):
        decode_bundle(archive([("a_md_full.md", "12345")]), replace(load(), max_total_input_chars=4), page_count=1, result_type=2)
    assert decode_bundle(archive([]), load(), page_count=1, result_type=2, allow_empty=True) == []


def test_explicitly_failed_markdown_job_can_retain_empty_evidence_for_review():
    assert decode_bundle(archive([('sample_md_full.md', '')]), load(), page_count=1, result_type=2, allow_empty=True) == []


def test_native_excel_table_preserves_cells_and_merged_layout():
    fixtures = Path(__file__).parent / "fixtures"
    table = json.loads((fixtures / "tencent-xlsx.json").read_text())
    xml = (fixtures / "tencent-xlsx.xml").read_bytes()
    payload = archive([("sample_ocr_page0.json", json.dumps(table)), ("sample_xml_full.xml", xml)])
    page = decode_bundle(payload, load(), page_count=1)[0]
    assert page["format"] == "table" and page["figures"] == []
    evidence = page["elements"][0]
    assert evidence["table_info"] == table
    assert 'colspan="3"' in evidence["layout_xml"]
    assert "OUTSIDE_PRINT_AREA" in evidence["layout_xml"]
    assert evidence["table_info"]["rows"][2]["cells"][0] == {"row_idx": 2}
    settings = load()
    from dataclasses import replace
    with pytest.raises(DocumentProcessingError):
        decode_bundle(payload, replace(settings, max_total_input_chars=1), page_count=1)


@pytest.mark.parametrize("change", [{"fields": "bad"}, {"rows": [{}]}, {"rows": [{"cells": [None]}]}])
def test_native_excel_table_rejects_invalid_collections(change):
    table = {"table_name": "Synthetic", "fields": [], "rows": [], **change}
    with pytest.raises(DocumentProcessingError):
        decode_bundle(archive([("sample_ocr_page0.json", json.dumps(table))]), load(), page_count=1)
