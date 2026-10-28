import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from practiq_ai import grading
from practiq_ai.contracts import ParsedQuestion, answer_source_conflict

CASES = json.loads((Path(__file__).parents[2] / 'app/fixtures/answer-source-consistency.json').read_text())


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['name'])
def test_answer_consistency_matches_shared_cases(case):
    question = ParsedQuestion.model_validate(case['question'])
    assert answer_source_conflict(question.model_dump(mode='json')) is case['conflict']
    if case['conflict']:
        assert question.needsReview
        assert question.model_dump(mode='json')['answerPayload'] == case['question']['answerPayload']
        assert question.sourceText == case['question']['sourceText']


async def test_conflicting_reference_does_not_call_grading_model_even_with_rubric(monkeypatch):
    question = {
        'stem': 'Explain evaporation', 'answerMode': 'short_answer',
        'answerPayload': {'text': 'freezing'}, 'scoringRubric': 'Use the supplied reference',
        'sourceText': 'Explain evaporation\nReference answer: liquid becoming gas',
    }
    request = grading.GradeRequest.model_validate({
        'requestId': str(uuid4()), 'inputDigest': 'a' * 64, 'question': question,
        'answer': 'freezing', 'maxCents': 500,
    })
    saved = []
    monkeypatch.setattr(grading, 'load', lambda: SimpleNamespace(maintenance=False))
    monkeypatch.setattr(grading, '_claim', lambda _: None)
    monkeypatch.setattr(grading, '_save', lambda _request, response: saved.append(response))
    monkeypatch.setattr(grading, 'get_model', lambda: pytest.fail('Conflicting evidence must not start model work'))
    result = await grading.grade(request)
    assert result['status'] == 'ungraded' and result['usage'] == []
    assert saved == [result]
