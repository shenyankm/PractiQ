from unittest.mock import AsyncMock

"""Page ordering, conversion failures and real local rendering (no model calls)."""

import asyncio
from io import BytesIO
from pathlib import Path

import pytest

from practiq_ai import llm
from practiq_ai.contracts import DOCUMENT_MEDIA_TYPES, document_source_key
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import ExtractedDocument, extract
from practiq_ai.graphs import document
from tests.support import (
    FakeModel,
    local_graph,
    make_image,
    object_store,
    ocr_draft,
    ocr_page_model,
    ocr_text_page,
    question,
    source,
    tencent_provider,
)


@pytest.mark.parametrize('kind', ['image', 'pdf'])
async def test_unexportable_source_dimensions_fail_before_model_calls(monkeypatch, tmp_path, kind):
    import hashlib

    from PIL import Image

    from practiq_ai.contracts import DocumentUploadRequest

    payload = BytesIO()
    if kind == 'image':
        Image.new('1', (16_385, 1)).save(payload, format='PNG')
    else:
        import pypdfium2 as pdfium
        with pdfium.PdfDocument.new() as pdf:
            pdf.new_page(6_000, 10)
            pdf.save(payload)
    data = payload.getvalue()
    files = object_store(tmp_path)
    reference = await files.put_document(data, DocumentUploadRequest(
        sourceType=kind, fileName='wide.' + ('png' if kind == 'image' else 'pdf'),
        mediaType='image/png' if kind == 'image' else 'application/pdf',
        sizeBytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
    ))
    model = ocr_page_model(monkeypatch, [], page_count=1)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    with pytest.raises(DocumentProcessingError) as error:
        await local_graph().ainvoke({'document': reference.model_dump(mode='json')})
    assert error.value.status_code == 413
    assert error.value.code == 'IMAGE_TOO_LARGE'
    assert model.calls == []


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


@pytest.mark.parametrize("kind", ["text", "pdf"])
def test_missing_model_fails_before_read_or_render(monkeypatch, kind):
    _, reference = paged_source(kind)
    monkeypatch.setenv("AI_READ_ONLY", "1")
    monkeypatch.setattr(document, "get_model", llm.get_model.__wrapped__)
    monkeypatch.setattr(
        document, "get_object_store", lambda: pytest.fail("must not read")
    )
    monkeypatch.setattr(document, "extract", AsyncMock(side_effect=lambda *_: pytest.fail("must not render")))
    with pytest.raises(DocumentProcessingError) as error:
        asyncio.run(local_graph().ainvoke({"document": reference}))
    assert error.value.code == "MODEL_NOT_CONFIGURED"


@pytest.mark.parametrize("failed", [set(), {1}, {0, 1, 2}])
async def test_page_order_gaps_and_crops(monkeypatch, failed):
    tencent_provider(monkeypatch, [ocr_text_page("Page source", figures=[{"bbox": [0.1, 0.1, 0.8, 0.8]}]) for _ in range(3)])
    store, reference = paged_source("pdf")
    model = FakeModel(responses=[{"questions": [question("Across pages")]}])
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(
        document,
        "extract",
        AsyncMock(side_effect=lambda *_: ExtractedDocument(text="", page_images=[make_image()] * 3)),
    )

    second_finished = asyncio.Event()
    completed = []

    async def page_call(_model, messages, schema, call_kind, *, runtime=None):
        prompt = messages[-1].content
        index = next(i for i in range(3) if f"PRIMARY is page {i + 1}" in prompt)
        assert schema is document.OcrPageParseResult and call_kind == "vision_parse"
        images = [message for message in messages if isinstance(message.content, list)]
        assert images == []  # Only Tencent evidence reaches question structuring.
        if index == 0:
            await asyncio.wait_for(second_finished.wait(), 5)
        completed.append(index)
        if index == 1:
            second_finished.set()
        if index in failed:
            return None, [], "OUTPUT_INVALID"
        return schema.model_validate(ocr_draft({"questions": [question(f"Page {index + 1}")],
            "figures": [{"kind": "image", "description": "Figure", "questionIndexes": [0]}]})), [], None

    monkeypatch.setattr(document, "structured_call", page_call)
    result = await local_graph().ainvoke({"document": reference})
    assert completed.index(1) < completed.index(0)
    assert not model.calls  # No transcription or subsequent text-model call.
    assert [q["stem"] for q in result["result"]["questions"]] == [f"Page {i + 1}" for i in range(3) if i not in failed]
    assert result["status"] == ("PARTIAL" if failed else "SUCCEEDED")
    assert len(result["processing"]["failures"]) == len(failed)

    cropped = [v for v in result["result"]["visualElements"] if v["imageRef"]]
    assert len(cropped) == 3 - len(failed)
    for index, figure in enumerate(cropped):
        assert figure["questionIds"] == [f"q{index}"]
        assert figure["page"] not in failed
        assert figure["description"].startswith("[page crop]")
        assert figure["imageRef"]["objectKey"] in store.blobs
    assert {v["page"] for v in result["result"]["visualElements"] if v["imageRef"] is None and v["sourceRef"]} == failed


