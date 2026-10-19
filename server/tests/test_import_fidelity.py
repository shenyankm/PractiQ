"""Regressions from the mixed-format import acceptance, without provider calls."""
from unittest.mock import AsyncMock

import pytest

from practiq_ai.contracts import document_source_key
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document
from tests.support import (
    FakeModel,
    MemoryStore,
    local_graph,
    make_image,
    ocr_text_page,
    question,
    source,
    tencent_provider,
)


def image_source():
    files, reference = source("synthetic page")
    key = document_source_key("image", reference["sha256"])
    files.blobs[key] = files.blobs.pop(reference["objectKey"])
    reference.update(sourceType="image", mediaType="image/png", objectKey=key)
    return files, reference


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


@pytest.mark.parametrize("attempt_override", [True, False])
async def test_ocr_bounds_remain_authoritative_without_downgrading_answers(monkeypatch, attempt_override):
    store, reference = image_source()
    table = "| Sample | Value |\n| --- | --- |\n| C | $\\sqrt{2}$ |"
    q = question("Read the measurements")
    q["contentBlocks"] = [{"partType": "table", "role": "answer", "markdownValue": table}]
    response = {"questions": [q], "figures": [{"elementIndex": 0, "kind": "table", "description": "Measurements", "role": "answer",
                "questionIndexes": [0], "tableRows": [["Sample", "Value"], ["C", r"$\sqrt{2}$"]]}]}
    invalid = {**response, "figures": [{**response["figures"][0], "bbox": [0.2, 0.3, 0.8, 0.5]}]}
    model = FakeModel(responses=[invalid, response] if attempt_override else [response])
    monkeypatch.setattr(document, "get_model", lambda: model)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()])))
    tencent_provider(monkeypatch, [ocr_text_page("Read the measurements", figures=[{"bbox": [0.2, 0.2, 0.8, 0.7]}])])
    state = await local_graph().ainvoke({"document": reference})
    visual = state["result"]["visualElements"][0]
    assert len(model.calls) == len(state["usage"]) == (2 if attempt_override else 1)
    assert visual["sourceRef"] and visual["imageRef"]
    assert visual["role"] == "answer" and visual["bbox"] == [0.2, 0.2, 0.8, 0.7]
    assert state["result"]["questions"][0]["contentBlocks"][0]["role"] == "answer"
    assert state["result"]["questions"][0]["needsReview"]



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
    ("Write 80–120 words in English.", None),
    ("Write an invitation in Chinese.", None),
    ("Write a reply.", None),
    ("Write the answer in English or Chinese", None),
    ('Discuss the phrase "write in English".', None),
    ("Write a reply in French.", None),
])
def test_writing_language_is_never_invented_from_source_prose(instruction, expected):
    row = {"stem": instruction, "questionKind": "writing", "answerMode": "short_answer", "answerPayload": None}
    q = document.ChunkParseResult.model_validate({"questions": [row]}).questions[0]
    assert q.targetLanguage == expected
    assert q.answerPayload is None
    assert q.minWords is None and q.maxWords is None
    row["targetLanguage"] = "en-GB"
    assert document.ChunkParseResult.model_validate({"questions": [row]}).questions[0].targetLanguage == "en-GB"


def test_score_evidence_does_not_override_unspecified_writing_language():
    row = {"stem": "Write an invitation to a reading club.", "questionKind": "writing", "answerMode": "short_answer", "answerPayload": None, "sourceText": None, "scoreSourceText": "Write 80–120 words in English. (15 points)"}
    question = document.ChunkParseResult.model_validate({"questions": [row]}).questions[0]
    assert question.targetLanguage is None
    assert question.answerPayload is None and question.sourceText is None


@pytest.mark.parametrize("field", ["questions", "groups", "figures"])
def test_model_stringified_arrays_are_rejected(field):
    with pytest.raises(ValueError):
        document.PageParseResult.model_validate({"questions": [], field: "[]"})
    with pytest.raises(ValueError):
        document.PageParseResult.model_validate({"questions": [], field: '[{"truncated'})


@pytest.mark.parametrize("code", ["AI_PROVIDER_UNAVAILABLE", "AI_PROVIDER_AUTH_ERROR"])
async def test_structuring_failure_preserves_completed_tencent_job_for_retry(monkeypatch, code):
    from practiq_ai.execution import namespace

    files, reference = image_source()
    async def call(model, messages, schema, kind, **kwargs):
        assert schema is document.OcrPageParseResult and kind == "vision_parse"
        return None, [], code

    monkeypatch.setattr(document, "structured_call", call)
    monkeypatch.setattr(document, "get_model", lambda: object())
    monkeypatch.setattr(document, "get_object_store", lambda: files)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()])))
    calls = tencent_provider(monkeypatch, [ocr_text_page("page")])
    receipts = MemoryStore()
    state = await local_graph(store=receipts).ainvoke({"document": reference})
    failure = state["processing"]["failures"][0]
    assert failure["code"] == code and failure["retryable"]
    assert failure["retriesRemaining"] == 2 and state["usage"] == []
    saved = await receipts.asearch(namespace("thread-1", "tencent_jobs"))
    assert len(saved) == 1 and saved[0].value["status"] == "Success" and saved[0].value["resultRef"]
    assert len(calls) == 2 and state["status"] == "PARTIAL"


async def test_shared_structuring_budget_preserves_known_usage_before_provider_failure(monkeypatch):
    import httpx2
    from openai import APITimeoutError

    from practiq_ai import llm

    files, reference = image_source()
    error = APITimeoutError(request=httpx2.Request("POST", "https://example.invalid"))
    model = FakeModel(responses=[{"invalid": True}, error, error, error, error])
    monkeypatch.setattr(llm, "_retry_delay", lambda attempt: 0)
    monkeypatch.setattr(document, "get_model", lambda: model)
    monkeypatch.setattr(document, "get_object_store", lambda: files)
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image()])))
    tencent_provider(monkeypatch, [ocr_text_page("page")])
    state = await local_graph().ainvoke({"document": reference})
    failure = state["processing"]["failures"][0]
    assert len(model.calls) > 1
    assert failure["code"] == "AI_PROVIDER_UNAVAILABLE" and failure["retryable"]
    assert len(state["usage"]) == 1


@pytest.mark.parametrize("field", ["instructions", "options", "items", "passage", "answerPayload", "scoringRubric"])
def test_preserved_formulas_in_rendered_fields_are_not_missing(field):
    formula = r"\int_0^1 x^2\,dx"
    row = {"stem": "Use the supplied expression", "sourceText": f"Given ${formula}$", "answerMode": "short_answer", "answerPayload": None}
    if field == "options":
        row.update(answerMode="choice", options=[{"label":"A", "content":formula}])
    elif field == "items":
        row.update(answerMode="ordering", items=[{"id":0, "content":formula}])
    elif field == "passage":
        row.update(answerMode="reading", passage=[{"partType":"formula", "latexValue":formula}])
    elif field == "answerPayload":
        row[field] = {"text": formula}
    else:
        row[field] = formula
    result = document.ChunkParseResult.model_validate({"questions":[row]})
    assert "material" not in result.questions[0].missingFields
