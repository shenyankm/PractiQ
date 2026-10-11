"""Model-output review and cross-unit recovery regressions."""

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from langgraph.types import Command

from practiq_ai import task_api
from practiq_ai.contracts import (
    DocumentParseResult,
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
    FailedUnit,
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
async def test_shared_option_answer_conflict_retries_only_its_source_unit(monkeypatch, pages):
    parent = {**complete_question("Word bank", "bank"), "answerMode": "word_bank", "questionTypeId": "word_bank",
              "answerPayload": None, "options": [{"label": "A", "content": "First"}, {"label": "B", "content": "Second"}],
              "passage": [{"partType": "text", "textValue": "Choose "}, {"partType": "blank", "questionId": "child"}]}
    child = {**complete_question("Choose", "child"), "answerMode": "choice", "questionTypeId": "choice",
             "choiceVariant": "single", "parentId": "bank", "optionSourceId": "bank", "answerPayload": {"correct": ["C"]}}
    document.ChunkParseResult.model_validate({"questions": [child]})
    calls = 0

    def respond(messages, _schema):
        nonlocal calls
        if "PRIMARY page 1" in messages[-1].content or messages[-1].content.endswith("Word bank"):
            return {"questions": [parent]}
        calls += 1
        return {"questions": [{**child, "answerPayload": {"correct": ["C" if calls == 1 else "B"]}}]}

    api, reference, model = await setup_api(monkeypatch, [respond] * 3, parts=["Word bank", "Choose"])
    if pages:
        monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[make_image(), make_image()])))
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), failurePolicy="review"))
    thread = created["threadId"]
    await api.wait_idle()
    state = await task_api.get_task(thread)
    assert state["state"] == "WAITING_REVIEW"
    assert "retry_failed" in state["allowedActions"] and "resume" not in state["allowedActions"]
    assert [(item["stage"], item["index"], item["code"]) for item in state["failures"]] == [("vision_parse" if pages else "document_parse", 1, "OUTPUT_INVALID")]
    assert len(model.calls) == len(state["usage"]) == 2
    await task_api.control_task(thread, DocumentTaskControl(requestId=uuid4(), action="retry_failed", checkpointId=state["checkpointId"], units=[FailedUnit(stage="vision_parse" if pages else "document_parse", index=1)]))
    await api.wait_idle()
    state = await task_api.get_task(thread)
    assert state["status"] == "SUCCEEDED" and state["failures"] == []
    assert state["result"]["questions"][1]["answerPayload"] == {"correct": ["B"]}
    assert len(model.calls) == len(state["usage"]) == 3


def test_question_tree_does_not_translate_unrelated_value_errors(monkeypatch):
    from practiq_ai import contracts

    parent = ParsedQuestion(id="bank", stem="Word bank", answerMode="word_bank")
    child = ParsedQuestion(id="child", parentId="bank", optionSourceId="bank", stem="Choose", answerMode="choice", choiceVariant="single")

    def broken(*args):
        raise ValueError("programming defect")

    monkeypatch.setattr(contracts, "answer_references_missing", broken)
    with pytest.raises(ValueError, match="programming defect") as caught:
        contracts.validate_question_tree([parent, child])
    assert not isinstance(caught.value, contracts.QuestionTreeError)


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


