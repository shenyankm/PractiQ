"""Regressions from the mixed-format import acceptance, without provider calls."""
from unittest.mock import AsyncMock

import pytest

from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document, vision
from tests.support import FakeModel, local_graph, make_image, question, source


def test_dropped_matrix_is_exportable_and_flagged_without_inventing_math():
    matrix = r"A=\begin{pmatrix}1&2\\3&4\end{pmatrix}"
    row = {"stem": "Find the determinant", "answerMode": "short_answer", "sourceText": f"Given ${matrix}$", "answerPayload": {"text": "-2"}}
    incomplete = document.ChunkParseResult.model_validate({"questions": [row]}).questions[0]
    assert incomplete.needsReview and "material" in incomplete.missingFields
    assert incomplete.model_dump()["answerPayload"] == {"text": "-2"}
    row["contentBlocks"] = [{"partType": "formula", "latexValue": matrix}]
    assert document.ChunkParseResult.model_validate({"questions": [row]}).questions[0].contentBlocks[0].latexValue == matrix
    row["sourceText"] = "No printed formula."
    row["contentBlocks"] = []
    assert not document.ChunkParseResult.model_validate({"questions": [row]}).questions[0].contentBlocks


@pytest.mark.parametrize("complete", [True, False])
async def test_figure_reviewer_corrects_crop_and_material_role_or_preserves_source(monkeypatch, complete):
    store, reference = source("synthetic page")
    table = "| Sample | Value |\n| --- | --- |\n| C | $\\sqrt{2}$ |"
    q = question("Read the measurements")
    q["contentBlocks"] = [{"partType": "table", "role": "answer", "markdownValue": table}]
    response = {"questions": [q], "figures": [{"kind": "table", "description": "Measurements", "role": "answer",
                "questionIndexes": [0], "bbox": [0.2, 0.3, 0.8, 0.5], "tableRows": [["Sample", "Value"], ["C", r"$\sqrt{2}$"]]}]}
    check = {"figures": [{"index": 0, "complete": complete, "role": "material", "roleEvidence": "Sample Value C √2", "bbox": [0.2, 0.2, 0.8, 0.7]}]}
    model = FakeModel(responses=[response, check])
    monkeypatch.setattr(document, "get_model", lambda: model)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()])))
    state = await local_graph().ainvoke({"document": reference})
    visual = state["result"]["visualElements"][0]
    assert len(model.calls) == 2
    assert len(state["usage"]) == 2
    assert visual["sourceRef"]
    if complete:
        assert visual["role"] == "material" and visual["bbox"] == check["figures"][0]["bbox"]
        assert visual["imageRef"]
        assert state["result"]["questions"][0]["contentBlocks"][0]["role"] == "material"
    else:
        assert state["status"] == "PARTIAL"
        assert state["processing"]["failures"][0]["code"] == "CROP_UNVERIFIED"
        assert visual["role"] == "material" and visual["imageRef"] is None and visual["bbox"] is None
        assert state["result"]["questions"][0]["needsReview"]
        assert "media" in state["result"]["questions"][0]["missingFields"]


@pytest.mark.parametrize("code", ["AI_PROVIDER_ERROR", "EXECUTION_STORE_UNAVAILABLE"])
async def test_reviewer_failure_does_not_publish_an_unverified_crop(monkeypatch, code):
    async def fail(*args, **kwargs):
        raise DocumentProcessingError(503, "failed", code)
    monkeypatch.setattr(document, "structured_call", fail)
    figure = vision.PageFigure(description="Chart", bbox=[0, 0, 1, 1])
    if code == "EXECUTION_STORE_UNAVAILABLE":
        with pytest.raises(DocumentProcessingError):
            await document._verify_figures(None, make_image(), [figure], None)
    else:
        assert await document._verify_figures(None, make_image(), [figure], None) == (None, [])


