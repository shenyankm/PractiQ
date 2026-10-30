"""Deterministic document work counts, paid-work ordering and buffer lifetimes."""

import asyncio
import base64
import hashlib
import json
import random
import weakref
from io import BytesIO
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, Mock

import pytest
from langgraph.store.memory import InMemoryStore
from PIL import Image

from practiq_ai import tencent
from practiq_ai.contracts import ArtifactReference, document_source_key
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.execution import namespace
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document, vision
from practiq_ai.import_control import ImportControl
from tests.support import make_image, ocr_text_page, parsed, source, tencent_provider


def prepare(monkeypatch, text="aaa\nbbb\nccc\nddd\n", concurrency=2):
    files, reference = source(text)
    monkeypatch.setattr(document, "get_object_store", lambda: files)
    monkeypatch.setattr(document, "get_model", lambda: object())
    monkeypatch.setattr(tencent, "guard", AsyncMock())
    monkeypatch.setattr(tencent, "run_remaining", AsyncMock(return_value=60))
    control = ImportControl()
    control.snapshot.settings.tencentConcurrency = concurrency
    runtime = cast(Any, SimpleNamespace(store=InMemoryStore(), context={"importControl": control},
                                       execution_info=SimpleNamespace(thread_id="performance", run_id="run")))
    return files, reference, runtime, control


@pytest.mark.parametrize("outcome", ["empty", "idless", "primary", "enriched", "too_large"])
async def test_vision_reads_only_usable_context_and_projects_each_response_once(monkeypatch, outcome):
    files, reference, runtime, _ = prepare(monkeypatch)
    refs = []
    for index in range(4):
        ref = await files.put_artifact(json.dumps({"page": index, "elements": [], "figures": []}).encode(),
                                       source_sha256=reference["sha256"], kind="ocr-page", index=index,
                                       media_type="application/json")
        refs.append(ref.model_dump())
    reply = parsed("Printed question") if outcome != "empty" else {"questions": [], "groups": []}
    if outcome not in {"empty", "idless"}:
        reply["questions"][0]["id"] = "page:1:1"
    original = json.dumps(reply)
    calls = []

    async def call(_model, messages, schema, _kind, *, runtime):
        calls.append(messages)
        if len(calls) == 2 and outcome == "too_large":
            return None, [], "MODEL_INPUT_TOO_LARGE"
        return schema.model_validate(reply), [], None

    projection = Mock(wraps=document.OcrPageParseResult.page_result)
    monkeypatch.setattr(document.OcrPageParseResult, "page_result", lambda self: projection(self))
    monkeypatch.setattr(document, "structured_call", call)
    reads = AsyncMock(wraps=files.get_verified)
    monkeypatch.setattr(files, "get_verified", reads)
    state = {"artifact": refs[0], "ocrArtifact": refs[0], "index": 0,
             "neighbors": [] if outcome == "primary" else [{"index": i, "ocrArtifact": ref} for i, ref in enumerate(refs)]}
    result = await document._vision(cast(Any, state), runtime)
    context_used = outcome in {"enriched", "too_large"}
    assert reads.await_count == (4 if context_used else 1)
    assert len(calls) == (2 if context_used else 1)
    assert projection.call_count == (2 if outcome == "enriched" else 1)
    assert not result["failures"]
    unit = result["visionResults"][0]
    assert len(unit["parsed"]["questions"]) == (0 if outcome == "empty" else 1)
    if outcome == "too_large":
        assert unit["contextSkipped"] and unit["parsed"]["questions"][0]["needsReview"]
    assert json.dumps(reply) == original


