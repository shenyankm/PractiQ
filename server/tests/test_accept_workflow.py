"""The workflow gate must reject plausible but incomplete or changed results."""

import json
from copy import deepcopy

import pytest

from scripts.accept_workflow import EXPECTED, check_questions, read_native_report


def valid():
    return [{"stem": stem, "answerMode": "true_false", "questionTypeId": "true_false", "answerPayload": {"value": answer},
             "needsReview": False, "missingFields": []} for stem, answer in EXPECTED]


def test_workflow_quality_accepts_reordering_and_source_numbering():
    rows = valid()[::-1]
    rows[0]["stem"] = "3. " + rows[0]["stem"]
    assert check_questions(rows) == []


def test_workflow_preserves_absent_optional_explanations_for_review():
    rows = valid()
    rows[0].update(needsReview=True, missingFields=["analysis"])
    assert check_questions(rows) == []


def test_workflow_preserves_literal_source_type_labels():
    rows = valid()
    for row in rows:
        row['questionTypeId'] = 'True or false questions'
    assert check_questions(rows) == []


@pytest.mark.parametrize('label', [None, '', 'choice', 'Unrelated source type'])
def test_workflow_rejects_missing_or_unrelated_type_labels(label):
    rows = valid()
    rows[0]['questionTypeId'] = label
    assert check_questions(rows)


@pytest.mark.parametrize("change", ["missing", "duplicate", "answer", "mode", "required_field", "stem", "type"])
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
    elif change == 'type':
        rows[0]['questionTypeId'] = None
    else:
        rows[0]["stem"] = "The Moon orbits the Sun."
    assert check_questions(rows)


def native_rows(hashes, repetitions):
    return [{"name":name,"repetition":repetition,"firstRun":repetition==0,
             "zipSha256":digest,"questions":3,"correct":3,"earnedCents":300,
             "reopen":True,"backupRestore":True}
            for name,digest in hashes.items() for repetition in range(repetitions)]


@pytest.mark.parametrize("names,repetitions", [(["txt"], 1), (["png"], 1), (["txt","md","png"], 8)])
def test_native_evidence_accepts_exact_case_and_repetition_coverage(tmp_path, names, repetitions):
    hashes = {name:"a"*64 for name in names}
    rows = native_rows(hashes, repetitions)
    path = tmp_path / "native.json"
    path.write_text(json.dumps(rows))
    actual, errors = read_native_report(path, hashes, repetitions)
    assert actual == rows
    assert errors == []


def test_native_evidence_rejects_successful_process_without_report(tmp_path):
    rows, errors = read_native_report(tmp_path / "native.json", {"txt":"a"*64}, 1)
    assert rows == []
    assert errors


@pytest.mark.parametrize("payload", ["{", "{}", "[]", "[null]"])
def test_native_evidence_rejects_missing_or_malformed_records(tmp_path, payload):
    path = tmp_path / "native.json"
    path.write_text(payload)
    assert read_native_report(path, {"txt":"a"*64}, 1)[1]


@pytest.mark.parametrize("change", ["missing", "duplicate", "case", "repetition", "boolean_repetition", "zip", "questions", "correct", "score", "unrestored", "unreopened", "first_run"])
def test_native_evidence_rejects_incomplete_or_mismatched_results(tmp_path, change):
    hashes = {name:"a"*64 for name in ["txt","md","png"]}
    rows = native_rows(hashes, 8)
    if change == "missing":
        rows.pop()
    elif change == "duplicate":
        rows[-1] = deepcopy(rows[0])
    else:
        field, value = {"case":("name","unknown"), "repetition":("repetition",8),
            "boolean_repetition":("repetition",False), "zip":("zipSha256","b"*64),
            "questions":("questions",2), "correct":("correct",2), "score":("earnedCents",200),
            "unrestored":("backupRestore",False), "unreopened":("reopen",False),
            "first_run":("firstRun",False)}[change]
        rows[0][field] = value
    path = tmp_path / "native.json"
    path.write_text(json.dumps(rows))
    assert read_native_report(path, hashes, 8)[1]
