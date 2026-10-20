from copy import deepcopy
from types import SimpleNamespace

import pytest

from practiq_ai.contracts import (
    ContentBlock,
    ParsedOption,
    ParsedQuestion,
    QuestionSource,
)
from practiq_ai.graphs import chunking


@pytest.mark.parametrize('suffix', ['', 'unrelated' * 5000])
def test_ambiguous_source_quotes_stop_searching_after_second_match(suffix):
    calls = []

    class Observed(str):
        def find(self, *args):
            calls.append(args)
            return super().find(*args)

    text, positions = chunking._normalized_source(' A B A B ' + suffix, 40000)
    assert chunking._source_locations((Observed(text), positions), 'A B') == [(40001, 40004), (40005, 40008)]
    assert len(calls) == 2


def printed_bank(start: int, physical: int):
    ids = [f'q{start + index}' for index in range(3)]
    quotes = [
        f'{physical}. Word bank: Choose words\nMaterial: Snow is [blank:{physical + 1}]. Grass is [blank:{physical + 2}].\nA. white\nB. green',
        f'{physical + 1}. Single choice: Snow is\nParent ID: {physical}. Shared option owner: {physical}.\nReference answer: A',
        f'{physical + 2}. Single choice: Grass is\nParent ID: {physical}. Shared option owner: {physical}.\nReference answer: B',
    ]
    questions = [ParsedQuestion(id=ids[0], stem='Choose words', answerMode='word_bank', sourceText=quotes[0],
                               options=[ParsedOption(label='A', content='white'), ParsedOption(label='B', content='green')],
                               passage=[ContentBlock(partType='text', textValue='Snow is '), ContentBlock(partType='blank', questionId=ids[1]),
                                        ContentBlock(partType='text', textValue='. Grass is '), ContentBlock(partType='blank', questionId=ids[2])])]
    questions.extend(ParsedQuestion(id=ids[index], parentId=ids[0], optionSourceId=ids[0], stem=stem,
                                    answerMode='choice', choiceVariant='single', answerPayload={'correct': [label]}, sourceText=quotes[index])
                     for index, (stem, label) in enumerate((('Snow is', 'A'), ('Grass is', 'B')), 1))
    return questions


def evidence(text, questions, **kwargs):
    spans: list[chunking.ChunkSpan] = [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0}]
    sources = [QuestionSource(questionIndex=index, stage='document_parse', unitIndex=0) for index in range(len(questions))]
    return chunking.build_source_evidence(text, questions, sources, spans, **kwargs)


def test_source_tree_membership_does_not_rescan_every_frame(monkeypatch):
    questions = [ParsedQuestion(id=f'q{i}', stem=f'Prompt {i}', answerMode='short_answer',
                                sourceText=f'{i + 1}. Short answer: Prompt {i}\nReference answer: Answer {i}.') for i in range(100)]
    text = '\n\n'.join(q.sourceText or '' for q in questions)
    original = chunking._typed_frames
    reads = 0

    class Frame(dict):
        def __getitem__(self, key):
            nonlocal reads
            reads += key == 'parent'
            return super().__getitem__(key)

    monkeypatch.setattr(chunking, '_typed_frames', lambda source: [Frame(frame) for frame in original(source) or []])
    proven = evidence(text, questions)
    assert len(proven) == len(questions) and all(proven.values())
    assert reads <= len(questions) * 5


