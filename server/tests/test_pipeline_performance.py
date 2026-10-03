"""Execution-scoped page reuse preserves validation, cleanup and source pixels."""

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.runtime import Runtime

from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document, vision
from tests.support import (
    FakeModel,
    FakeObjectStore,
    local_graph,
    make_image,
    question,
    source,
)


@pytest.mark.parametrize("kind", ["csv", "image"])
def test_extraction_loads_only_required_native_modules(kind):
    fixture = Path(__file__).parents[2] / "app/fixtures/ai-import/formats" / f"all-types.{('png' if kind == 'image' else 'csv')}"
    script = """import json, sys
from pathlib import Path
from practiq_ai.extractors import extract
extract(sys.argv[1], Path(sys.argv[2]).read_bytes())
print(json.dumps({'pdf': 'pypdfium2' in sys.modules, 'image': 'PIL.Image' in sys.modules}))
"""
    result = subprocess.run([sys.executable, "-c", script, kind, str(fixture)], check=True, capture_output=True, text=True)
    assert json.loads(result.stdout) == {"pdf": False, "image": kind == "image"}


async def test_shared_page_reads_encode_once_and_new_execution_revalidates(monkeypatch):
    image = make_image()
    store = FakeObjectStore({})
    reference = await store.put_artifact(image, source_sha256="a" * 64, kind="page", index=0, media_type="image/png")
    reads = AsyncMock(wraps=store.get_verified)
    monkeypatch.setattr(store, "get_verified", reads)
    context = {}
    first, second = await asyncio.gather(document._page_image(store, reference, context), document._page_image(store, reference, context))
    assert first == second == (image, vision._data_url(image, "image/png"))
    assert reads.await_count == 1
    bad = reference.model_copy(update={"sizeBytes": reference.sizeBytes + 1})
    with pytest.raises(DocumentProcessingError, match="size does not match"):
        await document._page_image(store, bad, context)
    store.blobs[reference.objectKey] = image[:-1] + bytes([image[-1] ^ 1])
    with pytest.raises(DocumentProcessingError, match="checksum does not match"):
        await document._page_image(store, reference, {})
    assert reads.await_count == 3
    assert not context[document.PAGE_IMAGE_CACHE_KEY]["pending"]


async def test_page_cache_eviction_and_oversized_pages_still_validate(monkeypatch):
    image = make_image()
    store = FakeObjectStore({})
    refs = [await store.put_artifact(image, source_sha256="a" * 64, kind="page", index=i, media_type="image/png") for i in range(2)]
    reads = AsyncMock(wraps=store.get_verified)
    monkeypatch.setattr(store, "get_verified", reads)
    limit = len(image) + len(vision._data_url(image, "image/png"))
    monkeypatch.setattr(document, "PAGE_IMAGE_CACHE_LIMIT", limit)
    context = {}
    for reference in [*refs, refs[0]]:
        await document._page_image(store, reference, context)
    cache = context[document.PAGE_IMAGE_CACHE_KEY]
    assert len(cache["images"]) == 1 and cache["bytes"] == limit and reads.await_count == 3
    monkeypatch.setattr(document, "PAGE_IMAGE_CACHE_LIMIT", limit - 1)
    context = {}
    await document._page_image(store, refs[0], context)
    await document._page_image(store, refs[0], context)
    assert reads.await_count == 5 and not context[document.PAGE_IMAGE_CACHE_KEY]["images"]


