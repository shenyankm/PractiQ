"""Provider substitutes only: no paid Tencent calls."""

import base64
import hashlib
import json
import lzma
import struct
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
from practiq_ai.contracts import DocumentReference, document_source_key
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.execution import namespace
from practiq_ai.tencent_bundle import decode_bundle, read_bundle_image
from tests.support import FakeObjectStore, make_image


def archive(entries, *, compression=zipfile.ZIP_STORED):
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", compression) as output:
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


@pytest.mark.parametrize('damage', ['zip', 'json', 'xml', 'image_crc'])
async def test_invalid_download_resumes_known_job_and_retains_failed_evidence(monkeypatch, damage):
    from practiq_ai.extractors import ExtractedDocument
    from practiq_ai.graphs import document

    reference, files, runtime = job_runtime(monkeypatch)
    reference = reference.model_copy(update={'objectKey': document_source_key('image', reference.sha256)})
    files.blobs[reference.objectKey] = files.blobs.pop('source')
    valid = archive([('sample_ocr_page0.json', json.dumps(ocr_page()))])
    invalid = b'incomplete ZIP'
    if damage == 'json':
        invalid = archive([('sample_ocr_page0.json', '{')])
    elif damage == 'xml':
        invalid = archive([('sample_xml_full.xml', '<root>'),
                           ('sample_ocr_page0.json', json.dumps(ocr_page()))])
    elif damage == 'image_crc':
        image = make_image()
        invalid = archive([('sample_xml_full.xml', '<root><image id="p-9" page-numbers="0" src="figure.png"/></root>'),
                           ('sample_ocr_page0.json', json.dumps(ocr_page(figures=True))), ('figure.png', image)])
        offset = invalid.index(image)
        invalid = invalid[:offset] + bytes([invalid[offset] ^ 1]) + invalid[offset + 1:]
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: object())
    monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(text='', page_images=[make_image()])))
    success = {'Status': 'Success', 'ResultUrl': 'result', 'SuccessPageNum': 1, 'FailPageNum': 0}
    request = AsyncMock(side_effect=[{'TaskId': '123', 'RequestId': 'original-submission'}, success, success])
    download = AsyncMock(side_effect=[invalid, valid])
    monkeypatch.setattr(tencent, 'request', request)
    monkeypatch.setattr(tencent, 'download_result', download)
    state = cast(Any, {'document': reference.model_dump()})

    with pytest.raises(DocumentProcessingError) as error:
        await document._prepare(state, runtime)
    assert error.value.code == 'TENCENT_RESULT_INVALID'
    failed = (await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source-0-0')).value
    invalid_ref = failed['resultRef']
    assert not failed['resultValidated'] and failed['resultValidationError'] == error.value.code
    assert files.blobs[invalid_ref['objectKey']] == invalid
    assert request.await_count == 2 and download.await_count == 1

    assert (await document._prepare(state, runtime))['ocrPageRefs']
    recovered = (await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source-0-0')).value
    assert recovered['resultValidated'] and 'resultValidationError' not in recovered
    assert invalid_ref in recovered['invalidResultRefs']
    assert files.blobs[invalid_ref['objectKey']] == invalid
    assert files.blobs[recovered['resultRef']['objectKey']] == valid
    assert recovered['taskId'] == '123' and recovered['requestId'] == 'original-submission'
    assert [call.args[0] for call in request.await_args_list] == [
        'SubmitMultimodalDocParseJob', 'DescribeMultimodalDocParseJob', 'DescribeMultimodalDocParseJob']
    assert download.await_count == 2
    await document._prepare(state, runtime)
    assert request.await_count == 3 and download.await_count == 2


@pytest.mark.parametrize('invalid', [False, True])
async def test_legacy_result_is_validated_before_reuse_or_known_job_download(monkeypatch, invalid):
    reference, files, runtime = job_runtime(monkeypatch)
    valid = archive([('sample_ocr_page0.json', json.dumps(ocr_page()))])
    payload = archive([('sample_ocr_page0.json', '{')]) if invalid else valid
    result_ref = await files.put_artifact(payload, source_sha256=reference.sha256, kind='tencent-result', index=0,
                                          media_type='application/octet-stream')
    await runtime.store.aput(namespace('t', 'tencent_jobs'), 'source', {
        'sourceSha256': reference.sha256, 'taskId': 'legacy-job', 'status': 'Success', 'resultRef': result_ref.model_dump()})
    request = AsyncMock(return_value={'Status': 'Success', 'ResultUrl': 'result', 'SuccessPageNum': 1, 'FailPageNum': 0})
    download = AsyncMock(return_value=valid)
    monkeypatch.setattr(tencent, 'request', request)
    monkeypatch.setattr(tencent, 'download_result', download)
    result = await tencent.parse_job(reference, runtime)
    assert result['resultValidated'] is False
    if invalid:
        with pytest.raises(DocumentProcessingError):
            async with tencent.validate_result(result, runtime, key='source'):
                decode_bundle(payload, load(), page_count=1)
        request.assert_not_awaited()
        result = await tencent.parse_job(reference, runtime)
        assert request.await_args is not None
        assert request.await_args.args[0] == 'DescribeMultimodalDocParseJob'
        assert download.await_count == 1
    async with tencent.validate_result(result, runtime, key='source'):
        decode_bundle(files.blobs[result['resultRef']['objectKey']], load(), page_count=1)
    assert (await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source')).value['resultValidated']
    assert await tencent.parse_job(reference, runtime) == result
    assert download.await_count == int(invalid)


async def test_split_resume_downloads_only_the_invalid_result(monkeypatch):
    from practiq_ai.graphs import document

    reference, files, runtime = job_runtime(monkeypatch)
    payload = b'aaa\nbbb\n'
    digest = hashlib.sha256(payload).hexdigest()
    reference = reference.model_copy(update={'sourceType': 'text', 'mediaType': 'text/plain', 'sizeBytes': len(payload),
                                             'sha256': digest, 'objectKey': document_source_key('text', digest)})
    files.blobs[reference.objectKey] = payload
    monkeypatch.setenv('AI_TENCENT_INPUT_MAX_BYTES', '4')
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: object())
    submitted = []
    queried = []
    downloaded = []

    async def request(action, data, _config):
        if action == 'SubmitMultimodalDocParseJob':
            task_id = 'job-0' if base64.b64decode(data['FileBase64']) == b'aaa\n' else 'job-1'
            submitted.append(task_id)
            return {'TaskId': task_id}
        queried.append(data['TaskId'])
        return {'Status': 'Success', 'ResultUrl': data['TaskId'], 'SuccessPageNum': 1, 'FailPageNum': 0}

    async def download(task_id):
        downloaded.append(task_id)
        if task_id == 'job-1' and downloaded.count(task_id) == 1:
            return b'broken second result'
        return archive([('sample_md_full.md', 'aaa\n' if task_id == 'job-0' else 'bbb\n')])

    monkeypatch.setattr(tencent, 'request', request)
    monkeypatch.setattr(tencent, 'download_result', download)
    state = cast(Any, {'document': reference.model_dump()})
    with pytest.raises(DocumentProcessingError) as error:
        await document._prepare(state, runtime)
    assert error.value.code == 'TENCENT_RESULT_INVALID'
    first = (await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source-0-0')).value
    second = (await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source-0-1')).value
    assert first['resultValidated'] and not second['resultValidated']
    assert (await document._prepare(state, runtime))['textRef']
    assert sorted(submitted) == ['job-0', 'job-1']
    assert queried.count('job-0') == downloaded.count('job-0') == 1
    assert queried.count('job-1') == downloaded.count('job-1') == 2


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


@pytest.mark.parametrize('error_type', [tencent.TransientReadError, DocumentProcessingError])
async def test_unavailable_submit_is_unknown_on_first_failure(monkeypatch, error_type):
    reference, _, runtime = job_runtime(monkeypatch)
    request = AsyncMock(side_effect=error_type(502, 'unavailable', 'TENCENT_API_UNAVAILABLE'))
    monkeypatch.setattr(tencent, 'request', request)
    for _ in range(2):
        with pytest.raises(DocumentProcessingError) as error:
            await tencent.parse_job(reference, runtime)
        assert error.value.code == 'TENCENT_SUBMISSION_UNKNOWN'
    record = await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source')
    assert record.value['status'] == 'SUBMITTING' and not record.value.get('taskId')
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


@pytest.mark.parametrize("compression", [zipfile.ZIP_BZIP2, zipfile.ZIP_ZSTANDARD, zipfile.ZIP_LZMA], ids=["bzip2", "zstd", "lzma"])
def test_decode_bundle_translates_corrupt_compressed_member_errors(compression):
    # Exceed LZMA's properties length inferred from the XML prefix (28,024 bytes).
    entries = [("sample_xml_full.xml", '<?xml version="1.0"?><document>' + " " * 32768 + '</document>'),
               ("sample_ocr_page0.json", json.dumps(ocr_page()))]
    payload = archive(entries, compression=compression)
    assert len(decode_bundle(payload, load(), page_count=1)) == 1
    corrupt = bytearray(archive(entries))
    # Only the first member's declared codec changes, not its stored bytes.
    struct.pack_into("<H", corrupt, 8, compression)
    struct.pack_into("<H", corrupt, corrupt.index(b"PK\x01\x02") + 10, compression)
    with pytest.raises(DocumentProcessingError) as error:
        decode_bundle(bytes(corrupt), load(), page_count=1)
    assert error.value.status_code == 502 and error.value.code == "TENCENT_RESULT_INVALID"
    if compression == zipfile.ZIP_LZMA:
        assert isinstance(error.value.__cause__, lzma.LZMAError)


@pytest.mark.parametrize("compression", [zipfile.ZIP_BZIP2, zipfile.ZIP_ZSTANDARD, zipfile.ZIP_LZMA], ids=["bzip2", "zstd", "lzma"])
def test_subimage_read_translates_corrupt_compressed_member_errors(compression):
    # Valid PNG with trailing padding lets the malformed stream reach LZMA decoding.
    image = make_image() + b"\x00" * 32768
    entries = [("image.png", image)]
    with zipfile.ZipFile(BytesIO(archive(entries, compression=compression))) as bundle:
        assert read_bundle_image(bundle, "image.png", load()) == (image, "image/png")
    corrupt = bytearray(archive(entries))
    struct.pack_into("<H", corrupt, 8, compression)
    struct.pack_into("<H", corrupt, corrupt.index(b"PK\x01\x02") + 10, compression)
    with zipfile.ZipFile(BytesIO(corrupt)) as bundle, pytest.raises(DocumentProcessingError) as error:
        read_bundle_image(bundle, "image.png", load())
    assert error.value.status_code == 502 and error.value.code == "TENCENT_RESULT_INVALID"
    if compression == zipfile.ZIP_LZMA:
        assert isinstance(error.value.__cause__, lzma.LZMAError)


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


@pytest.mark.parametrize("with_xml", [False, True])
def test_native_table_layouts_index_captions_once_without_resolving_ambiguity(monkeypatch, with_xml):
    from xml.etree import ElementTree

    captions = []

    class CountedElement(ElementTree.Element):
        def find(self, path, namespaces=None):
            if self.tag == "table" and path == "caption":
                captions.append(self)
            return super().find(path, namespaces)

    parse = ElementTree.fromstring
    monkeypatch.setattr(ElementTree, "fromstring", lambda text: parse(
        text, parser=ElementTree.XMLParser(target=ElementTree.TreeBuilder(element_factory=CountedElement))))
    xml = ("<root><table><caption> A <b>&amp;</b> B </caption><tr><td>unique</td></tr></table>"
           "<table><caption>duplicate</caption></table><table><caption> duplicate </caption></table>"
           "<table/><table><caption> </caption></table>"
           "<table><caption>first</caption><caption>second</caption></table></root>")
    names = [" A & B\n", "duplicate", "missing", "", "first", "second", None, 1]
    entries = [(f"sample_ocr_page{index}.json", json.dumps({
        "table_name": "fallback", "caption": name, "fields": [], "rows": []})) for index, name in enumerate(names)]
    if with_xml:
        entries.append(("sample_xml_full.xml", xml))
    pages = decode_bundle(archive(entries), load(), page_count=len(names))
    layouts = [page["elements"][0].get("layout_xml") for page in pages]
    assert [layout is not None for layout in layouts] == ([True, False, False, True, True, False, False, False] if with_xml else [False] * len(names))
    if with_xml:
        assert "<td>unique</td>" in layouts[0]
        assert len(captions) == 6
    else:
        assert captions == []


@pytest.mark.parametrize("change", [{"fields": "bad"}, {"rows": [{}]}, {"rows": [{"cells": [None]}]}])
def test_native_excel_table_rejects_invalid_collections(change):
    table = {"table_name": "Synthetic", "fields": [], "rows": [], **change}
    with pytest.raises(DocumentProcessingError):
        decode_bundle(archive([("sample_ocr_page0.json", json.dumps(table))]), load(), page_count=1)


@pytest.mark.parametrize('kind', ['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'])
async def test_direct_office_submission_caps_paid_pages(monkeypatch, kind):
    reference, _, runtime = job_runtime(monkeypatch)
    monkeypatch.setenv('AI_MAX_DOCUMENT_PAGES', '2')
    request = AsyncMock(side_effect=[{'TaskId':'123'}, {'Status':'Success','ResultUrl':'result','SuccessPageNum':2}])
    monkeypatch.setattr(tencent, 'request', request)
    monkeypatch.setattr(tencent, 'download_result', AsyncMock(return_value=b'archive'))
    await tencent.parse_job(reference, runtime, source_type=kind)
    assert request.await_args_list[0].args[1]['FileEndPageNumber'] == 2


async def test_failed_job_retains_only_safe_diagnostics_and_phase_metrics(monkeypatch):
    from practiq_ai import telemetry

    reference, _, runtime = job_runtime(monkeypatch)
    monkeypatch.setattr(tencent, 'request', AsyncMock(side_effect=[{'TaskId': '123', 'RequestId': 'submit'},
        {'Status': 'Failed', 'RequestId': 'query-456', 'ErrorCode': 'UnsupportedFile', 'ErrorMessage': 'private-document'}]))
    before = telemetry.duration.labels('tencent_query', 'success')._sum.get()
    with pytest.raises(DocumentProcessingError, match='Failed'):
        await tencent.parse_job(reference, runtime)
    saved = (await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source')).value
    assert saved['queryRequestId'] == 'query-456' and saved['errorCode'] == 'UnsupportedFile'
    assert saved['statusUpdatedAt'] >= saved['submittedAt']
    assert 'private-document' not in json.dumps(saved)
    assert telemetry.duration.labels('tencent_query', 'success')._sum.get() > before


@pytest.mark.parametrize('phase', ['query', 'download'])
async def test_transient_known_reads_retry_with_same_job_and_bounded_backoff(monkeypatch, phase):
    reference, _, runtime = job_runtime(monkeypatch)
    transient = tencent.TransientReadError(502, 'temporary', 'TENCENT_API_UNAVAILABLE')
    success = {'Status': 'Success', 'ResultUrl': 'unused'}
    request = AsyncMock(side_effect=[{'TaskId': '123'}, *([transient, transient] if phase == 'query' else []), success])
    download = AsyncMock(side_effect=[*([transient, transient] if phase == 'download' else []), b'archive'])
    monkeypatch.setattr(tencent.random, 'uniform', lambda *_: 0.8)
    sleep = AsyncMock()
    monkeypatch.setattr(tencent, 'request', request)
    monkeypatch.setattr(tencent, 'download_result', download)
    monkeypatch.setattr(tencent.asyncio, 'sleep', sleep)
    assert (await tencent.parse_job(reference, runtime))['resultRef']
    assert [call.args[0] for call in request.await_args_list].count('SubmitMultimodalDocParseJob') == 1
    assert all(call.args[1] == {'TaskId': '123'} for call in request.await_args_list[1:])
    assert sum(call.args[0] for call in sleep.await_args_list) == pytest.approx(2.4)
    assert all(0 < call.args[0] <= 1 for call in sleep.await_args_list)


async def test_retry_exhaustion_does_not_resubmit_and_unknown_submit_is_not_retried(monkeypatch):
    reference, _, runtime = job_runtime(monkeypatch)
    transient = tencent.TransientReadError(502, 'temporary', 'TENCENT_API_UNAVAILABLE')
    request = AsyncMock(side_effect=[{'TaskId': '123'}, transient, transient, transient])
    monkeypatch.setattr(tencent, 'request', request)
    monkeypatch.setattr(tencent.asyncio, 'sleep', AsyncMock())
    with pytest.raises(tencent.TransientReadError):
        await tencent.parse_job(reference, runtime)
    assert request.await_count == 4
    reference, _, runtime = job_runtime(monkeypatch)
    request.reset_mock(side_effect=True)
    request.side_effect = transient
    with pytest.raises(DocumentProcessingError) as error:
        await tencent.parse_job(reference, runtime)
    assert error.value.code == 'TENCENT_SUBMISSION_UNKNOWN'
    with pytest.raises(DocumentProcessingError, match='unknown outcome'):
        await tencent.parse_job(reference, runtime)
    assert request.await_count == 1


@pytest.mark.parametrize('code,retries', [('AuthFailure.SignatureFailure', 0), ('RequestLimitExceeded', 2)])
async def test_query_rejections_preserve_diagnostics_and_only_throttling_is_retried(monkeypatch, code, retries):
    reference, _, runtime = job_runtime(monkeypatch)
    request = AsyncMock(side_effect=[{'TaskId': '123'}, *[tencent.RequestRejected(code, 'query') for _ in range(retries + 1)]])
    monkeypatch.setattr(tencent, 'request', request)
    sleep = AsyncMock()
    monkeypatch.setattr(tencent.asyncio, 'sleep', sleep)
    with pytest.raises(DocumentProcessingError) as error:
        await tencent.parse_job(reference, runtime)
    assert error.value.code == 'TENCENT_QUERY_REJECTED'
    assert request.await_count == retries + 2
    assert bool(sleep.await_count) == bool(retries)
    assert all(0 < call.args[0] <= 1 for call in sleep.await_args_list)
    saved = (await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source')).value
    assert saved['queryRequestId'] == 'query' and saved['errorCode'] == code


async def test_retry_checks_deadline_and_control_before_next_attempt(monkeypatch):
    reference, _, runtime = job_runtime(monkeypatch)
    monkeypatch.setattr(tencent, 'request', AsyncMock(side_effect=[{'TaskId': '123'},
        tencent.TransientReadError(502, 'temporary', 'TENCENT_API_UNAVAILABLE')]))
    monkeypatch.setattr(tencent, 'run_remaining', AsyncMock(return_value=0.25))
    sleep = AsyncMock()
    monkeypatch.setattr(tencent.asyncio, 'sleep', sleep)
    with pytest.raises(tencent.TransientReadError):
        await tencent.parse_job(reference, runtime)
    sleep.assert_not_awaited()


@pytest.mark.parametrize('value', ['private?signature=secret', '<html>', 'x' * 129, 123])
async def test_unsafe_provider_diagnostics_are_not_persisted(monkeypatch, value):
    reference, _, runtime = job_runtime(monkeypatch)
    monkeypatch.setattr(tencent, 'request', AsyncMock(side_effect=[{'TaskId': '123', 'RequestId': value},
        {'Status': 'Failed', 'RequestId': value, 'ErrorCode': value}]))
    with pytest.raises(DocumentProcessingError):
        await tencent.parse_job(reference, runtime)
    saved = (await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source')).value
    assert saved.get('requestId') is None and saved.get('queryRequestId') is None and saved.get('errorCode') is None


@pytest.mark.parametrize('operation', ['query', 'download'])
@pytest.mark.parametrize('status,retryable', [(401, False), (404, False), (429, True), (503, True)])
async def test_http_status_classification_does_not_retry_permanent_failures(monkeypatch, operation, status, retryable):
    import httpx

    job_runtime(monkeypatch)
    original = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(status))
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(transport=transport, **kwargs))
    with pytest.raises(DocumentProcessingError) as error:
        if operation == 'query':
            await tencent.request('DescribeMultimodalDocParseJob', {'TaskId': '123'}, load())
        else:
            await tencent.download_result('https://test.cos.ap-guangzhou.myqcloud.com/result?signature=private')
    assert isinstance(error.value, tencent.TransientReadError) == retryable
    assert 'private' not in str(error.value)


async def test_query_retry_obeys_pause_before_replaying_known_read(monkeypatch):
    reference, _, runtime = job_runtime(monkeypatch)
    request = AsyncMock(side_effect=[{'TaskId': '123'}, tencent.TransientReadError(502, 'temporary', 'TENCENT_API_UNAVAILABLE')])
    monkeypatch.setattr(tencent, 'request', request)
    sleep = AsyncMock()
    monkeypatch.setattr(tencent.asyncio, 'sleep', sleep)
    guard = AsyncMock(side_effect=[None, None, None, DocumentProcessingError(409, 'pause', 'TASK_PAUSED')])
    monkeypatch.setattr(tencent, 'guard', guard)
    with pytest.raises(DocumentProcessingError) as error:
        await tencent.parse_job(reference, runtime)
    assert error.value.code == 'TASK_PAUSED' and request.await_count == 2 and sleep.await_count == 1


async def test_rejected_query_diagnostics_survive_pause_during_retry_backoff(monkeypatch):
    from langgraph.errors import GraphInterrupt

    reference, _, runtime = job_runtime(monkeypatch)
    monkeypatch.setattr(tencent, 'request', AsyncMock(side_effect=[{'TaskId': '123'},
        tencent.RequestRejected('RequestLimitExceeded', 'latest-query')]))
    monkeypatch.setattr(tencent, 'guard', AsyncMock(side_effect=[None, None, None, GraphInterrupt()]))
    monkeypatch.setattr(tencent.asyncio, 'sleep', AsyncMock())
    with pytest.raises(GraphInterrupt):
        await tencent.parse_job(reference, runtime)
    saved = (await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source')).value
    assert saved['queryRequestId'] == 'latest-query' and saved['errorCode'] == 'RequestLimitExceeded'


async def test_tencent_workflows_share_five_slots_and_cancelled_waiter_has_no_submit_intent(monkeypatch):
    import asyncio

    reference, _, runtime = job_runtime(monkeypatch)
    pending = [SimpleNamespace(store=runtime.store, execution_info=SimpleNamespace(thread_id=f't-{i}', run_id=f'r-{i}'))
               for i in range(8)]
    release = asyncio.Event()
    full = asyncio.Event()
    active = peak = submits = 0

    async def send(action, _data, _config):
        nonlocal active, peak, submits
        active += 1
        peak = max(active, peak)
        try:
            if action == 'SubmitMultimodalDocParseJob':
                submits += 1
                if submits == 5:
                    full.set()
                await release.wait()
                return {'TaskId': 'known'}
            return {'Status': 'Success', 'ResultUrl': 'unused'}
        finally:
            active -= 1

    monkeypatch.setattr(tencent, 'request', send)
    monkeypatch.setattr(tencent, 'download_result', AsyncMock(return_value=b'archive'))
    jobs = [asyncio.create_task(tencent.parse_job(reference, cast(Any, item))) for item in pending]
    try:
        await asyncio.wait_for(full.wait(), 2)
        # Let the other coroutines reach admission while the first five are blocked.
        for _ in range(5):
            await asyncio.sleep(0)
        assert submits == peak == 5
        assert await runtime.store.aget(namespace('t-7', 'tencent_jobs'), 'source') is None
        jobs[-1].cancel()
        with pytest.raises(asyncio.CancelledError):
            await jobs[-1]
        assert await runtime.store.aget(namespace('t-7', 'tencent_jobs'), 'source') is None
    finally:
        release.set()
        results = await asyncio.gather(*jobs, return_exceptions=True)
    assert all(isinstance(result, dict) and result.get('resultRef') for result in results[:-1])
    assert submits == 7 and peak == 5


async def test_tencent_admission_wait_is_bounded_by_the_saved_deadline(monkeypatch):
    import asyncio

    reference, _, runtime = job_runtime(monkeypatch)
    hold = asyncio.Event()
    entered = asyncio.Event()
    count = 0

    async def send(*_args):
        nonlocal count
        count += 1
        if count == 5:
            entered.set()
        await hold.wait()

    monkeypatch.setattr(tencent, 'request', send)
    jobs = [asyncio.create_task(tencent.parse_job(reference, cast(Any, SimpleNamespace(
        store=runtime.store, execution_info=SimpleNamespace(thread_id=f'held-{i}', run_id=f'r-{i}'))))) for i in range(5)]
    try:
        await asyncio.wait_for(entered.wait(), 2)
        monkeypatch.setattr(tencent, 'run_remaining', AsyncMock(return_value=0.01))
        async def wait_for_admission():
            try:
                await tencent.parse_job(reference, runtime)
            except TimeoutError:
                return 'deadline'
            return 'unexpected result'

        assert await asyncio.wait_for(wait_for_admission(), 0.5) == 'deadline'
        assert count == 5
        assert await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source') is None
    finally:
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)


async def test_pause_is_observed_while_waiting_for_tencent_admission(monkeypatch):
    import asyncio

    from langgraph.errors import GraphInterrupt

    reference, _, runtime = job_runtime(monkeypatch)
    full = asyncio.Event()
    hold = asyncio.Event()
    count = 0

    async def send(*_args):
        nonlocal count
        count += 1
        if count == 5:
            full.set()
        await hold.wait()

    async def guard(item):
        if item.execution_info.thread_id == 't':
            raise GraphInterrupt()

    monkeypatch.setattr(tencent, 'request', send)
    monkeypatch.setattr(tencent, 'guard', guard)
    jobs = [asyncio.create_task(tencent.parse_job(reference, cast(Any, SimpleNamespace(
        store=runtime.store, execution_info=SimpleNamespace(thread_id=f'busy-{i}', run_id=f'r-{i}'))))) for i in range(5)]
    try:
        await asyncio.wait_for(full.wait(), 2)
        with pytest.raises(GraphInterrupt):
            await asyncio.wait_for(tencent.parse_job(reference, runtime), 2)
        assert count == 5
        assert await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source') is None
    finally:
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
