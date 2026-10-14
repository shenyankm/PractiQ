"""Correct complete local gap references without guessing continuation IDs."""

from copy import deepcopy
from typing import Any
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import HumanMessage
from langgraph.runtime import Runtime
from pydantic import ValidationError

from practiq_ai import execution, llm
from practiq_ai.graphs import document
from tests.support import FakeModel


def gap_tree(prefix: str, parent_number: int, child_number: int, mode: str = "gap_fill") -> list[dict[str, Any]]:
    parent_id, child_id = f"{prefix}:{parent_number}", f"{prefix}:{child_number}"
    options = [{"label": "A", "content": "white"}, {"label": "B", "content": "green"}]
    parent = {
        "id": parent_id, "stem": "Complete the supplied passage", "answerMode": mode,
        "passage": [{"partType": "text", "textValue": "They "},
                    {"partType": "blank", "questionId": child_id},
                    {"partType": "text", "textValue": " early."}],
        "options": options if mode == "word_bank" else [], "answerPayload": None,
    }
    child = {
        "id": child_id, "parentId": parent_id, "stem": "Hint: leave", "answerMode": "fill_blank",
        "blankCount": 1, "answerPayload": {"answers": ["left"]},
    }
    if mode != "gap_fill":
        child.update(answerMode="choice", choiceVariant="single", blankCount=None,
                     options=[] if mode == "word_bank" else options,
                     optionSourceId=parent_id if mode == "word_bank" else None,
                     answerPayload={"correct": ["A"]})
    return [parent, child]


@pytest.mark.parametrize("prefix,parent_number,child_number,unit", [
    ("fragment:24", 66, 67, "vision_parse:23:0"),
    ("page:58", 162, 163, "vision_parse:57:0"),
])
def test_complete_local_gap_rejects_nested_blank_id_without_rewriting(prefix, parent_number, child_number, unit):
    questions = gap_tree(prefix, parent_number, child_number)
    bad_reference = f"{prefix}:{parent_number}:{child_number}"
    questions[0]["passage"][1]["questionId"] = bad_reference
    token = execution.CURRENT_UNIT.set(unit)
    try:
        with pytest.raises(ValidationError, match="passage blanks must reference each child exactly once"):
            document.PageParseResult.model_validate({"questions": questions})
        assert questions[0]["passage"][1]["questionId"] == bad_reference
        assert execution.CURRENT_UNIT.get() == unit
    finally:
        execution.CURRENT_UNIT.reset(token)


@pytest.mark.parametrize("prefix,parent_number,child_number,unit", [
    ("fragment:24", 66, 67, "vision_parse:23:0"),
    ("page:58", 162, 163, "vision_parse:57:0"),
])
async def test_local_blank_error_is_corrected_with_both_known_attempts(monkeypatch, prefix, parent_number, child_number, unit):
    correct = gap_tree(prefix, parent_number, child_number)
    incorrect = deepcopy(correct)
    incorrect[0]["passage"][1]["questionId"] = f"{prefix}:{parent_number}:{child_number}"
    model = FakeModel(responses=[{"questions": incorrect}, {"questions": correct}])
    # This standalone helper has no graph Store; the graph budget is checked elsewhere.
    monkeypatch.setattr(llm, "reserve_model_call", AsyncMock())
    token = execution.CURRENT_UNIT.set(unit)
    try:
        parsed, usage, failure = await llm.structured_call(
            model, [HumanMessage(content="Extract the supplied passage and answer")],
            document.PageParseResult, "vision_parse",
        )
        assert failure is None and parsed is not None
        assert len(model.calls) == len(usage) == 2
        assert [(call.inputTokens, call.outputTokens) for call in usage] == [(10, 5), (10, 5)]
        assert len({call.callKey for call in usage}) == 2
        assert "passage blanks must reference each child exactly once" in model.calls[1][-1].content
        assert parsed.questions[0].passage[1].questionId == parsed.questions[1].id
        assert parsed.questions[1].model_dump()["answerPayload"] == {"answers": ["left"]}
        assert incorrect[0]["passage"][1]["questionId"] != parsed.questions[1].id
    finally:
        execution.CURRENT_UNIT.reset(token)


@pytest.mark.parametrize("mode", ["word_bank", "cloze", "gap_fill"])
def test_valid_closed_local_tree_keeps_options_answers_and_references(mode):
    questions = gap_tree("page:58", 162, 163, mode)
    token = execution.CURRENT_UNIT.set("vision_parse:57:0")
    try:
        parsed = document.PageParseResult.model_validate({"questions": questions})
        parent, child = parsed.questions
        assert parent.passage[1].questionId == child.id
        assert child.parentId == parent.id
        assert child.optionSourceId == (parent.id if mode == "word_bank" else None)
        if mode == "word_bank":
            assert [option.content for option in parent.options] == ["white", "green"]
            assert child.options == []
        elif mode == "cloze":
            assert [option.content for option in child.options] == ["white", "green"]
            assert parent.options == []
    finally:
        execution.CURRENT_UNIT.reset(token)


