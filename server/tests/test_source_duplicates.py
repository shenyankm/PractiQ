from copy import deepcopy

import pytest

from practiq_ai.contracts import (
    ContentBlock,
    ParsedOption,
    ParsedQuestion,
    QuestionSource,
)
from practiq_ai.graphs import chunking
from tests.support import run_config, setup_graph


def source_copies(count=3):
    quotes = [f'{physical}. Short answer: Worksheet A: Explain gravity\nReference answer: Attraction\nAnalysis: Bodies attract each other'
              for physical in range(1, count + 1)]
    questions = [ParsedQuestion(id=f'q{index}', stem='Worksheet A: Explain gravity', answerMode='short_answer',
                                questionTypeId='Short answer', answerPayload={'text': 'Attraction'},
                                analysis='Bodies attract each other', confidence=1, needsReview=False, sourceText=quote)
                 for index, quote in enumerate(quotes)]
    text = '\n\n'.join(quotes)
    sources = [QuestionSource(questionIndex=index, stage='document_parse', unitIndex=0) for index in range(count)]
    spans: list[chunking.ChunkSpan] = [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0}]
    proof = chunking.build_source_evidence(text, questions, sources, spans)
    assert not any(question.needsReview for question in questions)
    return text, questions, proof


@pytest.mark.parametrize('field,value', [('stem', 'Explain gravity'), ('questionTypeId', 'Different type'),
                                       ('sourceScore', 7), ('scoringRubric', 'Different rubric')])
def test_source_repeats_are_identified_without_erasing_parsed_business_drift(field, value):
    _text, questions, proof = source_copies()
    setattr(questions[1], field, value)
    questions[2].analysis = 'Different analysis'
    before = deepcopy(questions)
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=proof) == []
    assert chunking.find_source_duplicate_question_trees(questions, source_evidence=proof) == [[['q0'], ['q1'], ['q2']]]
    assert questions == before


@pytest.mark.parametrize('field', ['canonical_quote', 'missing', 'none', 'partial'])
def test_source_groups_use_complete_original_evidence_and_skip_unknown_trees(field):
    text, questions, proof = source_copies(2)
    second = proof['q1']
    assert second is not None
    if field == 'canonical_quote':
        questions[1].sourceText = (questions[1].sourceText or '').partition('\n')[0]
        sources = [QuestionSource(questionIndex=index, stage='document_parse', unitIndex=0) for index in range(2)]
        proof = chunking.build_source_evidence(text, questions, sources, [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0}])
        assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=proof) == []
        expected = [[['q0'], ['q1']]]
    else:
        if field == 'missing':
            proof.pop('q1')
        elif field == 'none':
            proof['q1'] = None
        else:
            second['full_source'] = None
        expected = []
    assert chunking.find_source_duplicate_question_trees(questions, source_evidence=proof) == expected


@pytest.mark.parametrize('field,value', [('Points', '7'), ('Reference answer', 'Different answer'), ('Material', 'Different material')])
def test_differing_original_evidence_never_becomes_a_source_repeat(field, value):
    text, questions, _proof = source_copies(2)
    text = text + f'\n{field}: {value}'
    sources = [QuestionSource(questionIndex=index, stage='document_parse', unitIndex=0) for index in range(2)]
    proof = chunking.build_source_evidence(text, questions, sources, [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0}])
    assert chunking.find_source_duplicate_question_trees(questions, source_evidence=proof) == []


def test_whole_source_incomplete_or_unknown_never_has_source_repeat_proof():
    text, questions, _proof = source_copies(2)
    sources = [QuestionSource(questionIndex=index, stage='document_parse', unitIndex=0) for index in range(2)]
    for source_text, complete in ((text, False), ('An unstructured source', True)):
        proof = chunking.build_source_evidence(source_text, questions, sources, [{'start': 0, 'end': len(source_text), 'overlapStart': 0, 'overlapEnd': 0}], complete=complete)
        assert chunking.find_source_duplicate_question_trees(questions, source_evidence=proof) == []