@pytest.mark.parametrize("existing", [[], [0, 2], [0, 1, 2]])
async def test_vision_crops_only_missing_subimages_in_exact_figure_order(monkeypatch, existing):
    files, reference, runtime, _ = prepare(monkeypatch)
    page = await files.put_artifact(make_image(), source_sha256=reference["sha256"], kind="page", index=0, media_type="image/png")
    figures = [{"elementIndex": index, "bbox": [position / 10, 0, .8, .8], "kind": "image"}
               for position, index in enumerate([8, 2, 19])]
    for position in existing:
        ref = await files.put_artifact(f"subimage-{position}".encode(), source_sha256=reference["sha256"],
                                       kind="ocr-figure", index=position, media_type="image/png")
        figures[position]["imageRef"] = ref.model_dump()
    primary = {"page": 0, "elements": [], "figures": figures}
    ocr = await files.put_artifact(json.dumps(primary).encode(), source_sha256=reference["sha256"], kind="ocr-page", index=0, media_type="application/json")
    missing = [position for position in range(3) if position not in existing]
    generated = [f"crop-{position}".encode() for position in missing]
    crop = Mock(return_value=generated)
    monkeypatch.setattr(vision, "crop_figures", crop)
    calls = AsyncMock(return_value=(None, [], "OUTPUT_INVALID"))
    monkeypatch.setattr(document, "structured_call", calls)
    reads = AsyncMock(wraps=files.get_verified)
    monkeypatch.setattr(files, "get_verified", reads)
    await document._vision(cast(Any, {"artifact": page.model_dump(), "ocrArtifact": ocr.model_dump(), "index": 0}), runtime)
    if missing:
        crop.assert_called_once_with(files.blobs[page.objectKey], [figures[position]["bbox"] for position in missing])
    else:
        crop.assert_not_called()
    assert sum(call.args[0] == page for call in reads.await_args_list) == bool(missing)
    assert calls.await_args is not None
    messages = calls.await_args.args[1][1:-1]
    assert len(messages) == 3
    for position, message in enumerate(messages):
        assert f"elementIndex={figures[position]['elementIndex']}." in message.content[0]["text"]
        data = f"subimage-{position}".encode() if position in existing else f"crop-{position}".encode()
        media_type = "image/png" if position in existing else "image/jpeg"
        assert message.content[1]["image_url"]["url"] == vision._data_url(data, media_type)
    assert json.loads(calls.await_args.args[1][-1].content.split("\n")[-1])["figures"] == [
        {"elementIndex": index, "bbox": [position / 10, 0, .8, .8], "kind": "image"}
        for position, index in enumerate([8, 2, 19])]
    assert json.loads(files.blobs[ocr.objectKey]) == primary


async def test_split_jobs_overlap_with_bounded_admission_and_ordered_replay(monkeypatch):
    files, reference, runtime, control = prepare(monkeypatch)
    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", "4")
    calls = tencent_provider(monkeypatch)
    original = tencent.request
    chunks = [b"aaa\n", b"bbb\n", b"ccc\n", b"ddd\n"]
    identifiers = {"synthetic-" + hashlib.sha256(chunk).hexdigest(): index for index, chunk in enumerate(chunks)}
    polling = [asyncio.Event() for _ in chunks]
    release = [asyncio.Event() for _ in chunks]
    finished = []
    third_finished = asyncio.Event()

    async def request(action, data, settings):
        if action.startswith("Submit"):
            index = chunks.index(base64.b64decode(data["FileBase64"]))
            record = await runtime.store.aget(namespace("performance", "tencent_jobs"), f"source-0-{index}")
            assert record.value["status"] == "SUBMITTING" and not record.value.get("taskId")
            inputs = await runtime.store.aget(namespace("performance", "tencent_inputs"), "source")
            assert len(inputs.value["parts"]) == 4  # All preflight and receipts precede paid work.
        else:
            index = identifiers[data["TaskId"]]
            polling[index].set()
            await release[index].wait()
            finished.append(index)
            if len(finished) == 3:
                third_finished.set()
        return await original(action, data, settings)

    monkeypatch.setattr(tencent, "request", request)
    running = asyncio.create_task(document._prepare(cast(Any, {"document": reference}), runtime))
    try:
        await asyncio.wait_for(asyncio.gather(polling[0].wait(), polling[1].wait()), 5)
        assert control.active == 2
        assert sum(action.startswith("Submit") for action, _ in calls) == 2
        for index in [1, 2]:
            release[index].set()
            await asyncio.wait_for(polling[index + 1].wait(), 5)
            assert control.active == 2
        release[3].set()
        # Ensure part 3 finishes before the slow first part without wall-clock timing.
        await asyncio.wait_for(third_finished.wait(), 5)
        release[0].set()
        result = await asyncio.wait_for(running, 5)
    finally:
        for event in release:
            event.set()
        if not running.done():
            running.cancel()
        await asyncio.gather(running, return_exceptions=True)
    assert finished == [1, 2, 3, 0] and control.active == 0
    assert [part["byteStart"] for part in result["inputParts"]] == [0, 4, 8, 12]
    pages = [json.loads(files.blobs[ref["objectKey"]]) for ref in result["ocrPageRefs"]]
    assert [page["elements"][0]["text_info"]["content"] for page in pages] == [chunk.decode() for chunk in chunks]
    assert [page["page"] for page in pages] == list(range(4))
    assert len(await runtime.store.asearch(namespace("performance", "tencent_jobs"))) == 4
    assert await document._prepare(cast(Any, {"document": reference}), runtime) == result
    assert len(calls) == 8  # Four submits/queries; replay performs neither.


