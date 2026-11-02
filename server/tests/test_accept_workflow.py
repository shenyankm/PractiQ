"""The workflow gate must reject plausible but incomplete or changed results."""

from copy import deepcopy

import pytest

from scripts.accept_workflow import EXPECTED, check_questions


def valid():
    return [{"stem": stem, "answerMode": "true_false", "answerPayload": {"value": answer},
             "needsReview": False, "missingFields": []} for stem, answer in EXPECTED]


def test_workflow_quality_accepts_reordering_and_source_numbering():
    rows = valid()[::-1]
    rows[0]["stem"] = "3. " + rows[0]["stem"]
    assert check_questions(rows) == []


def test_workflow_preserves_absent_optional_explanations_for_review():
    rows = valid()
    rows[0].update(needsReview=True, missingFields=["analysis"])
    assert check_questions(rows) == []


@pytest.mark.parametrize("change", ["missing", "duplicate", "answer", "mode", "required_field", "stem"])
def test_workflow_quality_rejects_changed_or_incomplete_output(change):
    rows = deepcopy(valid())
    if change == "missing":
        rows.pop()
    elif change == "duplicate":
        rows[1] = deepcopy(rows[0])
    elif change == "answer":
        rows[1]["answerPayload"]["value"] = True
    elif change == "mode":
        rows[0]["answerMode"] = "short_answer"
    elif change == "required_field":
        rows[0]["missingFields"] = ["answerPayload"]
    else:
        rows[0]["stem"] = "The Moon orbits the Sun."
    assert check_questions(rows)