async def test_unassociated_ocr_figure_requires_full_source_review(monkeypatch):
    tencent_provider(monkeypatch, [ocr_text_page("Known question", figures=[{"bbox": [0.1, 0.1, 0.8, 0.8]}])])
    store, reference = paged_source("image")
    draft = question("Known question")
    draft["answerPayload"] = {"text": "Printed answer"}
    model = FakeModel(responses=[ocr_draft({"questions": [draft], "figures": [
        {"kind": "image", "description": "Unassociated source figure", "questionIndexes": []}]})])
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_model", lambda: model)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()])))
    result = await local_graph().ainvoke({"document": reference})
    assert result["processing"]["quality"]["reviewRequired"]
    assert any("detached labels" in warning for warning in result["result"]["warnings"])
    visual = result["result"]["visualElements"][0]
    assert visual["questionIds"] == [] and visual["sourceRef"]
    assert visual["imageRef"] is None
    assert result["status"] == "PARTIAL" and "media" in result["result"]["missingFields"]
    assert any(failure["code"] == "CROP_UNVERIFIED" for failure in result["processing"]["failures"])


async def test_answer_page_ignores_neighbors_after_empty_primary(monkeypatch):
    tencent_provider(monkeypatch, [ocr_text_page("Page source", figures=[]) for _ in range(2)])
    store, reference = paged_source('pdf')
    model = FakeModel(responses=[])
    monkeypatch.setattr(document, 'get_object_store', lambda: store)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(
        text='', page_images=[make_image()] * 2)))
    seen = []

    async def page_call(_model, messages, schema, call_kind, *, runtime=None):
        prompt = messages[-1].content
        assert 'An answer-only PRIMARY page must return questions=[] and groups=[]' in prompt
        assert 'never copy a question from CONTEXT onto an answer page' in prompt
        assert 'only when there is no associated text material' in prompt
        assert 'background text alone does not create a reading parent' in prompt
        assert not any(isinstance(message.content, list) for message in messages)
        primary = 0 if 'PRIMARY is page 1' in prompt else 1
        seen.append(primary)
        return schema.model_validate({'questions': [question('Original question')] if primary == 0 else [],
                                      'groups': [], 'figures': []}), [], None

    monkeypatch.setattr(document, 'structured_call', page_call)
    result = await local_graph().ainvoke({'document': reference})
    assert sorted(seen) == [0, 1]
    assert len(result['result']['questions']) == 1
    assert result['result']['questions'][0]['stem'] == 'Original question'


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
        {"kind": "chart", "description": "Measurement curve", "questionIndexes": [0], "bbox": [0.1, 0.6, 0.9, 0.8]}]}
    monkeypatch.setattr(document, "get_model", lambda *args: ocr_page_model(monkeypatch, [response], page_count=1))
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    result = asyncio.run(local_graph().ainvoke({"document": ref.model_dump()}))
    assert result["status"] == "SUCCEEDED"
    assert result["result"]["questions"][0]["contentBlocks"] == [
        {"label": None, "questionId": None, "role": None, "textValue": None, "markdownValue": None, "latexValue": None, "jsonValue": None, **b}
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
    tencent_provider(monkeypatch, [ocr_text_page("Page source", figures=[{"bbox": [0.1, 0.2, 0.8, 0.9]}]) for _ in range(2)])
    from practiq_ai.graphs import vision

    store, reference = paged_source("pdf")
    model = FakeModel(responses=[])
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()] * 2)))

    async def page_call(_model, messages, schema, call_kind, *, runtime=None):
        index = 0 if "PRIMARY is page 1" in messages[-1].content else 1
        return schema.model_validate(ocr_draft({"questions": [question(f"Page {index}")], "figures": [
            {"kind": "table", "description": "Unstructured table", "questionIndexes": [0]}]})), [], None

    monkeypatch.setattr(document, "structured_call", page_call)
    monkeypatch.setattr(vision, "crop_figure", lambda *_: None)
    result = asyncio.run(local_graph().ainvoke({"document": reference}))
    visuals = result["result"]["visualElements"]
    assert [v["questionIds"] for v in visuals] == [["q0"], ["q1"]]
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


def test_batch_crops_decode_once_and_keep_individual_failure_positions(monkeypatch):
    from practiq_ai.graphs import vision

    payload = make_image()
    boxes = [[0, 0, 0.5, 0.5], [0, 0, 1, 1]]
    expected = [vision.crop_figure(payload, box) for box in boxes]
    original = vision.Image.open
    opened = []

    def counted(*args, **kwargs):
        opened.append(True)
        return original(*args, **kwargs)

    monkeypatch.setattr(vision.Image, "open", counted)
    assert vision.crop_figures(payload, [boxes[0], [1, 1, 0, 0], boxes[1]]) == [expected[0], None, expected[1]]
    assert len(opened) == 1
    assert vision.crop_figures(b"invalid image", boxes) == [None, None]


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