@pytest.mark.usefixtures("disposable_databases")
@pytest.mark.parametrize("pages", [False, True])
@pytest.mark.parametrize("policy", ["review", "return_partial"])
@pytest.mark.parametrize("conflict_kind", ["duplicate", "continuation"])
async def test_conflicting_child_unit_preserves_partial_passage_and_retry_restores_blanks(monkeypatch, pages, policy, conflict_kind):
    parent_id = "page:1:bank" if pages else "fragment:1:bank"
    parent = {
        **complete_question("Complete the passage", parent_id),
        "answerMode": "word_bank", "questionTypeId": "word_bank", "answerPayload": None,
        "instructions": "Use the supplied words.",
        "sourceText": "Snow is [1]. Grass is [2]. Water is [3].",
        "options": [{"label": label, "content": content} for label, content in
                    [("A", "white"), ("B", "green"), ("C", "clear")]],
        "passage": [
            {"partType": "text", "textValue": "Snow is "},
            {"partType": "blank", "questionId": "child1"},
            {"partType": "text", "textValue": ". Grass is "},
            {"partType": "blank", "questionId": "child2", "label": "2", "textValue": "[2]"},
            {"partType": "text", "textValue": ". Water is "},
            {"partType": "blank", "questionId": "child3", "label": "3"},
            {"partType": "text", "textValue": "."},
        ],
    }
    children = [{
        **complete_question(f"Gap {index}", f"child{index}"),
        "parentId": parent_id, "optionSourceId": parent_id, "answerMode": "choice",
        "choiceVariant": "single", "questionTypeId": "choice", "answerPayload": {"correct": [label]},
    } for index, label in enumerate(["A", "B", "C"], 1)]
    first = [parent, children[0], complete_question("First", "duplicate")]
    second = [*children[1:], complete_question("Second", "duplicate")]
    if conflict_kind == "continuation":
        second[-1]["id"] = "second"
        second.insert(0, {
            **parent, "sourceText": "Continuation evidence",
            "passage": [{"partType": "text", "textValue": "Continuation evidence"}],
        })
    second_calls = 0

    def respond(messages, _schema):
        nonlocal second_calls
        if "PRIMARY page 1" in messages[-1].content or messages[-1].content.endswith("First"):
            return {"questions": first}
        second_calls += 1
        if conflict_kind == "continuation":
            # The merge extends passage before discovering conflicting metadata.
            return {"questions": [{**second[0], "instructions": "Conflicting instructions" if second_calls == 1 else parent["instructions"]}, *second[1:]]}
        return {"questions": [*second[:-1], {**second[-1], "id": "duplicate" if second_calls == 1 else "second"}]}

    parts = ["\n".join(q["sourceText"] for q in unit) for unit in [first, second]]
    api, reference, model = await setup_api(monkeypatch, [respond] * 3, parts=parts)
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
    if policy == "review":
        assert state["state"] == "WAITING_REVIEW"
        await task_api.control_task(thread, DocumentTaskControl(
            requestId=uuid4(), action="accept_partial", checkpointId=state["checkpointId"],
        ))
        await api.wait_idle()
        state = await task_api.get_task(thread)
    assert state["status"] == "PARTIAL"
    result = DocumentParseResult.model_validate(state["result"])
    retained_parent, retained_child, retained_other = result.questions
    assert retained_parent.stem == parent["stem"] and retained_other.stem == "First"
    assert retained_parent.sourceText == parent["sourceText"]
    assert retained_parent.instructions == parent["instructions"]
    assert len(retained_parent.passage) == len(parent["passage"])
    assert retained_parent.needsReview and "material" in retained_parent.missingFields
    assert [b.questionId for b in retained_parent.passage if b.partType == "blank"] == [retained_child.id]
    assert retained_parent.passage[3].partType == "text" and retained_parent.passage[3].textValue == "[2]"
    assert retained_parent.passage[3].label == "2" and retained_parent.passage[3].questionId is None
    assert retained_parent.passage[5].partType == "text" and retained_parent.passage[5].textValue
    assert retained_parent.passage[5].label == "3" and retained_parent.passage[5].questionId is None
    assert state["processing"]["quality"]["reviewRequired"]
    assert {"questionId": retained_parent.id, "code": "MISSING_FIELDS"} in state["processing"]["quality"]["issues"]
    assert len(model.calls) == len(state["usage"]) == 2
    assert [(f["index"], f["code"]) for f in state["failures"]] == [(1, "OUTPUT_INVALID")]
    await task_api.control_task(thread, DocumentTaskControl(
        requestId=uuid4(), action="retry_failed", checkpointId=state["checkpointId"],
    ))
    await api.wait_idle()
    state = await task_api.get_task(thread)
    assert state["status"] == "SUCCEEDED" and state["failures"] == []
    restored = DocumentParseResult.model_validate(state["result"])
    restored_parent = restored.questions[0]
    restored_children = [q for q in restored.questions if q.parentId == restored_parent.id]
    assert len(restored.questions) == 6 and len(restored_children) == 3
    assert [b.questionId for b in restored_parent.passage if b.partType == "blank"] == [q.id for q in restored_children]
    assert restored_parent.sourceText == parent["sourceText"] and not restored_parent.needsReview
    assert restored_parent.instructions == parent["instructions"]
    assert restored_parent.passage[3].textValue == "[2]" and restored_parent.passage[5].textValue is None
    if conflict_kind == "continuation":
        assert len(restored_parent.passage) == len(parent["passage"]) + 1
        assert restored_parent.passage[-1].textValue == "Continuation evidence"
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