async def test_graph_page_reuse_is_not_checkpointed_and_released_after_completion(monkeypatch):
    store, reference = source("Synthetic PDF source")
    images = [make_image()] * 3
    model = FakeModel(responses=[{"questions": [question(f"Page {i}")]} for i in range(3)])
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_model", lambda: model)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=images)))
    reads = AsyncMock(wraps=store.get_verified)
    monkeypatch.setattr(store, "get_verified", reads)
    context = {"execution": "test"}
    saver = InMemorySaver()
    graph = local_graph(saver)
    result = await graph.ainvoke({"document": reference}, context=cast(Any, context))
    assert result["status"] == "SUCCEEDED" and len(model.calls) == len(result["usage"]) == 3
    page_reads = [call for call in reads.await_args_list if call.args[0].objectKey.startswith("artifact/")]
    assert len(page_reads) == 3
    assert document.PAGE_IMAGE_CACHE_KEY not in context
    for checkpoint in saver.list(graph.config):
        assert document.PAGE_IMAGE_CACHE_KEY not in checkpoint.checkpoint["channel_values"]


async def test_cancelled_waiter_does_not_cancel_shared_page_read(monkeypatch):
    store = FakeObjectStore({})
    reference = await store.put_artifact(make_image(), source_sha256="a" * 64, kind="page", index=0, media_type="image/png")
    entered = asyncio.Event()
    release = asyncio.Event()
    verified = store.get_verified
    async def blocked(_reference):
        entered.set()
        await release.wait()
        return await verified(_reference)
    monkeypatch.setattr(store, "get_verified", blocked)
    context = {}
    read = asyncio.create_task(document._page_image(store, reference, context))
    second = asyncio.create_task(document._page_image(store, reference, context))
    await entered.wait()
    read.cancel()
    with pytest.raises(asyncio.CancelledError):
        await read
    release.set()
    assert (await second)[0] == make_image()
    cache = context[document.PAGE_IMAGE_CACHE_KEY]
    assert len(cache["images"]) == 1 and not cache["pending"]


async def test_execution_failure_cancels_pending_reads_and_releases_page_cache(monkeypatch):
    store = FakeObjectStore({})
    reference = await store.put_artifact(make_image(), source_sha256="a" * 64, kind="page", index=0, media_type="image/png")
    entered = asyncio.Event()
    async def blocked(_reference):
        entered.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(store, "get_verified", blocked)
    monkeypatch.setattr(document, "validate_execution", lambda *_: None)
    monkeypatch.setattr(document, "guard", AsyncMock())
    monkeypatch.setattr(document, "run_remaining", AsyncMock(return_value=10))
    context = {}
    read = asyncio.create_task(document._page_image(store, reference, context))
    await entered.wait()
    pending = list(context[document.PAGE_IMAGE_CACHE_KEY]["pending"].values())
    async def fail(_state):
        raise RuntimeError("execution failed")
    with pytest.raises(RuntimeError, match="execution failed"):
        await document._guarded(fail)({"execution": {}}, Runtime(context=cast(Any, context)))
    with pytest.raises(asyncio.CancelledError):
        await read
    assert document.PAGE_IMAGE_CACHE_KEY not in context and all(task.cancelled() for task in pending)


async def test_failed_read_after_waiter_cancellation_is_removed_and_retryable(monkeypatch):
    store = FakeObjectStore({})
    reference = await store.put_artifact(make_image(), source_sha256="a" * 64, kind="page", index=0, media_type="image/png")
    entered, release = asyncio.Event(), asyncio.Event()
    async def fail(_reference):
        entered.set()
        await release.wait()
        raise DocumentProcessingError(409, "checksum mismatch", "DOCUMENT_CHECKSUM_MISMATCH")
    verified = store.get_verified
    monkeypatch.setattr(store, "get_verified", fail)
    context = {}
    read = asyncio.create_task(document._page_image(store, reference, context))
    await entered.wait()
    pending = list(context[document.PAGE_IMAGE_CACHE_KEY]["pending"].values())
    read.cancel()
    with pytest.raises(asyncio.CancelledError):
        await read
    release.set()
    await asyncio.wait(pending)
    cache = context[document.PAGE_IMAGE_CACHE_KEY]
    assert not cache["pending"] and not cache["images"]
    monkeypatch.setattr(store, "get_verified", verified)
    assert (await document._page_image(store, reference, context))[0] == make_image()