@pytest.mark.parametrize("rows", [
    [[""] * 100 for _ in range(1000)],
    [["Header"], ["|" * 80_000]],
    [[""] * 100 for _ in range(999)] + [["x" * 90_000]],
])
def test_oversized_generated_table_degrades_without_losing_usage(monkeypatch, rows):
    store, reference = paged_source("pdf")
    model = ocr_page_model(monkeypatch, [{"questions": [question("Table")], "figures": [
        {"kind": "table", "description": "Large table", "questionIndexes": [0], "tableRows": rows, "bbox": [0, 0, 1, 1]}]}], page_count=1)
    monkeypatch.setattr(document, "get_model", lambda *_: model)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()])))
    result = asyncio.run(local_graph().ainvoke({"document": reference}))
    q = result["result"]["questions"][0]
    assert q["needsReview"] and "material" in q["missingFields"]
    assert not any(b["partType"] == "table" for b in q["contentBlocks"])
    visual = result["result"]["visualElements"][0]
    assert len(visual["extractedText"]) <= 100_000 and visual["sourceRef"]
    assert result["usage"] and len(model.calls) == 1


@pytest.mark.parametrize("header", ["Answer", "参考答案", "SOLUTION", "Value"])
@pytest.mark.parametrize("transposed", [False, True])
@pytest.mark.parametrize("role", [None, "material"])
def test_answer_table_role_reaches_both_blocks_and_visuals(monkeypatch, header, transposed, role):
    store, reference = paged_source("pdf")
    q = question("Table")
    if header == "Answer" and not transposed:
        q["contentBlocks"] = [{"partType": "table", "markdownValue": "| Question | Answer |\n| --- | --- |\n| 1 | SECRET |"}]
    model = ocr_page_model(monkeypatch, [{"questions": [q], "figures": [
        {"kind": "table", "role": "answer" if header == "Value" else role, "description": "Supplied values", "questionIndexes": [0],
         "tableRows": [["Field", "Value"], [header, "SECRET"]] if transposed else [["Question", header], ["1", "SECRET"]], "bbox": [0, 0, 1, 1]}]}], page_count=1)
    monkeypatch.setattr(document, "get_model", lambda *_: model)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()])))
    result = asyncio.run(local_graph().ainvoke({"document": reference}))["result"]
    block = next(b for b in result["questions"][0]["contentBlocks"] if b["partType"] == "table")
    assert block["role"] == result["visualElements"][0]["role"] == "answer"
    assert "SECRET" in block["markdownValue"]
    assert result["visualElements"][0]["imageRef"]


@pytest.mark.parametrize("failed", [{1}, {0, 1, 2}])
def test_failed_pages_remain_unassociated_without_source_evidence(monkeypatch, failed):
    tencent_provider(monkeypatch, [ocr_text_page("Page source", figures=[]) for _ in range(5)])
    store, reference = paged_source("pdf")
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_model", lambda *_: FakeModel(responses=[]))
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()] * 5)))

    async def page_call(_model, messages, schema, call_kind, *, runtime=None):
        index = next(i for i in range(5) if f"PRIMARY is page {i + 1}" in messages[-1].content)
        if index in failed:
            return None, [], "OUTPUT_INVALID"
        return schema.model_validate({"questions": [question(f"Page {index}")]}), [], None

    monkeypatch.setattr(document, "structured_call", page_call)
    result = asyncio.run(local_graph().ainvoke({"document": reference}))
    for visual in result["result"]["visualElements"]:
        assert visual["questionIds"] == []
    assert "media" not in result["result"]["questions"][-1]["missingFields"]


def test_material_crop_does_not_include_answer_outside_model_bounds(monkeypatch):
    from PIL import Image, ImageDraw

    from practiq_ai.contracts import ArtifactReference

    page = Image.new("RGB", (1000, 1000), "white")
    # The dark answer region sits outside the model box but within old 4% padding.
    ImageDraw.Draw(page).rectangle((500, 610, 599, 629), fill="black")
    image = BytesIO()
    page.save(image, "PNG")
    store, reference = paged_source("pdf")
    model = ocr_page_model(monkeypatch, [{"questions": [question("Material")], "figures": [
        {"kind": "chart", "role": "material", "description": "Chart", "questionIndexes": [0], "bbox": [0.2, 0.2, 0.6, 0.6]}]}], page_count=1)
    monkeypatch.setattr(document, "get_model", lambda *_: model)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[image.getvalue()])))
    result = asyncio.run(local_graph().ainvoke({"document": reference}))
    visual = result["result"]["visualElements"][0]
    assert visual["bbox"] == [0.2, 0.2, 0.6, 0.6]
    payload = asyncio.run(store.get_verified(ArtifactReference.model_validate(visual["imageRef"])))
    with Image.open(BytesIO(payload)) as crop:
        assert crop.size == (400, 400)
        assert min(crop.convert("L").tobytes()) > 240
    assert asyncio.run(store.get_verified(ArtifactReference.model_validate(visual["sourceRef"]))) == image.getvalue()


@pytest.mark.parametrize("continuations", [{1, 2}, {0}])
def test_unowned_continuation_figures_do_not_guess_a_question(monkeypatch, continuations):
    tencent_provider(monkeypatch, [ocr_text_page("Page source", figures=[{"bbox": [0, 0, 1, 1]}] if index in continuations else []) for index in range(5)])
    store, reference = paged_source("pdf")
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_model", lambda *_: FakeModel(responses=[]))
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()] * 5)))

    async def page_call(_model, messages, schema, call_kind, *, runtime=None):
        index = next(i for i in range(5) if f"PRIMARY is page {i + 1}" in messages[-1].content)
        if index in continuations:
            return schema.model_validate(ocr_draft({"questions": [], "figures": [
                {"kind": "table", "description": "Continuation", "questionIndexes": [0]}]})), [], None
        return schema.model_validate({"questions": [question(f"Page {index} A"), question(f"Page {index} B")]}), [], None

    monkeypatch.setattr(document, "structured_call", page_call)
    result = asyncio.run(local_graph().ainvoke({"document": reference}))
    visuals = result["result"]["visualElements"]
    assert len(visuals) == len(continuations)
    assert all(v["questionIds"] == [] for v in visuals)
    assert all(q["needsReview"] for q in result["result"]["questions"])


