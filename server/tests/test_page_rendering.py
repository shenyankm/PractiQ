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
            "figures": [{"kind": "image", "description": "Figure", "questionIndexes": [0], "bbox": [0.1, 0.1, 0.8, 0.8]}]}), [], None

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

    cropped = [v for v in result["result"]["visualElements"] if v["imageRef"]]
    for index, figure in enumerate(cropped):
        assert figure["questionIndexes"] == [index]
        assert figure["page"] not in failed
        assert figure["description"].startswith("[page crop]")
        assert figure["imageRef"]["objectKey"] in store.blobs
    assert {v["page"] for v in result["result"]["visualElements"] if v["imageRef"] is None and v["sourceRef"]} == failed


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


def test_rich_pdf_preserves_formula_and_table_blocks(monkeypatch, tmp_path):
    """Real PDF pixels/crops, deterministic model output; not an OCR accuracy claim."""
    import hashlib
    import json

    from practiq_ai.contracts import DocumentUploadRequest
    from tests.support import object_store

    fixture = Path(__file__).parents[2] / "app/fixtures/rich-content"
    expected = json.loads((fixture / "expected.json").read_text())
    payload = (fixture / "source.pdf").read_bytes()
    rendered = extract("pdf", payload)
    assert len(rendered.page_images) == 1
    store = object_store(tmp_path)
    ref = asyncio.run(store.put_document(payload, DocumentUploadRequest(
        sourceType="pdf", fileName="source.pdf", mediaType="application/pdf",
        sha256=hashlib.sha256(payload).hexdigest(), sizeBytes=len(payload))))
    response = {"questions": expected["questions"], "groups": [], "figures": [
        {"kind": "chart", "description": "Measurement curve", "bbox": [0.1, 0.6, 0.9, 0.8]}]}
    monkeypatch.setattr(document, "get_model", lambda *args: FakeModel(responses=[response]))
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    result = asyncio.run(local_graph().ainvoke({"document": ref.model_dump()}))
    assert result["status"] == "SUCCEEDED"
    assert result["result"]["questions"][0]["contentBlocks"] == [
        {"role": None, "textValue": None, "markdownValue": None, "latexValue": None, "jsonValue": None, **b}
        for b in expected["questions"][0]["contentBlocks"]]
    from PIL import Image

    from practiq_ai.contracts import ArtifactReference

    crop = ArtifactReference.model_validate(result["result"]["visualElements"][0]["imageRef"])
    with Image.open(BytesIO(asyncio.run(store.get_verified(crop)))) as image:
        assert image.width > 500 and image.height > 200


def test_rich_recognition_gate_rejects_wrong_formula_and_clipped_table(tmp_path):
    import json
    import runpy

    root = Path(__file__).parents[2]
    fixture = root / "app/fixtures/rich-content"
    check = runpy.run_path(str(root / "app/scripts/check-rich-recognition.py"))["check_result"]
    result = json.loads((fixture / "expected.json").read_text())
    result["questions"][0]["sourceText"] += result["questions"][0]["contentBlocks"][-1]["markdownValue"]
    result["visualElements"] = json.loads((fixture / "visual-regions.json").read_text())["regions"]
    payload = (fixture / "source.pdf").read_bytes()
    assert all(check(result, payload, tmp_path).values())
    result["questions"][0]["contentBlocks"][2]["latexValue"] = r"\sqrt{x}+1"
    result["visualElements"][0]["bbox"][1] += 0.08
    result["questions"][0]["contentBlocks"].pop()
    checks = check(result, payload, tmp_path)
    assert not checks["radicandPreserved"]
    assert not checks["structuredTablePreserved"]
    assert not checks["tableCropCoverage95"]


def test_figure_links_remap_across_pages_and_failed_crops_keep_source(monkeypatch):
    from practiq_ai.graphs import vision

    store, reference = paged_source("pdf")
    model = FakeModel(responses=[])
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()] * 2)))

    async def page_call(_model, messages, schema, call_kind, *, runtime=None):
        index = 0 if "PRIMARY page 1" in messages[-1].content else 1
        return schema.model_validate({"questions": [question(f"Page {index}")], "figures": [
            {"kind": "table", "description": "Unstructured table", "questionIndexes": [0], "bbox": [0.1, 0.2, 0.8, 0.9]}]}), [], None

    monkeypatch.setattr(document, "structured_call", page_call)
    monkeypatch.setattr(vision, "crop_figure", lambda *_: None)
    result = asyncio.run(local_graph().ainvoke({"document": reference}))
    visuals = result["result"]["visualElements"]
    assert [v["questionIndexes"] for v in visuals] == [[0], [1]]
    assert all(v["imageRef"] is None and v["sourceRef"]["objectKey"] in store.blobs for v in visuals)
    assert all(q["needsReview"] and {"material", "media"} <= set(q["missingFields"]) for q in result["result"]["questions"])
    assert result["processing"]["quality"]["reviewQuestionCount"] == 2
    for indexes in [[-1], [1], [True]]:
        with pytest.raises(ValueError):
            document.PageParseResult.model_validate({"questions": [question("Q")], "figures": [
                {"kind": "chart", "description": "X", "questionIndexes": indexes, "bbox": [0, 0, 1, 1]}]})


def test_crop_coordinates_use_full_page_dimensions():
    from PIL import Image, ImageDraw

    from practiq_ai.graphs.vision import crop_figure

    page = Image.new("RGB", (1000, 500), "white")
    ImageDraw.Draw(page).rectangle((200, 100, 799, 399), fill="black")
    buf = BytesIO()
    page.save(buf, "PNG")
    crop = crop_figure(buf.getvalue(), [0.2, 0.2, 0.8, 0.8])
    assert crop is not None
    with Image.open(BytesIO(crop)) as image:
        assert image.size == (600, 300)
        for position in [(0, 0), (599, 299)]:
            pixel = image.getpixel(position)
            assert isinstance(pixel, tuple) and max(pixel) < 10


def test_table_rows_escape_cells_and_preserve_ragged_output_for_review():
    from practiq_ai.graphs.vision import PageFigure

    base = {"kind": "table", "description": "Measurements", "bbox": [0, 0, 1, 1]}
    figure = PageFigure(**base, tableRows=[["Name", "Value"], ["A", r"left | right $\frac{1}{2}$"], ["B", ""]])
    assert PageFigure(**base, tableRows=[]).tableRows is None
    assert figure.table_markdown() == "| Name | Value |\n| --- | --- |\n| A | left \\| right $\\frac{1}{2}$ |\n| B |  |"
    irregular = PageFigure(**base, tableRows=[["Name", "Value"], ["A"]])
    assert irregular.tableRows is None and irregular.extractedText == "Name\tValue\nA"


def test_incomplete_table_page_retains_question_and_continuation_figure():
    q = question("Compare trials")
    q["contentBlocks"] = [{"partType": "table", "markdownValue": None}]
    parsed = document.PageParseResult.model_validate({"questions": [q], "figures": []})
    assert parsed.questions[0].needsReview
    assert "material" in parsed.questions[0].missingFields
    assert parsed.questions[0].contentBlocks == []
    continuation = document.PageParseResult.model_validate({"questions": None, "groups": None, "figures": [
        {"kind": "table", "description": "Continued rows", "questionIndexes": [0], "tableRows": [], "bbox": [0, 0, 1, 1]}]})
    assert continuation.questions == []
    assert continuation.figures[0].questionIndexes == []
    assert continuation.figures[0].tableRows is None