def test_nonadjacent_complete_compound_source_trees_and_business_drift_form_six_pairs():
    _text, questions, _proof = source_copies()
    for copy, physical in enumerate((9, 201, 401)):
        ids = [f'q{3 + copy * 3 + offset}' for offset in range(3)]
        quotes = [f'{physical}. Word bank: Worksheet B: Choose words\nMaterial: Snow is [blank:{physical + 1}]. Grass is [blank:{physical + 2}]\nA. white\nB. green',
                  f'{physical + 1}. Single choice: Snow is\nParent ID: {physical}. Shared option owner: {physical}.\nReference answer: A',
                  f'{physical + 2}. Single choice: Grass is\nParent ID: {physical}. Shared option owner: {physical}.\nReference answer: B']
        questions.append(ParsedQuestion(id=ids[0], stem='Worksheet B: Choose words', answerMode='word_bank', sourceText=quotes[0],
                                        options=[ParsedOption(label='A', content='white'), ParsedOption(label='B', content='green')],
                                        passage=[ContentBlock(partType='text', textValue='Snow is '), ContentBlock(partType='blank', questionId=ids[1]),
                                                 ContentBlock(partType='text', textValue='. Grass is '), ContentBlock(partType='blank', questionId=ids[2])]))
        questions.extend(ParsedQuestion(id=ids[offset], parentId=ids[0], optionSourceId=ids[0], stem=stem,
                                        answerMode='choice', choiceVariant='single', answerPayload={'correct': [label]}, sourceText=quotes[offset])
                         for offset, (stem, label) in enumerate((('Snow is', 'A'), ('Grass is', 'B')), 1))
    text = '\n\n'.join(question.sourceText or '' for question in questions)
    sources = [QuestionSource(questionIndex=index, stage='document_parse', unitIndex=0) for index in range(len(questions))]
    proof = chunking.build_source_evidence(text, questions, sources, [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0}])
    questions[1].stem = 'Explain gravity'
    questions[2].scoreSourceText = 'A different source score'
    questions[6].stem = 'Choose words'
    questions[9].passage.append(ContentBlock(partType='text', textValue='.'))
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=proof) == []
    assert chunking.find_source_duplicate_question_trees(questions, source_evidence=proof) == [
        [['q0'], ['q1'], ['q2']], [['q3', 'q4', 'q5'], ['q6', 'q7', 'q8'], ['q9', 'q10', 'q11']],
    ]
    proof['q7'] = None
    assert chunking.find_source_duplicate_question_trees(questions, source_evidence=proof)[1] == [['q3', 'q4', 'q5'], ['q9', 'q10', 'q11']]


@pytest.mark.parametrize('enabled', [False, True])
async def test_source_business_conflict_requires_review_and_never_authorizes_removal(monkeypatch, enabled):
    text, questions, _proof = source_copies(2)
    questions[1].questionTypeId = 'Different type'
    raw = [question.model_dump(mode='json') for question in questions]
    for index, item in enumerate(raw, 1):
        item['id'] = f'fragment:1:{index}'
    graph, _, _, reference, _model = setup_graph(monkeypatch, [{'questions': raw}], parts=[text])
    result = await graph.ainvoke({'document': reference, 'deduplicateQuestions': enabled}, run_config())
    assert result['status'] == 'SUCCEEDED' and len(result['result']['questions']) == 2
    assert all(item['needsReview'] for item in result['result']['questions'])
    assert result['processing']['quality']['reviewQuestionCount'] == 2
    assert {(issue['questionId'], issue['code']) for issue in result['processing']['quality']['issues']} == {('q0', 'NEEDS_REVIEW'), ('q1', 'NEEDS_REVIEW')}
    assert any('Repeated source question groups' in warning for warning in result['result']['warnings'])
    assert not any('Removed ' in warning for warning in result['result']['warnings'])


async def test_source_warning_after_safe_removal_names_only_surviving_trees_and_recomputes_quality(monkeypatch):
    text, questions, _proof = source_copies()
    questions[2].questionTypeId = 'Different type'
    raw = [question.model_dump(mode='json') for question in questions]
    for index, item in enumerate(raw, 1):
        item['id'] = f'fragment:1:{index}'
    graph, _, _, reference, _model = setup_graph(monkeypatch, [{'questions': raw}], parts=[text])
    result = await graph.ainvoke({'document': reference, 'deduplicateQuestions': True}, run_config())
    assert [item['id'] for item in result['result']['questions']] == ['q0', 'q2']
    assert all(item['needsReview'] for item in result['result']['questions'])
    assert result['processing']['quality']['reviewQuestionCount'] == 2
    assert [(issue['questionId'], issue['code']) for issue in result['processing']['quality']['issues']] == [('q0', 'NEEDS_REVIEW'), ('q2', 'NEEDS_REVIEW')]
    warning = next(warning for warning in result['result']['warnings'] if warning.startswith('Repeated source question groups'))
    assert warning == ('Repeated source question groups: q0 (fragment 1); q2 (fragment 1). '
                       'Parsed versions are not strictly identical; the remaining copies were retained for review.')
    assert any('Removed 1 exact duplicate' in warning for warning in result['result']['warnings'])


async def test_unknown_source_warning_never_claims_original_source_equality(monkeypatch):
    questions = [ParsedQuestion(id=f'q{index}', stem='Explain', answerMode='short_answer', sourceText='Explain') for index in range(2)]
    graph, _, _, reference, _model = setup_graph(monkeypatch, [{'questions': [question.model_dump(mode='json') for question in questions]}], parts=['An unstructured source'])
    result = await graph.ainvoke({'document': reference, 'deduplicateQuestions': True}, run_config())
    assert len(result['result']['questions']) == 2
    assert not any('Repeated source question groups' in warning for warning in result['result']['warnings'])