def test_figure_review_rejects_duplicate_and_invalid_boxes():
    row = {"index": 0, "complete": True, "role": "material", "bbox": [0, 0, 1, 1]}
    with pytest.raises(ValueError, match="distinct"):
        vision.FigureChecks.model_validate({"figures": [row, row]})
    with pytest.raises(ValueError, match="positive area"):
        vision.FigureChecks.model_validate({"figures": [{**row, "bbox": [0, 0, 0, 1]}]})


def test_model_review_labels_are_derived_without_weakening_public_contract():
    from practiq_ai.contracts import ParsedQuestion

    row = {"stem": "A supplied answer", "answerMode": "short_answer", "answerPayload": {"text": "Given"}, "missingFields": ["sourceScore", "analysis"]}
    with pytest.raises(ValueError):
        ParsedQuestion.model_validate(row)
    result = document.ChunkParseResult.model_validate({"questions": [row]}).questions[0]
    assert result.model_dump()["answerPayload"] == {"text": "Given"}
    assert result.needsReview
    assert "analysis" in result.missingFields
    assert "sourceScore" not in result.missingFields


def test_model_only_discards_inapplicable_derived_metadata_not_source_content():
    from practiq_ai.contracts import ParsedQuestion

    row = {"stem": "What is evaporation?", "answerMode": "short_answer", "answerPayload": {"text": "Supplied definition"}, "blankCount": 1, "choiceVariant": "single", "options": []}
    with pytest.raises(ValueError):
        ParsedQuestion.model_validate(row)
    q = document.ChunkParseResult.model_validate({"questions": [row]}).questions[0]
    assert q.blankCount is None and q.choiceVariant is None and q.needsReview
    assert q.model_dump()["answerPayload"] == row["answerPayload"]
    with pytest.raises(ValueError, match="options are only"):
        document.ChunkParseResult.model_validate({"questions": [{**row, "options": [{"label": "A", "content": "Source option"}]}]})


@pytest.mark.parametrize("instruction,expected", [
    ("Write 80–120 words in English.", "en"),
    ("Write an invitation in Chinese.", "zh"),
    ("Write a reply.", None),
    ("Write a reply in French.", None),
])
def test_explicit_writing_language_survives_model_omission(instruction, expected):
    row = {"stem": instruction, "questionKind": "writing", "answerMode": "short_answer", "answerPayload": None}
    q = document.ChunkParseResult.model_validate({"questions": [row]}).questions[0]
    assert q.targetLanguage == expected
    assert q.answerPayload is None
    assert q.minWords is None and q.maxWords is None
    row["targetLanguage"] = "en-GB"
    assert document.ChunkParseResult.model_validate({"questions": [row]}).questions[0].targetLanguage == "en-GB"


def test_writing_language_preserves_direction_recorded_with_score_evidence():
    row = {"stem": "Write an invitation to a reading club.", "questionKind": "writing", "answerMode": "short_answer", "answerPayload": None, "sourceText": None, "scoreSourceText": "Write 80–120 words in English. (15 points)"}
    question = document.ChunkParseResult.model_validate({"questions": [row]}).questions[0]
    assert question.targetLanguage == "en"
    assert question.answerPayload is None and question.sourceText is None


def test_model_encoded_arrays_are_unwrapped_then_strictly_validated():
    import json
    row = {"stem": None, "answerMode": "short_answer", "answerPayload": {"text": "Only the supplied answer"}, "sourceText": "Answer: Only the supplied answer"}
    result = document.PageParseResult.model_validate({"questions": json.dumps([row]), "groups": "[]", "figures": "[]"})
    assert result.questions[0].stem is None
    assert "stem" in result.questions[0].missingFields
    assert result.questions[0].answerPayload is not None
    with pytest.raises(ValueError):
        document.PageParseResult.model_validate({"questions": '[{"answerMode":"invented"}]'})
    with pytest.raises(ValueError):
        document.PageParseResult.model_validate({"questions": '[{"stem":"truncated'})