@pytest.mark.parametrize('newline', ['\n', '\r\n'])
@pytest.mark.parametrize('indent', ['', '  \t'])
def test_source_frame_matching_bounds_work_and_preserves_offsets(monkeypatch, newline, indent):
    count = 100
    records = [f'{indent}{i + 1}. Short answer: Prompt {i}{newline}Reference answer: Answer {i}' for i in range(count)]
    text = f'Worksheet instructions{newline}{newline}' + (newline * 2).join(records)
    questions = [ParsedQuestion(id=f'q{i}', stem=f'Prompt {i}', answerMode='short_answer',
                                answerPayload={'text': f'Answer {i}'}, sourceText=records[i]) for i in reversed(range(count))]
    before = deepcopy(questions)
    pattern = chunking._TYPED_QUESTION
    calls = 0

    def match(*args, **kwargs):
        nonlocal calls
        calls += 1
        return pattern.match(*args, **kwargs)

    monkeypatch.setattr(chunking, '_TYPED_QUESTION', SimpleNamespace(match=match, finditer=pattern.finditer))
    proven = evidence(text, questions)
    assert len(proven) == count and all(proven.values())
    for i in range(count):
        assert f'Prompt {i}' in str(proven[f'q{i}'])
    assert questions == before
    assert calls <= count * 10


@pytest.mark.parametrize('quote', [
    'Worksheet instructions', 'Short answer: Q', '1. Short answer:',
    '1. Short answer: Q\nReference answer: A\n2. Short answer: Other',
])
def test_source_frame_lookup_rejects_preamble_partial_and_cross_record_quotes(quote):
    first = '1. Short answer: Q\nReference answer: A'
    second = '2. Short answer: Other\nReference answer: B'
    text = 'Worksheet instructions\n\n' + first + '\n' + second
    questions = [ParsedQuestion(id='q0', stem='Q', sourceText=quote),
                 ParsedQuestion(id='q1', stem='Other', sourceText=second)]
    proven = evidence(text, questions)
    assert proven['q0'] is None and proven['q1']


def test_source_identity_normalization_requires_whole_proven_tree_and_keeps_business_fields():
    questions = [*printed_bank(0, 9), *printed_bank(3, 201)]
    text = '\n\n'.join(q.sourceText or '' for q in questions)
    before = deepcopy(questions)
    assert chunking.find_duplicate_question_trees(questions, [], []) == []
    proven = evidence(text, questions)
    assert len(proven) == 6 and all(proven.values())
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=proven) == [[['q0', 'q1', 'q2'], ['q3', 'q4', 'q5']]]
    assert questions == before


@pytest.mark.parametrize('suffix', ['\nPoints: 3', '\nReference answer: Different', '\nMaterial: Extra source material'])
def test_full_verified_frame_preserves_evidence_omitted_by_model_quote_and_fields(suffix):
    questions = [*printed_bank(0, 9), *printed_bank(3, 201)]
    quotes = [q.sourceText or '' for q in questions]
    quotes[3] += suffix
    text = '\n\n'.join(quotes)
    proven = evidence(text, questions)
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=proven) == []


@pytest.mark.parametrize('failure', ['prefix', 'ambiguous', 'parent', 'blank_order', 'missing_child'])
def test_incomplete_or_conflicting_proof_blocks_the_entire_known_source_tree(failure):
    questions = [*printed_bank(0, 9), *printed_bank(3, 201)]
    text = '\n\n'.join(q.sourceText or '' for q in questions)
    if failure == 'prefix':
        questions[3].sourceText = '201. Word bank:'
    elif failure == 'ambiguous':
        text += '\nRepeated literal: ' + (questions[3].sourceText or '')
    elif failure == 'parent':
        questions[1].parentId = questions[1].optionSourceId = 'q3'
        questions[4].parentId = questions[4].optionSourceId = 'q0'
        questions[0].passage[1].questionId = 'q4'
        questions[3].passage[1].questionId = 'q1'
    elif failure == 'blank_order':
        questions[3].passage[1].questionId, questions[3].passage[3].questionId = 'q5', 'q4'
    else:
        questions.pop()
        questions[3].passage = questions[3].passage[:2]
    proven = evidence(text, questions)
    assert proven['q3'] is None
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=proven) == []