@pytest.mark.parametrize("continuation", ["future_unit", "unanchored", "missing_child", "no_local_child", "old_parent", "unknown_parent"])
def test_incomplete_or_cross_unit_gap_references_defer_to_merge(continuation):
    questions = gap_tree("page:58", 162, 163)
    if continuation == "future_unit":
        questions[0]["passage"][1]["questionId"] = "page:59:164"
    elif continuation == "unanchored":
        questions[0]["passage"][1]["questionId"] = "future-child"
    elif continuation == "missing_child":
        questions[0]["passage"].append({"partType": "blank", "questionId": "page:58:164"})
    elif continuation == "no_local_child":
        questions.pop()
        questions[0]["passage"][1]["questionId"] = "page:58:164"
    elif continuation == "old_parent":
        questions[0]["id"] = questions[1]["parentId"] = "page:57:162"
        questions[0]["passage"][1]["questionId"] = "page:58:162:163"
    else:
        questions[0]["id"] = questions[1]["parentId"] = "unanchored-parent"
        questions[0]["passage"][1]["questionId"] = "page:58:162:163"
    reference = questions[0]["passage"][1]["questionId"]
    token = execution.CURRENT_UNIT.set("vision_parse:57:0")
    try:
        parsed = document.PageParseResult.model_validate({"questions": questions})
        assert parsed.questions[0].passage[1].questionId == reference
        assert len(parsed.questions) == len(questions)
    finally:
        execution.CURRENT_UNIT.reset(token)


@pytest.mark.parametrize("ancestor_present", [False, True])
@pytest.mark.parametrize("mode", ["word_bank", "cloze"])
def test_nested_gap_with_an_external_ancestor_is_not_mistaken_for_a_closed_root(ancestor_present, mode):
    questions = gap_tree("page:58", 162, 163, mode)
    questions[0]["parentId"] = "page:57:160"
    questions[0]["passage"][1]["questionId"] = "page:58:162:163"
    if ancestor_present:
        questions.insert(0, {"id": "page:57:160", "stem": "Read the supplied passage", "answerMode": "reading",
                             "passage": [{"partType": "text", "textValue": "Original material"}]})
    token = execution.CURRENT_UNIT.set("vision_parse:57:0")
    try:
        parsed = document.PageParseResult.model_validate({"questions": questions})
        assert len(parsed.questions) == len(questions)
        assert next(question for question in parsed.questions if question.id == "page:58:162").parentId == "page:57:160"
    finally:
        execution.CURRENT_UNIT.reset(token)


@pytest.mark.parametrize("mode", ["word_bank", "cloze"])
def test_valid_nested_reading_gap_tree_remains_accepted(mode):
    questions = gap_tree("page:58", 162, 163, mode)
    questions[0]["parentId"] = "page:58:160"
    questions.insert(0, {"id": "page:58:160", "stem": "Read the supplied passage", "answerMode": "reading",
                         "passage": [{"partType": "text", "textValue": "Original material"}]})
    token = execution.CURRENT_UNIT.set("vision_parse:57:0")
    try:
        parsed = document.PageParseResult.model_validate({"questions": questions})
        assert [question.id for question in parsed.questions] == ["page:58:160", "page:58:162", "page:58:163"]
        assert parsed.questions[1].parentId == parsed.questions[0].id
        assert parsed.questions[1].passage[1].questionId == parsed.questions[2].id
    finally:
        execution.CURRENT_UNIT.reset(token)


async def test_guard_restores_context_when_local_reference_validation_raises(monkeypatch):
    questions = gap_tree("page:58", 162, 163)
    questions[0]["passage"][1]["questionId"] = "page:58:162:163"

    async def validate(_state):
        document.PageParseResult.model_validate({"questions": questions})
        return {}

    monkeypatch.setattr(document, "run_remaining", AsyncMock(return_value=60))
    token = execution.CURRENT_UNIT.set("outer-unit")
    before = (execution.CURRENT_EXECUTION.get(), execution.CURRENT_ARTIFACT.get(), execution.CURRENT_ALLOWANCE.get(),
              document.EXPECTED_NODE_COUNT.get(), document.EXPECTED_SOURCE_PRESENCE.get())
    try:
        with pytest.raises(ValidationError, match="passage blanks must reference each child exactly once"):
            await document._guarded(validate)(
                {"execution": execution.new_execution(), "unitKey": "vision_parse:57:0", "index": 57}, Runtime(),
            )
        assert execution.CURRENT_UNIT.get() == "outer-unit"
        assert before == (execution.CURRENT_EXECUTION.get(), execution.CURRENT_ARTIFACT.get(), execution.CURRENT_ALLOWANCE.get(),
                          document.EXPECTED_NODE_COUNT.get(), document.EXPECTED_SOURCE_PRESENCE.get())
    finally:
        execution.CURRENT_UNIT.reset(token)