@pytest.mark.usefixtures("disposable_databases")
@pytest.mark.parametrize("pages", [False, True])
async def test_tree_error_after_continuation_retries_the_offending_unit(monkeypatch, pages):
    parent_id = "page:1:article" if pages else "fragment:1:article"
    parent = {**complete_question("Article", parent_id), "answerMode": "reading", "answerPayload": None}
    child = {**complete_question("Child", "child"), "parentId": parent_id}
    child_calls = 0

    def respond(messages, _schema):
        nonlocal child_calls
        prompt = messages[-1].content
        if "PRIMARY page 1" in prompt or prompt.endswith("First"):
            return {"questions": [{**parent, "sourceText": "First"}]}
        if "PRIMARY page 2" in prompt or prompt.endswith("Second"):
            return {"questions": [{**parent, "sourceText": "Second"}]}
        child_calls += 1
        return {"questions": [{**child, "answerMode": "reading" if child_calls == 1 else "short_answer",
                               "answerPayload": None if child_calls == 1 else child["answerPayload"]}]}

    api, reference, model = await setup_api(monkeypatch, [respond] * 4, parts=["First", "Second", "Child"])
    if pages:
        monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(
            text="", page_images=[make_image(), make_image(), make_image()],
        )))
    created = await task_api.create_task(DocumentTaskCreate(
        requestId=uuid4(), document=DocumentReference.model_validate(reference), failurePolicy="review",
    ))
    thread = created["threadId"]
    await api.wait_idle()
    state = await task_api.get_task(thread)
    assert state["state"] == "WAITING_REVIEW"
    assert [(f["stage"], f["index"], f["code"]) for f in state["failures"]] == [
        ("vision_parse" if pages else "document_parse", 2, "OUTPUT_INVALID"),
    ]
    assert "retry_failed" in state["allowedActions"] and len(model.calls) == 3
    await task_api.control_task(thread, DocumentTaskControl(
        requestId=uuid4(), action="retry_failed", checkpointId=state["checkpointId"],
    ))
    await api.wait_idle()
    state = await task_api.get_task(thread)
    assert state["status"] == "SUCCEEDED" and state["failures"] == []
    assert [(q["id"], q["parentId"]) for q in state["result"]["questions"]] == [("q0", None), ("q1", "q0")]
    assert len(model.calls) == len(state["usage"]) == 4


@pytest.mark.usefixtures("disposable_databases")
@pytest.mark.parametrize("pages", [False, True])
@pytest.mark.parametrize("field,count", [("passage", 600), ("transcript", 600), ("contentBlocks", 600), ("options", 60)])
async def test_oversized_continuation_retries_only_its_source_unit(monkeypatch, pages, field, count):
    parent_id = "page:1:bank" if pages else "fragment:1:bank"
    parent = {**complete_question("Material", parent_id), "answerMode": "listening" if field == "transcript" else "word_bank", "answerPayload": None}

    def values(prefix):
        if field == "options":
            return [{"label": f"{prefix}{index}", "content": f"{prefix}{index}"} for index in range(count)]
        return [{"partType": "text", "textValue": f"{prefix}{index}"} for index in range(count)]

    calls = 0

    def respond(messages, _schema):
        nonlocal calls
        prompt = messages[-1].content
        if "PRIMARY page 1" in prompt or prompt.endswith("First"):
            return {"questions": [{**parent, "sourceText": "First", field: values("First")}]}
        calls += 1
        return {"questions": [{**parent, "sourceText": "Second", field: values("Second") if calls == 1 else []}]}

    api, reference, model = await setup_api(monkeypatch, [respond] * 3, parts=["First", "Second"])
    if pages:
        monkeypatch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(
            text="", page_images=[make_image(), make_image()],
        )))
    created = await task_api.create_task(DocumentTaskCreate(
        requestId=uuid4(), document=DocumentReference.model_validate(reference), failurePolicy="review",
    ))
    thread = created["threadId"]
    await api.wait_idle()
    state = await task_api.get_task(thread)
    assert state["state"] == "WAITING_REVIEW"
    assert [(f["index"], f["code"]) for f in state["failures"]] == [(1, "OUTPUT_INVALID")]
    assert len(model.calls) == len(state["usage"]) == 2
    await task_api.control_task(thread, DocumentTaskControl(
        requestId=uuid4(), action="retry_failed", checkpointId=state["checkpointId"],
    ))
    await api.wait_idle()
    state = await task_api.get_task(thread)
    assert state["status"] == "SUCCEEDED" and state["failures"] == []
    assert len(state["result"]["questions"][0][field]) == count
    assert len(model.calls) == len(state["usage"]) == 3
