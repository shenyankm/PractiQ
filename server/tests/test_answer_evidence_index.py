"""Indexed candidate lookup preserves literal boundaries and ambiguity."""

import re
from unittest.mock import Mock

import pytest

from practiq_ai.contracts import ParsedQuestion
from practiq_ai.graphs import answer_evidence
from practiq_ai.graphs.answer_evidence import _stem_records, retain_source_answers


@pytest.mark.parametrize('stem', ['', 'Missing', 'Prompt', 'Prompt 1', '题干', 'a+b?', '😀', '\U0010ffff'])
def test_indexed_records_match_the_literal_prefix_rule(stem):
    bodies = ['Prompt', 'Prompt 1', 'Prompt 10', 'Prompt 1.extra', 'Prompt 1_suffix', 'Prompt 1-more',
              '题干', '题干一', '题干。', 'a+b?', 'a+b?x', 'a+b?!', '😀', '😀!', '😀x',
              '\U0010ffff', '\U0010ffff\U0010ffff', '\U0010ffffx']
    records = sorted([(str(index), body, body) for index, body in enumerate(bodies * 2)], key=lambda item: item[2])
    pattern = re.compile(r'(?<![\w-])' + re.escape(stem) + r'(?![\w-])')
    expected = [item for item in records if stem and pattern.match(item[2])]
    assert list(_stem_records(records, stem)) == expected


def test_candidate_index_preserves_question_order_duplicate_ids_and_key_conflicts():
    source = ('8. Zebra\nAnswer: last\n2. Alpha\nAnswer: first\n'
              '3. Alpha\nAnswer: other\n4. Conflict\nAnswer: local')
    cases = [('q:8', 'Zebra', 'last'), ('q:3', 'Alpha', 'other'), ('unknown', 'Alpha', 'first'),
             ('q:4', 'Conflict', 'local'), ('q:2', 'Alpha', 'first')]
    questions = [ParsedQuestion(id=identifier, stem=stem, answerMode='short_answer', answerPayload={'text': answer})
                 for identifier, stem, answer in cases]
    assert retain_source_answers(questions, source, ['Answers:\n4. conflicting']) == [
        (2, ['answerPayload']), (3, ['answerPayload'])]
    assert [question.id for question in questions] == [identifier for identifier, _, _ in cases]
    assert [question.model_dump()['answerPayload'] for question in questions] == [
        {'text': 'last'}, {'text': 'other'}, None, None, {'text': 'first'}]
    assert all(questions[index].needsReview and 'answerPayload' in questions[index].missingFields for index in (2, 3))


@pytest.mark.parametrize('count', [0, 3])
def test_questions_without_answer_fields_skip_source_parsing_and_keep_review_metadata(monkeypatch, count):
    questions = [ParsedQuestion(id=f'q{index}', stem='Unanswered', answerMode='short_answer',
                                needsReview=True, missingFields=['answerPayload']) for index in range(count)]
    expected = [question.model_dump() for question in questions]
    records = Mock(side_effect=AssertionError('No answer fields require source proofs'))
    monkeypatch.setattr(answer_evidence, '_records', records)
    assert retain_source_answers(questions, '1. Unanswered', ['Answers:\n1. A']) == []
    records.assert_not_called()
    assert [question.model_dump() for question in questions] == expected


@pytest.mark.parametrize('repeated_context', [False, True])
def test_primary_records_are_parsed_once_without_losing_context_number_multiplicity(monkeypatch, repeated_context):
    primary = '1. Printed?'
    contexts = ([primary] if repeated_context else []) + ['Answers:\n1. 4']
    question = ParsedQuestion(id='page:1', stem='Printed?', answerMode='short_answer', answerPayload={'text': '4'})
    records = Mock(wraps=answer_evidence._records)
    monkeypatch.setattr(answer_evidence, '_records', records)
    assert retain_source_answers([question], primary, contexts) == ([(0, ['answerPayload'])] if repeated_context else [])
    assert question.model_dump()['answerPayload'] == (None if repeated_context else {'text': '4'})
    assert sum(call.args[0] == primary for call in records.call_args_list) == 1 + int(repeated_context)