@pytest.mark.parametrize("failure", ["cancel", "unknown-submit"])
async def test_split_error_stops_queued_work_drains_cleanup_and_never_resubmits_unknown(monkeypatch, failure):
    _, reference, runtime, control = prepare(monkeypatch)
    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", "4")
    provider_calls = tencent_provider(monkeypatch)
    original = tencent.request
    submitted = []
    first_submitting = asyncio.Event()
    waiting = asyncio.Event()
    fail = asyncio.Event()
    cleanup_started = asyncio.Event()
    cleanup_release = asyncio.Event()
    cleanup_finished = asyncio.Event()

    async def request(action, data, settings):
        if action.startswith("Submit"):
            chunk = base64.b64decode(data["FileBase64"])
            submitted.append(chunk)
            if chunk == b"aaa\n":
                first_submitting.set()
                await fail.wait()
                raise DocumentProcessingError(502, "lost response", "TENCENT_API_UNAVAILABLE")
            return await original(action, data, settings)
        waiting.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleanup_started.set()
            await cleanup_release.wait()
            cleanup_finished.set()

    monkeypatch.setattr(tencent, "request", request)
    running = asyncio.create_task(document._prepare(cast(Any, {"document": reference}), runtime))
    try:
        await asyncio.wait_for(asyncio.gather(waiting.wait(), first_submitting.wait()), 5)
        if failure == "cancel":
            running.cancel()
        else:
            fail.set()
        await asyncio.wait_for(cleanup_started.wait(), 5)
        if failure == "cancel":
            running.cancel()
            await asyncio.sleep(0)
        assert not running.done() and not cleanup_finished.is_set() and control.active > 0
        assert sorted(submitted) == [b"aaa\n", b"bbb\n"]
    finally:
        cleanup_release.set()
    if failure == "cancel":
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(running, 5)
    else:
        with pytest.raises(DocumentProcessingError, match="unknown outcome"):
            await asyncio.wait_for(running, 5)
    assert cleanup_finished.is_set() and control.active == 0
    records = await runtime.store.asearch(namespace("performance", "tencent_jobs"))
    assert len(records) == 2
    first = await runtime.store.aget(namespace("performance", "tencent_jobs"), "source-0-0")
    second = await runtime.store.aget(namespace("performance", "tencent_jobs"), "source-0-1")
    assert first.value["status"] == "SUBMITTING" and not first.value.get("taskId")
    assert second.value["taskId"]  # Known work remains resumable; unknown work is not replayed.
    monkeypatch.setattr(tencent, "request", original)
    with pytest.raises(DocumentProcessingError) as error:
        await document._prepare(cast(Any, {"document": reference}), runtime)
    assert error.value.code == "TENCENT_SUBMISSION_UNKNOWN"
    assert sorted(submitted) == [b"aaa\n", b"bbb\n"]
    replay_submits = [base64.b64decode(data["FileBase64"]) for action, data in provider_calls if action.startswith("Submit")]
    assert b"aaa\n" not in replay_submits and replay_submits.count(b"bbb\n") == 1