@pytest.mark.parametrize('settings', [{'complete': False}, {'source_type': 'csv', 'tabular_rows_safe': False}])
def test_unknown_or_incomplete_source_keeps_legacy_comparison(settings):
    questions = printed_bank(0, 9)
    text = '\n\n'.join(q.sourceText or '' for q in questions)
    assert evidence(text, questions, **settings) == {}


def test_two_model_trees_cannot_claim_one_source_frame_and_hide_a_missing_record():
    text = '1. Short answer: Q\nReference answer: A\n2. Short answer: Other\nReference answer: B'
    questions = [ParsedQuestion(id=f'q{index}', stem='Q', answerMode='short_answer', answerPayload={'text': 'A'},
                                sourceText='1. Short answer: Q\nReference answer: A') for index in range(2)]
    proven = evidence(text, questions)
    assert proven == {'q0': None, 'q1': None}
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=proven) == []


def test_safe_csv_canonicalizes_only_identity_cells_and_verified_material_references():
    questions = [*printed_bank(0, 9), *printed_bank(3, 201)]
    header = 'id\troot_task\tquestion_type\tstem\tparent_id\toption_owner\tmaterial\toptions\tanswer\tevidence'
    rows = []
    for root in (9, 201):
        rows.extend([
            f'{root}\t{root}\tWord bank\tChoose words\t\t\tSnow is [blank:{root + 1}]. Grass is [blank:{root + 2}].\tA. white; B. green\t\t{{"id": "business-9", "points": 9}}',
            f'{root + 1}\t{root}\tSingle choice\tSnow is\t{root}\t{root}\t\t\tA\t{{}}',
            f'{root + 2}\t{root}\tSingle choice\tGrass is\t{root}\t{root}\t\t\tB\t{{}}',
        ])
    for question, row in zip(questions, rows, strict=True):
        question.sourceText = row
    text = header + '\n' + '\n'.join(rows)
    proven = evidence(text, questions, source_type='csv', tabular_rows_safe=True)
    assert len(proven) == 6 and all(proven.values())
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=proven) == [[['q0', 'q1', 'q2'], ['q3', 'q4', 'q5']]]
    changed = text.replace('"points": 9}', '"points": 8}', 1)
    changed_proof = evidence(changed, questions, source_type='csv', tabular_rows_safe=True)
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=changed_proof) == []
    assert evidence(text, questions, source_type='csv', tabular_rows_safe=False) == {}


@pytest.mark.parametrize('field,value', [('questionTypeId', 'different'), ('stem', 'Different task'),
                                       ('sourceScore', 9), ('scoringRubric', 'Different rubric')])
def test_proven_source_never_erases_actual_parsed_business_drift(field, value):
    questions = [*printed_bank(0, 9), *printed_bank(3, 201)]
    text = '\n\n'.join(q.sourceText or '' for q in questions)
    setattr(questions[3], field, value)
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=evidence(text, questions)) == []


def test_proven_source_does_not_ignore_passage_role_or_context_title():
    from practiq_ai.contracts import ParsedGroup
    questions = [*printed_bank(0, 9), *printed_bank(3, 201)]
    text = '\n\n'.join(q.sourceText or '' for q in questions)
    proven = evidence(text, questions)
    groups = [ParsedGroup(title='Different context', questionIndexes=[3, 4, 5])]
    assert chunking.find_duplicate_question_trees(questions, groups, [], source_evidence=proven) == []
    questions[3].passage[0].role = 'material'
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=proven) == []


