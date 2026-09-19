from unittest.mock import AsyncMock

"""Page ordering, conversion failures and real local rendering (no model calls)."""

import asyncio
from io import BytesIO
from pathlib import Path

import pytest

from practiq_ai.contracts import DOCUMENT_MEDIA_TYPES, document_source_key
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import ExtractedDocument, extract
from practiq_ai.graphs import document
from tests.support import (
    FakeModel,
    local_graph,
    make_image,
    question,
    source,
)


def paged_source(kind):
    store, reference = source("document")
    old_key = reference["objectKey"]
    reference.update(
        sourceType=kind,
        mediaType=next(iter(DOCUMENT_MEDIA_TYPES[kind])),
        objectKey=document_source_key(kind, reference["sha256"]),
    )
    store.blobs[reference["objectKey"]] = store.blobs.pop(old_key)
    return store, reference


@pytest.mark.parametrize("kind", ["pdf"])
def test_missing_vision_fails_before_read_or_render(monkeypatch, kind):
    _, reference = paged_source(kind)
    monkeypatch.setattr(document, "get_model", lambda *args: None)
    monkeypatch.setattr(
        document, "get_object_store", lambda: pytest.fail("must not read")
    )
    monkeypatch.setattr(document, "extract", AsyncMock(side_effect=lambda *_: pytest.fail("must not render")))
    with pytest.raises(DocumentProcessingError) as error:
        asyncio.run(local_graph().ainvoke({"document": reference}))
    assert error.value.code == "VISION_MODEL_REQUIRED"


@pytest.mark.parametrize("kind", ["pdf"])
@pytest.mark.parametrize("failed", [set(), {1}, {0, 1, 2}])
def test_page_order_gaps_and_crops(monkeypatch, kind, failed):
    store, reference = paged_source(kind)
    model = FakeModel(responses=[{"questions": [question("Across pages")]}])
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(
        document,
        "extract",
        AsyncMock(side_effect=lambda *_: ExtractedDocument(text="", page_images=[make_image()] * 3)),
    )

    async def page_call(_model, messages, schema, call_kind, *, runtime=None):
        prompt = messages[-1].content
        index = next(i for i in range(3) if f"PRIMARY page {i + 1}" in prompt)
        assert schema is document.PageParseResult and call_kind == "vision_parse"
        images = [message for message in messages if isinstance(message.content, list)]
        assert len(images) == (3 if index == 1 else 2)
        await asyncio.sleep((2 - index) * 0.01)
        if index in failed:
            return None, [], "OUTPUT_INVALID"
        return schema.model_validate({"questions": [question(f"Page {index + 1}")],
            "figures": [{"kind": "image", "description": "Figure", "bbox": [0.1, 0.1, 0.8, 0.8]}]}), [], None

    monkeypatch.setattr(document, "structured_call", page_call)
    if len(failed) == 3:
        with pytest.raises(DocumentProcessingError) as error:
            asyncio.run(local_graph().ainvoke({"document": reference}))
        assert error.value.code == "DOCUMENT_PARSE_FAILED"
        return
    result = asyncio.run(local_graph().ainvoke({"document": reference}))
    assert not model.calls  # No transcription or subsequent text-model call.
    assert [q["stem"] for q in result["result"]["questions"]] == [f"Page {i + 1}" for i in range(3) if i not in failed]
    assert result["status"] == ("PARTIAL" if failed else "SUCCEEDED")
    assert len(result["processing"]["failures"]) == len(failed)

    for figure in result["result"]["visualElements"]:
        assert figure["page"] not in failed
        assert figure["description"].startswith("[page crop]")
        assert figure["imageRef"]["objectKey"] in store.blobs


@pytest.mark.parametrize("fixture", ["text-layer.pdf", "scanned.pdf"])
def test_real_pdf_fixtures_render_all_pages(fixture):
    import pypdfium2

    path = Path(__file__).parents[1] / "evals/fixtures/pdf" / fixture
    if not path.exists():
        pytest.fail(f"Missing PDF fixture: {path}")
    payload = path.read_bytes()
    with pypdfium2.PdfDocument(payload) as source:
        count = len(source)
    result = extract("pdf", payload)
    assert result.text == "" and len(result.page_images) == count


def test_mixed_pdf_renders_text_and_scanned_pages():
    import pypdfium2

    fixtures = Path(__file__).parents[1] / "evals/fixtures/pdf"
    with pypdfium2.PdfDocument.new() as merged:
        for name in ("text-layer.pdf", "scanned.pdf"):
            with pypdfium2.PdfDocument(fixtures / name) as source_pdf:
                merged.import_pages(source_pdf)
        count = len(merged)
        payload = BytesIO()
        merged.save(payload)
    result = extract("pdf", payload.getvalue())
    assert result.text == "" and len(result.page_images) == count
