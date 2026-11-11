"""Bounded work and resource lifetimes; no provider or model calls."""

import asyncio
import hashlib
import threading
from io import BytesIO
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from langgraph.store.memory import InMemoryStore
from PIL import Image

from practiq_ai import tencent
from practiq_ai.contracts import DocumentReference
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from practiq_ai.tencent_inputs import split_image
from tests.support import FakeObjectStore, parsed, source


@pytest.mark.parametrize("cos", [False, True])
async def test_submitted_source_buffers_are_released_before_polling(monkeypatch, cos):
    monkeypatch.setenv("AI_TENCENT_SECRET_ID", "synthetic-id")
    monkeypatch.setenv("AI_TENCENT_SECRET_KEY", "synthetic-key")
    if cos:
        monkeypatch.setenv("AI_TENCENT_COS_ENABLED", "true")
        monkeypatch.setenv("AI_TENCENT_COS_BUCKET", "fixture-1250000000")
        monkeypatch.setenv("AI_TENCENT_COS_REGION", "ap-guangzhou")
    payload = b"x" * (1024 * 1024)
    reference = DocumentReference(sourceType="image", mediaType="image/png", objectKey="source",
                                  sha256=hashlib.sha256(payload).hexdigest(), sizeBytes=len(payload))
    files = FakeObjectStore({"source": payload})
    runtime = cast(Any, SimpleNamespace(store=InMemoryStore(), execution_info=SimpleNamespace(thread_id="buffers", run_id="run")))
    monkeypatch.setattr(tencent, "get_object_store", lambda: files)
    monkeypatch.setattr(tencent, "guard", AsyncMock())
    monkeypatch.setattr(tencent, "run_remaining", AsyncMock(return_value=60))
    monkeypatch.setattr(tencent, "upload_source", AsyncMock())
    polling = asyncio.Event()
    actions, clients = [], []

    async def request(action, _data, _config, **_kwargs):
        actions.append(action)
        clients.append(tencent._RPC_CLIENT.get())
        if action.startswith("Submit"):
            return {"TaskId": "synthetic-task"}
        polling.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(tencent, "request", request)
    task = asyncio.create_task(tencent.parse_job(reference, runtime))
    try:
        await asyncio.wait_for(polling.wait(), 5)
        # Inspect only this module's suspended coroutine, not HTTP/mock call history.
        frame = cast(Any, task.get_coro()).cr_await.cr_frame
        assert frame.f_code.co_name == "_parse_job"
        assert not frame.f_locals.get("payload")
        assert not frame.f_locals.get("data")
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert actions == ["SubmitMultimodalDocParseJob", "DescribeMultimodalDocParseJob"]
    assert clients[0] is not None and clients[0].is_closed and clients[1] is clients[0]
    assert tencent._RPC_CLIENT.get() is None


@pytest.mark.parametrize("failed", [False, True])
async def test_job_reuses_one_rpc_client_and_closes_it_after_multiple_polls(monkeypatch, failed):
    monkeypatch.setenv("AI_TENCENT_SECRET_ID", "synthetic-id")
    monkeypatch.setenv("AI_TENCENT_SECRET_KEY", "synthetic-key")
    files, value = source("source")
    reference = DocumentReference.model_validate(value)
    runtime = cast(Any, SimpleNamespace(store=InMemoryStore(), execution_info=SimpleNamespace(thread_id="client", run_id="run")))
    monkeypatch.setattr(tencent, "get_object_store", lambda: files)
    monkeypatch.setattr(tencent, "guard", AsyncMock())
    monkeypatch.setattr(tencent, "run_remaining", AsyncMock(return_value=60))
    monkeypatch.setattr(tencent.asyncio, "sleep", AsyncMock())
    clients, actions = [], []
    original = httpx.AsyncClient

    def respond(request):
        actions.append(request.headers["X-TC-Action"])
        if len(actions) == 1:
            body = {"TaskId": "synthetic-task"}
        elif failed:
            body = {"Error": {"Code": "AuthFailure.SignatureFailure"}, "RequestId": "query-rejection"}
        elif len(actions) < 4:
            body = {"Status": "Processing"}
        else:
            body = {"Status": "Success", "ResultUrl": "unused"}
        return httpx.Response(200, json={"Response": body})

    def client(**kwargs):
        assert kwargs == {"timeout": 60, "trust_env": False, "follow_redirects": False}
        value = original(transport=httpx.MockTransport(respond), **kwargs)
        clients.append(value)
        return value

    monkeypatch.setattr(httpx, "AsyncClient", client)
    monkeypatch.setattr(tencent, "download_result", AsyncMock(return_value=b"archive"))
    if failed:
        with pytest.raises(DocumentProcessingError) as error:
            await tencent.parse_job(reference, runtime)
        assert error.value.code == "TENCENT_QUERY_REJECTED" and len(actions) == 2
    else:
        result = await tencent.parse_job(reference, runtime)
        assert result["resultRef"] and len(actions) == 4
    assert len(clients) == 1 and clients[0].is_closed
    assert tencent._RPC_CLIENT.get() is None