def test_source_units_isolate_same_physical_ids_and_reject_wrong_chunk_scope():
    questions = [*printed_bank(0, 9), *printed_bank(3, 9)]
    first = '\n\n'.join(q.sourceText or '' for q in questions[:3])
    second = '\n\n'.join(q.sourceText or '' for q in questions[3:])
    text = first + '\n\n' + second
    spans: list[chunking.ChunkSpan] = [
        {'start': 0, 'end': len(first), 'overlapStart': 0, 'overlapEnd': 0},
        {'start': len(first) + 2, 'end': len(text), 'overlapStart': len(first) + 2, 'overlapEnd': len(first) + 2},
    ]
    units = [{'start': span['start'], 'end': span['end'], 'sourceType': 'text', 'sourceIndex': index} for index, span in enumerate(spans)]
    sources = [QuestionSource(questionIndex=index, stage='document_parse', unitIndex=0 if index < 3 else 1) for index in range(6)]
    proven = chunking.build_source_evidence(text, questions, sources, spans, text_units=units)
    assert all(proven.values()) and len(proven) == 6
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=proven) == [[['q0', 'q1', 'q2'], ['q3', 'q4', 'q5']]]
    sources[3].unitIndex = 0
    conflicting = chunking.build_source_evidence(text, questions, sources, spans, text_units=units)
    assert conflicting['q3'] is None
    assert chunking.find_duplicate_question_trees(questions, [], [], source_evidence=conflicting) == []


@pytest.mark.parametrize('deduplicate', [False, True])
async def test_document_merge_uses_source_evidence_for_the_explicit_removal_option(monkeypatch, deduplicate):
    from tests.support import run_config, setup_graph
    questions = [*printed_bank(0, 9), *printed_bank(3, 201)]
    text = '\n\n'.join(q.sourceText or '' for q in questions)
    raw = [q.model_dump(mode='json') for q in questions]
    aliases = {q['id']: f'fragment:1:{physical}' for q, physical in zip(raw, (9, 10, 11, 201, 202, 203), strict=True)}
    for node in raw:
        node['id'] = aliases[node['id']]
        for field in ('parentId', 'optionSourceId'):
            if node[field]:
                node[field] = aliases[node[field]]
        for block in node['passage']:
            if block['questionId']:
                block['questionId'] = aliases[block['questionId']]
    graph, _, _, reference, _ = setup_graph(monkeypatch, [{'questions': raw}], parts=[text])
    output = await graph.ainvoke({'document': reference, 'deduplicateQuestions': deduplicate}, run_config())
    assert output['status'] == 'SUCCEEDED'
    assert len(output['result']['questions']) == (3 if deduplicate else 6)
    if not deduplicate:
        assert any('All copies were retained' in warning for warning in output['result']['warnings'])


async def test_opt_in_retains_unverified_source_records_with_omitted_different_evidence(monkeypatch):
    from tests.support import run_config, setup_graph
    text = ('1. Explain gravity.\nPoints: 3\nRubric: Describe attraction.\n\n'
            '2. Explain gravity.\nPoints: 7\nRubric: Include the inverse-square relationship.')
    questions = [ParsedQuestion(id=f'q{index}', stem='Explain gravity.', answerMode='short_answer',
                                sourceText='Explain gravity.') for index in range(2)]
    assert evidence(text, questions) == {}
    assert chunking.find_duplicate_question_trees(questions, [], []) == [[['q0'], ['q1']]]
    graph, _, _, reference, _ = setup_graph(monkeypatch, [{'questions': [q.model_dump(mode='json') for q in questions]}], parts=[text])
    output = await graph.ainvoke({'document': reference, 'deduplicateQuestions': True}, run_config())
    assert output['status'] == 'SUCCEEDED' and len(output['result']['questions']) == 2
    assert all(question['needsReview'] for question in output['result']['questions'])
    assert any('All copies were retained' in warning for warning in output['result']['warnings'])


def test_group_membership_and_multiplicity_remain_business_evidence():
    from practiq_ai.contracts import ParsedGroup
    questions = [*printed_bank(0, 9), *printed_bank(3, 201)]
    text = '\n\n'.join(q.sourceText or '' for q in questions)
    groups = [ParsedGroup(title='Task', questionIndexes=members) for members in ([0, 1, 2], [3, 4], [3, 5])]
    assert chunking.find_duplicate_question_trees(questions, groups, [], source_evidence=evidence(text, questions)) == []