@pytest.mark.parametrize("answer_role", ["answer_key", "worked_solution", "参考答案"])
@pytest.mark.parametrize("figure_role", [None, "material"])
def test_existing_answer_block_protects_shared_table_visual_and_all_copies(monkeypatch, answer_role, figure_role):
    from practiq_ai.graphs.vision import PageFigure

    store, reference = paged_source("pdf")
    figure = {"kind": "table", "description": "Values", "role": figure_role,
              "questionIndexes": [0, 1], "tableRows": [["n", "value"], ["1", "42"]], "bbox": [0, 0, 1, 1]}
    markdown = PageFigure(**figure).table_markdown()
    questions = [question("First"), question("Second")]
    # The authoritative answer label is on the later question. The earlier
    # generated copy and duplicate roleless blocks must not bypass exam filtering.
    questions[1]["contentBlocks"] = [
        {"partType": "table", "role": answer_role, "markdownValue": markdown},
        {"partType": "table", "markdownValue": markdown},
    ]
    model = ocr_page_model(monkeypatch, [{"questions": questions, "figures": [figure]}], page_count=1)
    monkeypatch.setattr(document, "get_model", lambda *_: model)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()])))
    result = asyncio.run(local_graph().ainvoke({"document": reference}))["result"]
    assert result["visualElements"][0]["role"] == "answer"
    assert result["visualElements"][0]["extractedText"] == markdown
    blocks = [b for q in result["questions"] for b in q["contentBlocks"] if b["partType"] == "table"]
    assert len(blocks) == 3 and all(b["role"] == "answer" and b["markdownValue"] == markdown for b in blocks)


@pytest.mark.parametrize("text", ["合并表格\n答案：42", "Merged cells\nSolution: 42", "Merged cells\nAnswer: 42", "Correct Answer: 42", "Answer key: 42", "正确答案：42"])
@pytest.mark.parametrize("role", [None, "material"])
def test_unstructured_answer_table_classifies_text_and_matching_block(monkeypatch, text, role):
    store, reference = paged_source("pdf")
    q = question("Read merged table")
    q["contentBlocks"] = [{"partType": "table", "role": "material", "textValue": text}]
    figure = {"kind": "table", "description": "Merged table", "tableRows": None,
              "extractedText": text, "role": role, "questionIndexes": [0], "bbox": [0, 0, 1, 1]}
    model = ocr_page_model(monkeypatch, [{"questions": [q], "figures": [figure]}], page_count=1)
    monkeypatch.setattr(document, "get_model", lambda *_: model)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()])))
    result = asyncio.run(local_graph().ainvoke({"document": reference}))["result"]
    assert result["visualElements"][0]["role"] == "answer"
    assert result["visualElements"][0]["extractedText"] == text
    assert result["questions"][0]["contentBlocks"][0]["role"] == "answer"
    assert result["questions"][0]["contentBlocks"][0]["textValue"] == text


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("answer_in_block", [False, True])
def test_equivalent_answer_tables_propagate_without_order_or_format_dependence(monkeypatch, reverse, answer_in_block):
    store, reference = paged_source("pdf")
    questions = [question("First"), question("Second"), question("Unrelated")]
    compact = "n|value\n:---|---:\n1|SECRET left \\| right"
    if answer_in_block:
        questions[1]["contentBlocks"] = [{"partType": "table", "role": "answer", "markdownValue": compact}]
    questions[2]["contentBlocks"] = [{"partType": "table", "role": "material", "markdownValue": compact}]
    base = {"kind": "table", "description": "Values", "role": "material", "bbox": [0, 0, 1, 1],
            "tableRows": [["n", "value"], ["1", "SECRET left | right"]]}
    figures = [{**base, "questionIndexes": [0]}, {**base, "questionIndexes": [0, 1]},
               {**base, "questionIndexes": [1], "role": "material" if answer_in_block else "answer"}]
    if reverse:
        figures.reverse()
    figures.append({**base, "questionIndexes": [2]})
    model = ocr_page_model(monkeypatch, [{"questions": questions, "figures": figures}], page_count=1)
    monkeypatch.setattr(document, "get_model", lambda *_: model)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()])))
    result = asyncio.run(local_graph().ainvoke({"document": reference}))["result"]
    assert [v["role"] for v in result["visualElements"]] == ["answer", "answer", "answer", "material"]
    for q in result["questions"][:2]:
        tables = [b for b in q["contentBlocks"] if b["partType"] == "table"]
        assert tables and all(b["role"] == "answer" for b in tables)
        assert "SECRET" in q["sourceText"]
    assert all(b["role"] == "material" for b in result["questions"][2]["contentBlocks"])
    if answer_in_block:
        assert result["questions"][1]["contentBlocks"][0]["markdownValue"] == compact