@pytest.mark.parametrize("split", [False, True])
async def test_page_artifacts_precede_paid_work_without_rendered_bytes_in_prepare_frame(monkeypatch, split):
    files, reference, runtime, _ = prepare(monkeypatch)
    buffer = BytesIO()
    Image.frombytes("RGBA", (40, 40), random.Random(7).randbytes(40 * 40 * 4)).save(buffer, format="PNG")
    payload = buffer.getvalue()
    reference.update(sourceType="image", mediaType="image/png", sha256=hashlib.sha256(payload).hexdigest(), sizeBytes=len(payload))
    reference["objectKey"] = document_source_key("image", reference["sha256"])
    files.blobs[reference["objectKey"]] = payload
    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", "700" if split else "8192")
    extracted_refs = []

    class Images(list):
        pass

    async def extract(*_args):
        images = Images([memoryview(payload).tobytes()])
        extracted = ExtractedDocument(text="", page_images=images)
        extracted_refs.extend([weakref.ref(extracted), weakref.ref(images)])
        return extracted

    monkeypatch.setattr(document, "extract", extract)
    calls = tencent_provider(monkeypatch, [ocr_text_page("question")])
    original = tencent.request
    snapshots = []

    def contains_bytes(value):
        if isinstance(value, bytes):
            return bool(value)
        if isinstance(value, (list, tuple)):
            return any(contains_bytes(item) for item in value)
        if isinstance(value, dict):
            return any(contains_bytes(item) for item in value.values())
        return False

    async def request(action, data, settings):
        if action.startswith("Submit"):
            frame = cast(Any, running.get_coro()).cr_frame
            assert frame is not None and not contains_bytes(frame.f_locals)
            assert all(ref() is None for ref in extracted_refs)
            page_refs = frame.f_locals["page_refs"]
            assert len(page_refs) == len(frame.f_locals["submissions"])
            for ref in page_refs:
                assert await files.get_verified(ref) == files.blobs[ref.objectKey]
            if split:
                saved = await runtime.store.aget(namespace("performance", "tencent_inputs"), "source")
                assert saved.value["parts"] == frame.f_locals["input_parts"]
                for part in saved.value["parts"]:
                    for key in ("reference", "originalPageRef"):
                        ref = ArtifactReference.model_validate(part[key])
                        assert hashlib.sha256(files.blobs[ref.objectKey]).hexdigest() == ref.sha256
                assert page_refs == [ref for ref, _, _ in frame.f_locals["submissions"]]
            snapshots.append(len(page_refs))
        return await original(action, data, settings)

    monkeypatch.setattr(tencent, "request", request)
    running = asyncio.create_task(document._prepare(cast(Any, {"document": reference}), runtime))
    result = await asyncio.wait_for(running, 5)
    assert snapshots and len(result["pageRefs"]) == snapshots[0]
    assert len(calls) == 2 * len(snapshots)
    for ref in result["pageRefs"]:
        assert hashlib.sha256(files.blobs[ref["objectKey"]]).hexdigest() == ref["sha256"]
    if not split:
        assert "/page/" in result["pageRefs"][0]["objectKey"]
        assert files.blobs[result["pageRefs"][0]["objectKey"]] == payload
    else:
        assert all(files.blobs[part["originalPageRef"]["objectKey"]] == payload for part in result["inputParts"])


async def test_page_persistence_failure_prevents_every_paid_submission(monkeypatch):
    files, reference, runtime, _ = prepare(monkeypatch)
    old_key = reference["objectKey"]
    reference.update(sourceType="pdf", mediaType="application/pdf", objectKey=document_source_key("pdf", reference["sha256"]))
    files.blobs[reference["objectKey"]] = files.blobs.pop(old_key)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()])))
    put = files.put_artifact

    async def fail_page(data, **kwargs):
        if kwargs["kind"] == "page":
            raise OSError("storage unavailable")
        return await put(data, **kwargs)

    monkeypatch.setattr(files, "put_artifact", fail_page)
    paid = AsyncMock()
    monkeypatch.setattr(document, "parse_job", paid)
    with pytest.raises(OSError, match="storage unavailable"):
        await document._prepare(cast(Any, {"document": reference}), runtime)
    paid.assert_not_awaited()
