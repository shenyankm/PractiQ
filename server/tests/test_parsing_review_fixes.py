"""Model-output review and cross-unit recovery regressions."""

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from langgraph.types import Command

from practiq_ai import task_api
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
    ParsedQuestion,
)
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document
from tests.db_support import setup_api
from tests.support import make_image, run_config, setup_graph


def complete_question(stem, source_id, confidence=0.8):
    return {
        "id": source_id, "stem": stem, "sourceText": stem,
        "answerMode": "short_answer", "questionTypeId": "short_answer",
        "answerPayload": {"text": "Printed answer"}, "analysis": "Printed explanation",
        "confidence": confidence, "needsReview": False,
    }


async def test_duplicate_ids_are_corrected_within_the_model_boundary(monkeypatch):
    first = complete_question("First", "same")
    second = complete_question("Second", "same")
    graph, _, _, reference, model = setup_graph(monkeypatch, [
        {"questions": [first, second]},
        {"questions": [first, {**second, "id": "second"}]},
    ], parts=["First\nSecond"])
    output = await graph.ainvoke({"document": reference}, run_config())
    assert output["status"] == "SUCCEEDED"
    assert [q["stem"] for q in output["result"]["questions"]] == ["First", "Second"]
    assert len(model.calls) == len(output["usage"]) == 2


@pytest.mark.usefixtures("disposable_databases")
@pytest.mark.parametrize("pages", [False, True])
@pytest.mark.parametrize("policy", ["review", "return_partial"])
async def test_cross_unit_duplicate_ids_preserve_successes_and_allow_explicit_retry(monkeypatch, pages, policy):
    first = complete_question("First", "same")
    second = complete_question("Second", "same")
    second_calls = 0

    def respond(messages, _schema):
        nonlocal second_calls
        if "PRIMARY page 1" in messages[-1].content or messages[-1].content.endswith("First"):
            return {"questions": [first]}
        second_calls += 1
        return {"questions": [{**second, "id": "same" if second_calls == 1 else "second"}]}

    api, reference, model = await setup_api(monkeypatch, [respond] * 3, parts=["First", "Second"])
    if pages:
        monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(
            text="", page_images=[make_image(), make_image()],
        )))
    created = await task_api.create_task(DocumentTaskCreate(
        requestId=uuid4(), document=DocumentReference.model_validate(reference), failurePolicy=policy,
    ))
    thread = created["threadId"]
    await api.wait_idle()
    state = await task_api.get_task(thread)
    assert "retry_failed" in state["allowedActions"]
    assert [(f["stage"], f["index"], f["code"]) for f in state["failures"]] == [
        ("vision_parse" if pages else "document_parse", 1, "OUTPUT_INVALID"),
    ]
    assert len(model.calls) == 2  # A merge conflict never silently starts another paid call.
    if policy == "review":
        assert state["state"] == "WAITING_REVIEW" and "accept_partial" in state["allowedActions"]
        await task_api.control_task(thread, DocumentTaskControl(
            requestId=uuid4(), action="accept_partial", checkpointId=state["checkpointId"],
        ))
        await api.wait_idle()
        state = await task_api.get_task(thread)
    assert state["status"] == "PARTIAL"
    assert [q["stem"] for q in state["result"]["questions"]] == ["First"]
    assert len(model.calls) == 2
    await task_api.control_task(thread, DocumentTaskControl(
        requestId=uuid4(), action="retry_failed", checkpointId=state["checkpointId"],
    ))
    await api.wait_idle()
    state = await task_api.get_task(thread)
    assert state["status"] == "SUCCEEDED" and state["failures"] == []
    assert [q["stem"] for q in state["result"]["questions"]] == ["First", "Second"]
    assert len(model.calls) == len(state["usage"]) == 3


async def test_failed_word_bank_parent_can_be_accepted_without_inventing_options(monkeypatch):
    graph, _, _, reference, _ = setup_graph(monkeypatch, [])
    monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(
        text="", page_images=[make_image(), make_image()],
    )))
    source_text = "1. ___ Answer: A"

    async def page_call(_model, messages, schema, call_kind, *, runtime=None):
        if "PRIMARY page 1" in messages[-1].content:
            return None, [], "OUTPUT_INVALID"
        return schema.model_validate({"questions": [{
            "id": "page:2:1", "parentId": "page:1:bank", "optionSourceId": "page:1:bank",
            "stem": "1. ___", "sourceText": source_text, "answerMode": "choice",
            "choiceVariant": "single", "questionTypeId": "choice", "answerPayload": {"correct": ["A"]},
        }]}), [], None

    monkeypatch.setattr(document, "structured_call", page_call)
    config = run_config()
    waiting = await graph.ainvoke({"document": reference, "failurePolicy": "review"}, config)
    assert waiting["__interrupt__"][0].value["canAccept"]
    output = await graph.ainvoke(Command(resume={"action": "accept_partial"}), config)
    assert output["status"] == "PARTIAL"
    question = output["result"]["questions"][0]
    assert question["parentId"] is None and question["optionSourceId"] is None
    assert question["options"] == [] and question["answerPayload"] == {"correct": ["A"]}
    assert question["sourceText"] == source_text and question["needsReview"]
    assert {"material", "options"} <= set(question["missingFields"])
    assert output["processing"]["quality"]["reviewRequired"]


@pytest.mark.parametrize("confidence,review", [(0, True), (0.49, True), (0.5, False), (1, False)])
async def test_low_confidence_model_output_requires_review_without_changing_evidence(monkeypatch, confidence, review):
    original = complete_question("Printed source", "source", confidence)
    assert not ParsedQuestion.model_validate(original).needsReview  # Historical/imported flags stay intact.
    graph, _, _, reference, _ = setup_graph(monkeypatch, [{"questions": [original]}], parts=[original["sourceText"]])
    output = await graph.ainvoke({"document": reference}, run_config())
    question = output["result"]["questions"][0]
    assert question["needsReview"] is review
    assert output["processing"]["quality"]["reviewRequired"] is review
    for field in ("confidence", "sourceText", "answerPayload", "analysis"):
        assert question[field] == original[field]