def test_table_comparison_preserves_cells_and_non_table_text():
    from practiq_ai.graphs.vision import table_content_key

    table = "| n | value |\n| --- | --- |\n| 1 | left \\| right |"
    assert table_content_key(table) == table_content_key("n|value\n:---:|---:\n1|left \\| right")
    for different in [table.replace("left ", "left  "), table.replace("1 |", "2 |"), table.replace(r"\|", "|"), table + "\n| 2 | |"]:
        assert table_content_key(table) != table_content_key(different)
    assert table_content_key("Merged\nSECRET") != table_content_key("Merged SECRET")


def test_crop_only_truncation_marks_media_not_questions(monkeypatch):
    store, reference = paged_source("pdf")
    figure = {"kind":"diagram", "description":"Figure", "bbox":[0,0,1,1], "questionIndexes":[0]}
    model = ocr_page_model(monkeypatch, [{"questions":[question("Complete source question")], "figures":[figure,figure]}], page_count=1)
    monkeypatch.setattr(document, "get_model", lambda: model)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document.vision, "MAX_CROPS", 1)
    async def extracted(*args, **kwargs):
        return ExtractedDocument(text="", page_images=[make_image()])
    monkeypatch.setattr(document, "extract", extracted)
    result = asyncio.run(local_graph().ainvoke({"document":reference}))
    assert result["status"] == "PARTIAL" and result["processing"]["truncated"]
    assert len(result["result"]["questions"]) == 1
    assert result["result"]["missingFields"] == ["media"]


async def test_context_enrichment_cannot_add_a_question_with_a_false_primary_anchor(monkeypatch):
    store, reference = paged_source('pdf')
    primary = {**question('PRIMARY question'), 'id': 'page:1:1'}
    enriched = {**primary, 'answerPayload': {'text': 'Printed reference'}}
    copied = {**question('Context-only question'), 'id': 'page:1:context-copy'}
    model = ocr_page_model(monkeypatch, [{'questions': [primary]}, {'questions': [primary, copied]},
                                {'questions': [enriched]}, {'questions': []}], page_count=2)
    monkeypatch.setenv('AI_IMPORT_REVIEW', 'false')
    monkeypatch.setenv('AI_GRAPH_MAX_CONCURRENCY', '1')
    monkeypatch.setattr(document, 'get_object_store', lambda: store)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(
        text='', page_images=[make_image()] * 2)))
    state = await local_graph().ainvoke({'document': reference})
    assert len(model.calls) == len(state['usage']) == 4
    assert len(model.calls[0]) == 2 and not any(isinstance(m.content, list) for m in model.calls[0])
    assert 'CONTEXT ONLY' in model.calls[1][-1].content
    assert 'PRIMARY question IDs' in model.calls[2][-1].content
    assert [q['stem'] for q in state['result']['questions']] == ['PRIMARY question']
    assert state['result']['questions'][0]['answerPayload'] == {'text': 'Printed reference'}
    assert document.PRIMARY_PAGE.get() is None
    assert copied['id'] == 'page:1:context-copy'


async def test_primary_and_context_passes_each_have_all_correction_attempts(monkeypatch):
    store, reference = paged_source('pdf')
    primary = {**question('PRIMARY question'), 'id': 'page:1:1'}
    enriched = {**primary, 'answerPayload': {'text': 'Printed reference'}}
    invalid = [{'questions': [question(f'Invalid context question {i}')]} for i in range(3)]
    model = ocr_page_model(monkeypatch, [*[{'questions': str(i)} for i in range(3)], {'questions': [primary]},
                                *invalid, {'questions': [enriched]}, {'questions': []}], page_count=2)
    monkeypatch.setenv('AI_IMPORT_REVIEW', 'false')
    monkeypatch.setenv('AI_GRAPH_MAX_CONCURRENCY', '1')
    monkeypatch.setattr(document, 'get_object_store', lambda: store)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(
        text='', page_images=[make_image()] * 2)))
    state = await local_graph().ainvoke({'document': reference})
    assert state['status'] == 'SUCCEEDED', state['processing']
    assert len(model.calls) == len(state['usage']) == 9
    assert state['result']['questions'][0]['answerPayload'] == {'text': 'Printed reference'}


