"""Tencent structuring reads OCR evidence without encoding source page images."""

import json
import subprocess
import sys
from pathlib import Path
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from practiq_ai.contracts import document_source_key
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document
from tests.support import (
    local_graph,
    make_image,
    ocr_page_model,
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


async def test_graph_page_reuse_is_not_checkpointed_and_released_after_completion(monkeypatch):
    store, reference = source("Synthetic PDF source")
    old_key = reference["objectKey"]
    reference.update(sourceType="pdf", mediaType="application/pdf", objectKey=document_source_key("pdf", reference["sha256"]))
    store.blobs[reference["objectKey"]] = store.blobs.pop(old_key)
    images = [make_image()] * 3
    model = ocr_page_model(monkeypatch, [{"questions": [question(f"Page {i}")]} for i in range(3)], page_count=3)
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
    page_reads = [call for call in reads.await_args_list if call.args[0].mediaType in {"image/png", "image/jpeg"}]
    assert page_reads == []  # Structuring reads Tencent evidence instead of full-page images.
    assert all(not isinstance(message.content, list) for call in model.calls for message in call)
    assert "_practiq_page_images" not in context
    for checkpoint in saver.list(graph.config):
        assert "_practiq_page_images" not in checkpoint.checkpoint["channel_values"]


@pytest.mark.usefixtures("disposable_databases")
async def test_checkpoint_benchmark_uses_tencent_substitutes(tmp_path):
    from scripts.benchmark_pipeline import checkpoint_profile

    report = await checkpoint_profile(2, make_image(), tmp_path)
    assert report["syntheticQuestions"] == 20
    assert report["identicalReplayedOutput"] and report["replayAddedModelCalls"] == 0
