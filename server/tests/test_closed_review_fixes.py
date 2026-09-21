"""Regression checks for outstanding closed-PR review feedback; no model calls."""
import base64
import hashlib
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import HumanMessage
from PIL import Image
from pydantic import ValidationError

from practiq_ai import llm
from practiq_ai.contracts import ParsedQuestion
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors.pdf import render_pages
from practiq_ai.grading import GradeImage
from practiq_ai.graphs.vision import PageFigure, table_content_key
from tests.support import FakeModel


def test_fill_blank_infers_count_and_rejects_mismatch():
    data = {"stem": "Two blanks", "answerMode": "fill_blank", "answerPayload": {"answers": ["a", "b"]}}
    assert ParsedQuestion.model_validate(data).blankCount == 2
    with pytest.raises(ValidationError, match="blankCount must match"):
        ParsedQuestion.model_validate({**data, "blankCount": 1})
    assert ParsedQuestion.model_validate({**data, "answerPayload": None}).blankCount is None


def test_table_labels_and_literal_cells_preserve_material():
    base = {"kind": "table", "role": "material", "description": "Values", "bbox": [0, 0, 1, 1]}
    figure = PageFigure(**base, tableRows=[["Solution concentration", "Data analysis method"], ["[A](B)", '<tag> ![x](y) &amp; $x^2$']])
    assert figure.role == "material"
    markdown = figure.table_markdown()
    assert markdown and "[A](B)" not in markdown and "<tag>" not in markdown and "$x^2$" in markdown
    assert "&#38;amp;" in markdown
    assert PageFigure(**base, tableRows=[["Answer", "value"], ["a", "b"]]).role == "answer"
    assert PageFigure(**base, extractedText="答案：B").role == "answer"
    assert table_content_key("| x |\n| --- |\n| &lt;tag&gt; |") == table_content_key("x\n---\n<tag>")


def test_pdf_page_cannot_publish_an_oversized_asset(monkeypatch):
    def oversized(_image, buffer, **_kwargs):
        buffer.write(b"x" * (25 * 1024 * 1024 + 1))
    monkeypatch.setattr(Image.Image, "save", oversized)
    source = Path(__file__).parents[1] / "evals/fixtures/pdf/text-layer.pdf"
    with pytest.raises(DocumentProcessingError, match="25 MiB"):
        render_pages(source.read_bytes(), [0])


def test_corrupt_grading_image_is_a_validation_error():
    raw = b"not an image"
    image = GradeImage(sha256=hashlib.sha256(raw).hexdigest(), data="data:image/png;base64," + base64.b64encode(raw).decode())
    with pytest.raises(ValueError, match="Invalid image data"):
        image.verified_url()


@pytest.mark.parametrize("reservation_failure", [False, True])
async def test_rejected_model_records_are_terminal(monkeypatch, reservation_failure):
    monkeypatch.setenv("AI_MODEL_MAX_INPUT_CHARS", "100")
    model = FakeModel(responses=[])
    records = []
    if reservation_failure:
        monkeypatch.setattr(llm, "reserve_model_call", AsyncMock(side_effect=DocumentProcessingError(429, "budget", code="MODEL_BUDGET_EXCEEDED")))
        with pytest.raises(DocumentProcessingError):
            await llm.structured_call(model, [HumanMessage(content="x")], ParsedQuestion, "grading", call_records=records)
    else:
        _, _, code = await llm.structured_call(model, [HumanMessage(content="x" * 101)], ParsedQuestion, "grading", call_records=records)
        assert code == "MODEL_INPUT_TOO_LARGE"
    assert not model.calls
    assert len(records) == 1
    assert records[0]["status"] in {"rejected", "failed"}
    assert records[0]["error"] and records[0]["finishedAt"] and records[0]["durationMs"] >= 0