@pytest.mark.parametrize('mode', ['reading', 'cloze', 'word_bank'])
async def test_context_correction_retains_primary_composite_material(monkeypatch, mode):
    store, reference = paged_source('pdf')
    options = [{'label': 'A', 'content': 'early'}, {'label': 'B', 'content': 'late'}]
    material = [{'partType': 'text', 'textValue': 'They arrive '},
                {'partType': 'blank', 'questionId': 'page:1:2'},
                {'partType': 'text', 'textValue': ' every day.'}]
    parent = {'id': 'page:1:1', 'answerMode': mode, 'stem': 'Printed exercise',
              'passage': material if mode != 'reading' else material[:1],
              'options': options if mode == 'word_bank' else []}
    child = {'id': 'page:1:2', 'parentId': parent['id'], 'answerMode': 'choice',
             'choiceVariant': 'single', 'stem': 'Choose the supplied word',
             'options': [] if mode == 'word_bank' else options,
             'optionSourceId': parent['id'] if mode == 'word_bank' else None,
             'answerPayload': {'correct': ['A']}}
    model = ocr_page_model(monkeypatch, [{'questions': [parent, child]}, {'questions': [child]},
                                {'questions': [parent, child]}, {'questions': []}], page_count=2)
    monkeypatch.setenv('AI_IMPORT_REVIEW', 'false')
    monkeypatch.setenv('AI_GRAPH_MAX_CONCURRENCY', '1')
    monkeypatch.setattr(document, 'get_object_store', lambda: store)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(
        text='', page_images=[make_image()] * 2)))
    state = await local_graph().ainvoke({'document': reference})
    assert len(model.calls) == len(state['usage']) == 4
    assert 'PRIMARY composite' in model.calls[2][-1].content
    kept = next(q for q in state['result']['questions'] if q['answerMode'] == mode)
    assert kept['passage'][0]['textValue'] == 'They arrive '
    assert kept['options'] == parent['options']
    assert document.PRIMARY_PAGE.get() is None


@pytest.mark.parametrize("loss", ["removed", "changed", "reordered"])
def test_context_must_preserve_ordinary_question_material_before_adding_context(loss):
    from pydantic import ValidationError

    blocks = [{"partType": "text", "role": "material", "textValue": value}
              for value in ("Printed material one", "Printed material two")]
    primary = {**question("Question?"), "id": "page:3:1", "contentBlocks": blocks}
    token = document.PRIMARY_PAGE.set(document.PageParseResult.model_validate({"questions": [primary]}))
    try:
        added = {"partType": "text", "role": "material", "textValue": "Earlier context material"}
        broken = {"removed": blocks[1:], "changed": [added, blocks[1]], "reordered": blocks[::-1]}[loss]
        with pytest.raises(ValidationError, match="PRIMARY question contentBlocks"):
            document.PageParseResult.model_validate({"questions": [{**primary, "contentBlocks": broken}]})
        complete = document.PageParseResult.model_validate({"questions": [{**primary, "contentBlocks": [*blocks, added]}]})
        assert [block.textValue for block in complete.questions[0].contentBlocks] == [block["textValue"] for block in [*blocks, added]]
    finally:
        document.PRIMARY_PAGE.reset(token)


@pytest.mark.parametrize('field', ['passage', 'options', 'contentBlocks', 'transcript'])
@pytest.mark.parametrize('loss', ['removed', 'changed', 'reordered'])
async def test_context_correction_preserves_composite_payload_and_allows_additions(monkeypatch, field, loss):
    store, reference = paged_source('pdf')
    options = [{'label': 'A', 'content': 'early'}, {'label': 'B', 'content': 'late'}]
    blocks = [{'partType': 'text', 'textValue': text} for text in ['Printed first part', 'Printed second part']]
    mode = {'options': 'word_bank', 'transcript': 'listening'}.get(field, 'reading')
    parent = {'id': 'page:1:1', 'answerMode': mode, 'stem': 'Printed exercise',
              field: options if field == 'options' else blocks}
    if mode == 'word_bank':
        parent['passage'] = [blocks[0], {'partType': 'blank', 'questionId': 'page:1:2'}]
    extra = {'label': 'C', 'content': 'later'} if field == 'options' else {'partType': 'text', 'textValue': 'Continuing part'}
    complete = {**parent, field: [*parent[field], extra]}
    broken_items = {'removed': parent[field][1:], 'changed': [extra, parent[field][1]],
                    'reordered': parent[field][::-1]}[loss]
    child = {'id': 'page:1:2', 'parentId': parent['id'], 'answerMode': 'choice',
             'choiceVariant': 'single', 'stem': 'Choose the supplied word',
             'options': [] if mode == 'word_bank' else options,
             'optionSourceId': parent['id'] if mode == 'word_bank' else None,
             'answerPayload': {'correct': ['B']}}
    model = ocr_page_model(monkeypatch, [{'questions': [parent, child]},
                                {'questions': [{**parent, field: broken_items}, child]},
                                {'questions': [complete, child]}, {'questions': []}], page_count=2)
    monkeypatch.setenv('AI_IMPORT_REVIEW', 'false')
    monkeypatch.setenv('AI_GRAPH_MAX_CONCURRENCY', '1')
    monkeypatch.setattr(document, 'get_object_store', lambda: store)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(
        text='', page_images=[make_image()] * 2)))
    state = await local_graph().ainvoke({'document': reference})
    assert state['status'] == 'SUCCEEDED', state['processing']
    assert len(model.calls) == len(state['usage']) == 4
    assert f'PRIMARY composite {field}' in model.calls[2][-1].content
    kept = next(q for q in state['result']['questions'] if q['answerMode'] == mode)
    values = [item['content'] if field == 'options' else item['textValue'] for item in kept[field]]
    assert values == (['early', 'late', 'later'] if field == 'options' else
                      ['Printed first part', 'Printed second part', 'Continuing part'])
    assert document.PRIMARY_PAGE.get() is None


@pytest.mark.parametrize('loss', ['all', 'one', 'title', 'instructions', 'association', 'one-owner',
                                 'unassociated', 'duplicate-unassociated'])
