"""Behavior boundaries for source-validation CPU optimizations."""

from copy import deepcopy

import pytest

from practiq_ai.contracts import ContentBlock, ParsedQuestion, QuestionTreeError
from practiq_ai.graphs import answer_evidence, chunking


@pytest.mark.parametrize('separator', ['\n', '\r\n'])
@pytest.mark.parametrize('suffix,answer', [
    ('', True), ('  Answer status: supplied  ', True),
    ('  Answer status: unavailable  ', False), ('  Supplied answer: other  ', False),
    ('  No reference answer is supplied for this question.  ', False),
])
def test_presence_keeps_indented_answer_conflicts(separator, suffix, answer):
    text = separator.join(['1. Short answer: Prompt', '  Reference answer: 0  ',
                           '  Analysis: Reason  ', suffix])
    spans, _, _ = chunking.split_chunk_plan(text)
    hint = chunking.source_presence_plan(text, spans)[0]
    assert hint is not None
    assert hint['1'].get('need_answer') is answer
    assert hint['1']['need_analysis']


@pytest.mark.parametrize('whitespace', [' ', '\t', '\r\n', '\u001c', '\u0085', '\u00a0', '\u2003', '\u2028', '\u3000'])
def test_unicode_normalization_keeps_source_offsets(whitespace):
    text = f'{whitespace}中{whitespace}A{whitespace}文{whitespace}'
    normalized = chunking._normalized_source(text, 37)
    assert normalized[0] == '中A文'
    assert chunking._source_locations(normalized, f'中{whitespace}A') == [(37 + len(whitespace), 39 + len(whitespace) * 2)]
    assert answer_evidence._literal(text) == '中 A 文'


@pytest.mark.parametrize('printed,expected,match', [
    (' 1. ', '1', False), ('1.', '1', True), ('1.0.', '1.0', True),
    ('1e2.', '100', False), ('+1.', '+1', True), ('x.', 'x', False),
    ('中\u3000文', '中 文', True), ('False', 'false', False),
])
def test_scalar_proofs_remain_literal(printed, expected, match):
    assert answer_evidence._scalar_matches(printed, expected) is match


def test_duplicate_validation_preserves_incomplete_composites_and_nested_fields():
    questions = [ParsedQuestion(id='p', stem='Reading', answerMode='reading'),
                 ParsedQuestion(id='q', parentId='p', stem='Prompt', answerMode='short_answer',
                                answerPayload={'text': 'Answer'}, sourceText='Printed')]
    original = deepcopy(questions)
    assert chunking._whole_question_trees(questions) == [[0, 1]]
    assert chunking.find_duplicate_question_trees(questions, [], []) == []
    assert questions == original
    assert 'material' not in questions[0].missingFields
    questions[1].parentId = 'q'
    with pytest.raises(QuestionTreeError):
        chunking.find_duplicate_question_trees(questions, [], [])


@pytest.mark.parametrize('text', ['Plain source with no table', '1. Short answer: Prompt\nAnswer: Yes',
                                 'stem\tanswer\nPrompt\tYes', 'stem\tanswer\nPrompt\tYes\textra'])
def test_record_discovery_keeps_plain_and_malformed_table_boundaries(text):
    records = answer_evidence._records(text)
    assert records
    assert any('Prompt' in record or 'Plain source' in record for _, record in records)


def test_answer_proof_does_not_serialize_unrelated_question_fields(monkeypatch):
    question = ParsedQuestion(stem='Prompt', answerMode='short_answer', answerPayload={'text': 'Answer'})

    def unexpected_dump(*args, **kwargs):
        pytest.fail('Answer proof must only serialize the answer payload')

    monkeypatch.setattr(ParsedQuestion, 'model_dump', unexpected_dump)
    assert answer_evidence._answer_matches(question, 'Answer')
    assert not answer_evidence._answer_matches(question, 'Other')


def test_duplicate_detection_without_quotes_keeps_verified_proofs_and_tree_validation():
    questions = [ParsedQuestion(id=f'q{i}', stem='Prompt', answerMode='short_answer') for i in range(2)]
    assert chunking.find_duplicate_question_trees(questions, [], []) == []
    proof: chunking.SourceEvidence = {'canonical_quote': ['Printed'], 'full_source': {'record': ['Printed']}}
    evidence: dict[str, chunking.SourceEvidence | None] = {q.id: proof for q in questions if q.id is not None}
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=evidence) == [[['q0'], ['q1']]]
    questions[1].id = 'q0'
    with pytest.raises(QuestionTreeError):
        chunking.find_duplicate_question_trees(questions, [], [])


@pytest.mark.parametrize('value', [float('nan'), float('inf'), -float('inf')])
def test_absent_quote_does_not_bypass_invalid_json_evidence(value):
    question = ParsedQuestion(id='q', stem='Prompt', answerMode='short_answer',
        contentBlocks=[ContentBlock(partType='table', jsonValue={'value': value})])
    with pytest.raises(ValueError, match='Out of range float values'):
        chunking.find_duplicate_question_trees([question], [], [])