@pytest.mark.parametrize("mode", ["RGB", "RGBA", "P"])
def test_small_png_reuses_verified_bytes_without_crop_or_encode(monkeypatch, mode):
    output = BytesIO()
    with Image.new(mode, (80, 60)) as image:
        image.save(output, format="PNG", compress_level=3)
    payload = output.getvalue()
    crop = Mock(side_effect=AssertionError("Already bounded PNG must not be cropped"))
    encode = Mock(side_effect=AssertionError("Already bounded PNG must not be re-encoded"))
    monkeypatch.setattr(Image.Image, "crop", crop)
    monkeypatch.setattr(Image.Image, "save", encode)
    parts = split_image(payload, len(payload), 1)
    assert parts == [(payload, "image/png", (0, 0, 80, 60))]
    assert parts[0][0] is payload
    crop.assert_not_called()
    encode.assert_not_called()


async def test_merge_validates_and_finalizes_off_loop_and_skips_absent_source_proof(monkeypatch):
    files, reference = source("source")
    monkeypatch.setattr(document, "get_object_store", lambda: files)
    loop_thread = threading.get_ident()
    validate = document.ChunkParseResult.model_validate
    finalize = document.finalize_question_ids
    calls = []

    def validate_off_loop(*args, **kwargs):
        assert threading.get_ident() != loop_thread
        calls.append("validate")
        return validate(*args, **kwargs)

    def finalize_off_loop(*args, **kwargs):
        assert threading.get_ident() != loop_thread
        calls.append("finalize")
        return finalize(*args, **kwargs)

    monkeypatch.setattr(document.ChunkParseResult, "model_validate", validate_off_loop)
    monkeypatch.setattr(document, "finalize_question_ids", finalize_off_loop)
    proof = Mock(side_effect=AssertionError("No source evidence is available"))
    monkeypatch.setattr(document, "find_source_duplicate_question_trees", proof)
    state = {"document": reference, "chunkResults": [{"index": 0, "parsed": parsed()}]}
    result = await document._merge(cast(Any, state), passive=True)
    assert len(result["result"]["questions"]) == 1
    assert calls == ["validate", "finalize"]
    proof.assert_not_called()


async def test_merge_cancellation_drains_the_finalization_worker(monkeypatch):
    files, reference = source("source")
    monkeypatch.setattr(document, "get_object_store", lambda: files)
    entered, released, finished = threading.Event(), threading.Event(), threading.Event()
    original = document.finalize_question_ids

    def finalize(*args):
        entered.set()
        try:
            assert released.wait(5)
            return original(*args)
        finally:
            finished.set()

    monkeypatch.setattr(document, "finalize_question_ids", finalize)
    state = {"document": reference, "chunkResults": [{"index": 0, "parsed": parsed()}]}
    task = asyncio.create_task(document._merge(cast(Any, state), passive=True))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done() and not finished.is_set()
        released.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()
    finally:
        released.set()
        await asyncio.gather(task, return_exceptions=True)