async def test_context_correction_preserves_primary_groups_and_reordered_members(monkeypatch, loss):
    from copy import deepcopy

    store, reference = paged_source('pdf')
    questions = [{**question('First question'), 'id': 'page:1:1'},
                 {**question('Second question'), 'id': 'page:1:2'}]
    groups = [{'title': 'Printed section', 'instructions': 'Use the printed material.', 'questionIndexes': [0, 1]},
              {'title': 'First-question section', 'questionIndexes': [0]},
              {'title': 'Primary instructions', 'instructions': 'Read carefully.', 'questionIndexes': []}]
    corrected = [{**groups[1], 'instructions': 'Additional context.', 'questionIndexes': [1]},
                 {**groups[0], 'questionIndexes': [1, 0]},
                 groups[2],
                 {'title': 'Context section', 'questionIndexes': [0]}]
    broken = deepcopy(corrected)
    if loss == 'all':
        broken = []
    elif loss == 'one':
        broken.pop(1)
    elif loss in {'title', 'instructions'}:
        broken[1][loss] = 'Different source content'
    elif loss == 'association':
        broken[0]['questionIndexes'] = [0]
    elif loss == 'unassociated':
        broken.append({'title': 'Neighbor-only section', 'questionIndexes': []})
    elif loss == 'duplicate-unassociated':
        broken.append(deepcopy(groups[2]))
    else:
        broken[1]['questionIndexes'] = [1]
    model = ocr_page_model(monkeypatch, [{'questions': questions, 'groups': groups},
                                {'questions': questions[::-1], 'groups': broken},
                                {'questions': questions[::-1], 'groups': corrected}, {'questions': []}], page_count=2)
    monkeypatch.setenv('AI_IMPORT_REVIEW', 'false')
    monkeypatch.setenv('AI_GRAPH_MAX_CONCURRENCY', '1')
    monkeypatch.setattr(document, 'get_object_store', lambda: store)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(
        text='', page_images=[make_image()] * 2)))
    state = await local_graph().ainvoke({'document': reference})
    assert state['status'] == 'SUCCEEDED', state['processing']
    assert len(model.calls) == len(state['usage']) == 4
    assert 'PRIMARY group' in model.calls[2][-1].content
    kept = {group['title']: group for group in state['result']['groups']}
    by_id = {q['id']: q['stem'] for q in state['result']['questions']}
    assert kept['Printed section']['instructions'] == groups[0]['instructions']
    assert {by_id[qid] for qid in kept['Printed section']['questionIds']} == {'First question', 'Second question'}
    assert [by_id[qid] for qid in kept['First-question section']['questionIds']] == ['First question']
    assert kept['First-question section']['instructions'] == 'Additional context.'
    assert kept['Primary instructions']['questionIds'] == []
    assert len(state['result']['groups']) == len(corrected)
    assert 'Context section' in kept
    assert document.PRIMARY_PAGE.get() is None


@pytest.mark.parametrize('loss', ['all', 'one', 'association'])
async def test_context_correction_preserves_primary_figures_and_reordered_owners(monkeypatch, loss):
    store, reference = paged_source('pdf')
    questions = [{**question('First question'), 'id': 'page:1:1'},
                 {**question('Second question'), 'id': 'page:1:2'}]
    figures = [{'kind': 'diagram', 'description': 'First diagram', 'questionIndexes': [0],
                'bbox': [0.1, 0.1, 0.4, 0.4]},
               {'kind': 'diagram', 'description': 'Second diagram', 'questionIndexes': [1],
                'bbox': [0.5, 0.5, 0.9, 0.9]}]
    corrected = [{**figures[0], 'questionIndexes': [1]}, {**figures[1], 'questionIndexes': [0]}]
    broken = {'all': [], 'one': corrected[:1],
              'association': [{**corrected[0], 'questionIndexes': []}, corrected[1]]}[loss]
    model = ocr_page_model(monkeypatch, [{'questions': questions, 'figures': figures},
                                {'questions': questions[::-1], 'figures': broken},
                                {'questions': questions[::-1], 'figures': corrected}, {'questions': []}], page_count=2)
    monkeypatch.setenv('AI_IMPORT_REVIEW', 'false')
    monkeypatch.setenv('AI_GRAPH_MAX_CONCURRENCY', '1')
    monkeypatch.setattr(document, 'get_object_store', lambda: store)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(
        text='', page_images=[make_image()] * 2)))
    state = await local_graph().ainvoke({'document': reference})
    assert len(model.calls) == len(state['usage']) == 4
    assert ('PRIMARY figure' in model.calls[2][-1].content or 'Retain every supplied OCR figure exactly once' in model.calls[2][-1].content)
    visuals = state['result']['visualElements']
    assert len(visuals) == 2 and all(visual['imageRef'] for visual in visuals)
    by_id = {q['id']: q['stem'] for q in state['result']['questions']}
    assert [[by_id[qid] for qid in visual['questionIds']] for visual in visuals] == [
        ['First question'], ['Second question']]


@pytest.mark.parametrize('loss', ['rows-missing', 'cell-changed', 'row-removed', 'text-missing', 'text-changed', 'role', 'label'])
async def test_context_correction_preserves_primary_figure_payload_and_allows_more_rows(monkeypatch, loss):
    from copy import deepcopy

    store, reference = paged_source('pdf')
    primary = {**question('Read the printed table'), 'id': 'page:1:1'}
    figure = {'kind': 'table', 'description': 'Printed values', 'role': 'answer', 'label': 'Table 1',
              'questionIndexes': [0], 'bbox': [0.1, 0.1, 0.9, 0.9], 'extractedText': 'Printed table note',
              'tableRows': [['Metric', 'Value'], ['A', '10'], ['B', '20']]}
    complete = {**figure, 'tableRows': [*figure['tableRows'], ['C', '30']],
                'extractedText': figure['extractedText'] + '; continuing note'}
    broken = deepcopy(complete)
    if loss == 'rows-missing':
        broken['tableRows'] = None
    elif loss == 'cell-changed':
        broken['tableRows'][1][1] = '99'
    elif loss == 'row-removed':
        broken['tableRows'].pop(1)
    elif loss.startswith('text'):
        broken['extractedText'] = None if loss == 'text-missing' else 'Different text'
    elif loss == 'role':
        broken['role'] = 'material'
    else:
        broken['label'] = None
    model = ocr_page_model(monkeypatch, [{'questions': [primary], 'figures': [figure]},
                                {'questions': [primary], 'figures': [broken]},
                                {'questions': [primary], 'figures': [complete]}, {'questions': []}], page_count=2)
    monkeypatch.setenv('AI_IMPORT_REVIEW', 'false')
    monkeypatch.setenv('AI_GRAPH_MAX_CONCURRENCY', '1')
    monkeypatch.setattr(document, 'get_object_store', lambda: store)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(
        text='', page_images=[make_image()] * 2)))
    state = await local_graph().ainvoke({'document': reference})
    assert len(model.calls) == len(state['usage']) == 4
    assert 'PRIMARY figure payload' in model.calls[2][-1].content
    visual = state['result']['visualElements'][0]
    assert visual['role'] == 'answer' and visual['label'] == 'Table 1'
    assert all(value in visual['extractedText'] for value in ['10', '20', '30'])


async def test_empty_primary_page_does_not_submit_neighbors_for_question_extraction(monkeypatch):
    store, reference = paged_source('pdf')
    owned = {**question('Starts on page two'), 'id': 'page:2:1'}
    model = ocr_page_model(monkeypatch, [{'questions': []}, {'questions': [owned]}, {'questions': [owned]}], page_count=2)
    monkeypatch.setenv('AI_IMPORT_REVIEW', 'false')
    monkeypatch.setenv('AI_GRAPH_MAX_CONCURRENCY', '1')
    monkeypatch.setattr(document, 'get_object_store', lambda: store)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(
        text='', page_images=[make_image()] * 2)))
    state = await local_graph().ainvoke({'document': reference})
    assert len(model.calls) == len(state['usage']) == 3
    assert ['CONTEXT:\n' in call[-1].content for call in model.calls] == [False, False, True]
    assert [q['stem'] for q in state['result']['questions']] == ['Starts on page two']


def test_context_identity_guard_allows_composite_fragments_and_resets_for_history():
    from pydantic import ValidationError

    parent = {'id': 'page:1:reading', 'answerMode': 'reading', 'stem': 'Continued reading',
              'passage': [{'partType': 'text', 'textValue': 'Printed continuation'}]}
    token = document.PRIMARY_PAGE.set(document.PageParseResult())
    try:
        assert document.PageParseResult.model_validate({'questions': [parent]}).questions[0].id == parent['id']
        with pytest.raises(ValidationError, match='PRIMARY question IDs'):
            document.PageParseResult.model_validate({'questions': [question('Context question')]})
    finally:
        document.PRIMARY_PAGE.reset(token)
    assert document.PageParseResult.model_validate({'questions': [question('Historical record')]}).questions


async def test_context_failure_retains_known_primary_usage_and_clears_identity_guard(monkeypatch):
    store, reference = paged_source('pdf')
    primary = {**question('Visible PRIMARY question'), 'id': 'page:1:1'}
    model = ocr_page_model(monkeypatch, [{'questions': [primary]}], page_count=2)
    original = document.structured_call

    async def fail_context(model, messages, schema, call_kind, *, runtime=None):
        if 'CONTEXT:\n' in messages[-1].content:
            raise DocumentProcessingError(503, 'Context storage unavailable', 'EXECUTION_STORE_UNAVAILABLE')
        return await original(model, messages, schema, call_kind, runtime=runtime)

    monkeypatch.setenv('AI_IMPORT_REVIEW', 'false')
    monkeypatch.setenv('AI_GRAPH_MAX_CONCURRENCY', '1')
    monkeypatch.setattr(document, 'structured_call', fail_context)
    monkeypatch.setattr(document, 'get_object_store', lambda: store)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(
        text='', page_images=[make_image()] * 2)))
    with pytest.raises(DocumentProcessingError) as caught:
        await local_graph().ainvoke({'document': reference})
    assert caught.value.code == 'EXECUTION_STORE_UNAVAILABLE'
    assert len(model.calls) == len(caught.value.usage) == 1
    assert (caught.value.usage[0].inputTokens, caught.value.usage[0].outputTokens) == (10, 5)
    assert document.PRIMARY_PAGE.get() is None
