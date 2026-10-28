"""Answer provenance regressions use provider substitutes, never paid models."""

import json
from typing import cast
from unittest.mock import AsyncMock

import pytest

from practiq_ai.contracts import ParsedQuestion, document_source_key
from practiq_ai.graphs import document
from practiq_ai.graphs.answer_evidence import retain_source_answers
from tests.support import (
    FakeModel,
    MemoryStore,
    local_graph,
    make_image,
    ocr_text_page,
    question,
    run_config,
    source,
    tencent_provider,
)


@pytest.mark.parametrize('mode,payload,printed', [
    ('short_answer', {'text': '4'}, '4'),
    ('short_answer', {'text': '0'}, '0'),
    ('short_answer', {'text': 'None'}, '"None"'),
    ('short_answer', {'text': 'false'}, 'false'),
    ('true_false', {'value': False}, '错误'),
    ('fill_blank', {'answers': ['four']}, 'four'),
    ('ordering', {'order': [0, 1]}, '[0, 1]'),
    ('matching', {'matches': [{'left': 0, 'right': 1}]}, '{"matches":[{"left":0,"right":1}]}'),
])
def test_literal_answers_and_explanations_are_preserved(mode, payload, printed):
    candidate = ParsedQuestion.model_validate({**question('Printed question?'), 'answerMode': mode,
        'answerPayload': payload, 'analysis': 'Supplied explanation.',
        **({'blankCount': 1} if mode == 'fill_blank' else {}),
        **({'items': [{'id': index, 'content': str(index)} for index in range(2)]} if mode == 'ordering' else {}),
        **({'matchingVariant': 'one_to_one', 'items': [{'id': index, 'side': side, 'content': str(index)}
            for side in ['left', 'right'] for index in range(2)]} if mode == 'matching' else {})})
    text = f'1. Printed question?\nReference answer: {printed}\nAnalysis: Supplied explanation.'
    assert retain_source_answers([candidate], text, []) == []
    assert candidate.model_dump()['answerPayload'] == payload and candidate.analysis == 'Supplied explanation.'


@pytest.mark.parametrize('newline', ['\n', '\r\n'])
@pytest.mark.parametrize('heading', ['Section: Second', ' \tsection:\tSecond'])
@pytest.mark.parametrize('answer_last', [False, True])
def test_explicit_sections_end_local_answer_and_analysis_fields(newline, heading, answer_last):
    candidate = ParsedQuestion.model_validate({**question('Printed?'), 'answerPayload': {'text': '4'},
                                              'analysis': 'Supplied explanation.'})
    fields = ['Answer: 4', 'Analysis: Supplied explanation.']
    if answer_last:
        fields.reverse()
    text = newline.join(['Section: First', '1. Printed?', *fields, heading, '2. Other?', 'Answer: 5'])
    assert retain_source_answers([candidate], text, []) == []
    assert candidate.model_dump()['answerPayload'] == {'text': '4'}
    assert candidate.analysis == 'Supplied explanation.'


def test_explicit_sections_cannot_supply_fields_to_the_preceding_question():
    candidate = ParsedQuestion.model_validate({**question('Printed?'), 'answerPayload': {'text': '4'},
                                              'analysis': 'Supplied explanation.'})
    text = '1. Printed?\nSection: Notes\nAnswer: 4\nAnalysis: Supplied explanation.'
    assert retain_source_answers([candidate], text, []) == [(0, ['answerPayload', 'analysis'])]
    assert candidate.answerPayload is None and candidate.analysis is None and candidate.needsReview


@pytest.mark.parametrize('mode,printed,kept', [
    ('ordering', '1, 0', True), ('ordering', '1,0.', True), ('ordering', '1,\n0。', True),
    ('ordering', '0, 1', False), ('ordering', '1, 0 or 0, 1', False),
    ('ordering', '1, 0 extra', False), ('ordering', '1, 0, 1', False),
    ('ordering', '1e0, 0', False), ('ordering', '11, 0', False),
    ('matching', 'left 0 -> right 0; left 1 -> right 1.', True),
    ('matching', 'LEFT 0->RIGHT 0 ;\nleft 1 -> right 1', True),
    ('matching', 'left 0 -> right 1; left 1 -> right 0.', False),
    ('matching', 'left 0 -> right 0; left 1 -> right 1 or right 0.', False),
    ('matching', 'left 0 -> right 0; left 1 -> right 1. Extra', False),
    ('matching', 'left 0 -> right 0; left 1 -> right 1; left 0 -> right 1', False),
    ('matching', 'left 0 -> right 0', False),
    ('matching', 'left 0 -> right 0; left 11 -> right 1.', False),
])
def test_printed_structured_answers_require_the_complete_sequence_or_pairs(mode, printed, kept):
    payload = {'order': [1, 0]} if mode == 'ordering' else {'matches': [{'left': 0, 'right': 0}, {'left': 1, 'right': 1}]}
    items = ([{'id': index, 'content': str(index)} for index in range(2)] if mode == 'ordering' else
             [{'id': index, 'side': side, 'content': str(index)} for side in ['left', 'right'] for index in range(2)])
    candidate = ParsedQuestion.model_validate({**question('Printed?'), 'answerMode': mode, 'answerPayload': payload,
        'items': items, **({'matchingVariant': 'one_to_one'} if mode == 'matching' else {})})
    changes = retain_source_answers([candidate], f'1. Printed?\nAnswer: {printed}', [])
    assert changes == ([] if kept else [(0, ['answerPayload'])])
    assert candidate.model_dump()['answerPayload'] == (payload if kept else None)


@pytest.mark.parametrize('text', [
    '1. Printed question?\nA. four\nB. five',
    '1. Printed question?\n2. Different question?\nAnswer: four\nAnalysis: guessed',
    '1. Printed question?\nAnswer: five\nAnalysis: genuine',
    '',
])
def test_guesses_cannot_use_options_other_questions_or_fabricated_quotes(text):
    candidate = ParsedQuestion.model_validate({**question('Printed question?'), 'answerPayload': {'text': 'four'},
                                              'analysis': 'guessed', 'sourceText': 'Printed question? Answer: four Analysis: guessed'})
    assert retain_source_answers([candidate], text, []) == [(0, ['answerPayload', 'analysis'])]
    assert candidate.answerPayload is None and candidate.analysis is None
    assert candidate.stem == 'Printed question?' and candidate.needsReview
    assert {'answerPayload', 'analysis'} <= set(candidate.missingFields)


@pytest.mark.parametrize('answer,analysis,removed', [
    ('4', 'invented', ['analysis']),
    ('5', 'Two plus two.', ['answerPayload']),
])
def test_answer_and_analysis_have_independent_proofs(answer, analysis, removed):
    candidate = ParsedQuestion.model_validate({**question('2 + 2?'), 'answerPayload': {'text': answer}, 'analysis': analysis})
    assert retain_source_answers([candidate], '1. 2 + 2? 答案：4\n解析：Two plus two.', []) == [(0, removed)]


def test_answer_key_context_preserves_linked_answers_without_borrowing_neighbors():
    candidates = [ParsedQuestion.model_validate({**question(stem), 'id': f'page:1:{index}', 'answerPayload': {'text': 'four'}})
                  for index, stem in enumerate(['First?', 'Second?'], 1)]
    primary = '1. First?\n2. Second?'
    context = 'Answers:\n1. four\n2. five'
    assert retain_source_answers(candidates, primary, [context]) == [(1, ['answerPayload'])]
    assert candidates[0].model_dump()['answerPayload'] == {'text': 'four'}
    assert candidates[1].answerPayload is None


@pytest.mark.parametrize('label', ['Answer', 'Reference answer'])
@pytest.mark.parametrize('same_page', [False, True])
@pytest.mark.parametrize('newline', ['\n', '\r\n'])
def test_labeled_answer_key_preserves_supplied_answer_and_analysis(label, same_page, newline):
    candidate = ParsedQuestion.model_validate({**question('Printed question?'), 'answerPayload': {'text': 'four'},
                                              'analysis': 'Supplied explanation.'})
    primary = '1. Printed question?'
    key = f'Answers:{newline}1. {label}: four{newline}Analysis: Supplied explanation.'
    assert retain_source_answers([candidate], primary + newline + key if same_page else primary, [] if same_page else [key]) == []
    assert candidate.model_dump()['answerPayload'] == {'text': 'four'}
    assert candidate.analysis == 'Supplied explanation.'


@pytest.mark.parametrize('mode', ['short_answer', 'fill_blank'])
@pytest.mark.parametrize('printed,value,kept', [
    ('3.00', '3.00', True), ('1e-3', '1e-3', True), ('-0', '-0', True),
    ('3.00', '3.0', False), ('1e-3', '0.001', False), ('-0', '0', False),
    ('"3.00"', '3.00', True),
])
def test_numeric_text_requires_literal_source_spelling(mode, printed, value, kept):
    payload = {'text': value} if mode == 'short_answer' else {'answers': [value]}
    candidate = ParsedQuestion.model_validate({**question('Printed question?'), 'answerMode': mode,
        'answerPayload': payload, **({'blankCount': 1} if mode == 'fill_blank' else {})})
    changes = retain_source_answers([candidate], f'1. Printed question?\nReference answer: {printed}', [])
    assert (not changes) is kept
    assert candidate.model_dump()['answerPayload'] == (payload if kept else None)


@pytest.mark.parametrize('punctuation', ['.', '。', '．'])
@pytest.mark.parametrize('mode,payload,printed', [
    ('true_false', {'value': True}, 'True'), ('true_false', {'value': False}, 'False'),
    ('choice', {'correct': ['A']}, 'A'), ('choice', {'correct': ['A', 'B']}, 'A,B'),
])
def test_choice_and_boolean_answers_allow_terminal_punctuation(mode, payload, printed, punctuation):
    candidate = ParsedQuestion.model_validate({**question('Printed?'), 'answerMode': mode, 'answerPayload': payload,
        **({'choiceVariant': 'multiple', 'options': [{'label': label, 'content': label} for label in ['A', 'B']]}
           if mode == 'choice' else {})})
    assert retain_source_answers([candidate], f'1. Printed?\nAnswer: {printed}{punctuation}', []) == []
    assert candidate.model_dump()['answerPayload'] == payload


@pytest.mark.parametrize('mode', ['short_answer', 'fill_blank'])
@pytest.mark.parametrize('value,kept', [('A.', True), ('A', False)])
def test_text_answer_punctuation_remains_literal(mode, value, kept):
    payload = {'text': value} if mode == 'short_answer' else {'answers': [value]}
    candidate = ParsedQuestion.model_validate({**question('Printed?'), 'answerMode': mode, 'answerPayload': payload,
                                              **({'blankCount': 1} if mode == 'fill_blank' else {})})
    changes = retain_source_answers([candidate], '1. Printed?\nAnswer: A.', [])
    assert (not changes) is kept
    assert candidate.model_dump()['answerPayload'] == (payload if kept else None)


@pytest.mark.parametrize('key_answer,kept', [('4', True), ('"4"', True), ('5', False)])
def test_local_answers_and_key_must_agree(key_answer, kept):
    candidates = [ParsedQuestion.model_validate({**question(stem), 'answerPayload': {'text': answer}})
                  for stem, answer in [('Printed?', '4'), ('Other?', '5')]]
    text = f'1. Printed?\nAnswer: 4\n2. Other?\nAnswer: 5\nAnswers:\n1. {key_answer}\n2. 5'
    changes = retain_source_answers(candidates, text, [])
    assert changes == ([] if kept else [(0, ['answerPayload'])])
    assert candidates[0].model_dump()['answerPayload'] == ({'text': '4'} if kept else None)
    assert candidates[1].model_dump()['answerPayload'] == {'text': '5'}


@pytest.mark.parametrize('key_analysis,kept', [('Printed explanation.', True), ('Different explanation.', False)])
def test_local_and_key_analysis_agreement_is_checked_independently(key_analysis, kept):
    candidate = ParsedQuestion.model_validate({**question('Printed?'), 'answerPayload': {'text': '4'}, 'analysis': 'Printed explanation.'})
    text = '1. Printed?\nAnswer: 4\nAnalysis: Printed explanation.'
    context = f'Answers:\n1. Answer: 4\nAnalysis: {key_analysis}'
    assert retain_source_answers([candidate], text, [context]) == ([] if kept else [(0, ['analysis'])])
    assert candidate.model_dump()['answerPayload'] == {'text': '4'}
    assert candidate.analysis == ('Printed explanation.' if kept else None)


@pytest.mark.parametrize('label', ['Answer', '答案'])
@pytest.mark.parametrize('value', ['4', '3.00', '1e-3', '-0'])
@pytest.mark.parametrize('newline', ['\n', '\r\n'])
def test_multiline_local_answers_are_not_numbered_answer_keys(label, value, newline):
    candidate = ParsedQuestion.model_validate({**question('Printed?'), 'answerPayload': {'text': value}})
    assert retain_source_answers([candidate], f'1. Printed?{newline}{label}:{newline}{value}', []) == []
    assert candidate.model_dump()['answerPayload'] == {'text': value}


@pytest.mark.parametrize('prefix', ['', 'Single choice: '])
@pytest.mark.parametrize('separator', ['. ', ') ', '．'])
def test_unnumbered_choice_identity_excludes_its_verified_option_lines(prefix, separator):
    candidate = ParsedQuestion.model_validate({**question('Printed?'), 'answerMode': 'choice', 'choiceVariant': 'single',
        'options': [{'label': 'A', 'content': 'Four'}, {'label': 'B', 'content': 'Five'}], 'answerPayload': {'correct': ['A']}})
    text = f'{prefix}Printed?\nA{separator}Four\nB{separator}Five\nAnswer: A'
    assert retain_source_answers([candidate], text, []) == []
    assert candidate.model_dump()['answerPayload'] == {'correct': ['A']}


@pytest.mark.parametrize('extra', ['Other?', 'A. Unverified option content'])
def test_unnumbered_choice_cannot_hide_other_stems_or_unverified_options(extra):
    candidate = ParsedQuestion.model_validate({**question('Printed?'), 'answerMode': 'choice', 'choiceVariant': 'single',
        'options': [{'label': 'A', 'content': 'Four'}, {'label': 'B', 'content': 'Five'}], 'answerPayload': {'correct': ['A']}})
    text = f'Printed?\nA. Four\nB. Five\n{extra}\nAnswer: A'
    assert retain_source_answers([candidate], text, []) == [(0, ['answerPayload'])]
    assert candidate.answerPayload is None and candidate.needsReview


@pytest.mark.parametrize('printed,answer,kept', [
    ('A', ['A'], True), ('AB', ['A', 'B'], True), ('A、B', ['A', 'B'], True),
    ('["A", "B"]', ['A', 'B'], True), ('B', ['A'], False), ('A or B', ['A'], False),
    ('B,A', ['A', 'B'], True), ('a', ['A'], True),
])
def test_choice_labels_require_printed_answer_evidence(printed, answer, kept):
    candidate = ParsedQuestion.model_validate({**question('Choose?'), 'answerMode': 'choice', 'choiceVariant': 'multiple',
        'options': [{'label': label, 'content': label} for label in ['A', 'B']], 'answerPayload': {'correct': answer}})
    changes = retain_source_answers([candidate], f'1. Choose?\nA. A\nB. B\nAnswer: {printed}', [])
    assert bool(changes) != kept
    assert (candidate.answerPayload is not None) == kept


@pytest.mark.parametrize('mode,payload', [
    ('short_answer', {'text': None}), ('fill_blank', {'answers': None}),
    ('true_false', {'value': None}),
    ('ordering', {'order': None}), ('ordering', {'order': [0, None]}),
    ('matching', {'matches': None}), ('matching', {'matches': [None]}),
    ('matching', {'matches': [{'left': 0}]}),
])
def test_incomplete_answer_payloads_remain_reviewable_without_crashing(mode, payload):
    candidate = ParsedQuestion.model_validate({**question('Printed?'), 'answerMode': mode,
        'answerPayload': payload, **({'blankCount': 1} if mode == 'fill_blank' else {})})
    retain_source_answers([candidate], '1. Printed?\nAnswer: supplied', [])
    assert candidate.answerPayload is None and candidate.needsReview


def test_verified_table_fields_are_scoped_to_the_matching_row():
    text = 'id\tstem\treference_answer\tevidence\n1\tFirst?\t4\t{"analysis":"printed"}\n2\tSecond?\t\t{}'
    candidates = [ParsedQuestion.model_validate({**question(stem), 'id': f'fragment:1:{index}',
                    'answerPayload': {'text': '4'}, 'analysis': 'printed'})
                  for index, stem in enumerate(['First?', 'Second?'], 1)]
    assert retain_source_answers(candidates, text, []) == [(1, ['answerPayload', 'analysis'])]
    assert candidates[0].analysis == 'printed' and candidates[1].analysis is None


def test_ambiguous_keys_and_changed_word_boundaries_are_not_proofs():
    candidate = ParsedQuestion.model_validate({**question('Printed?'), 'answerPayload': {'text': 'notable'}, 'analysis': 'notable'})
    assert retain_source_answers([candidate], '1. Printed?\nAnalysis: not able', ['Answers:\n1. notable', 'Answers:\n1. notable']) == [(0, ['answerPayload', 'analysis'])]


def test_unnumbered_questions_cannot_borrow_a_later_questions_answer():
    candidates = [ParsedQuestion.model_validate({**question(stem), 'answerPayload': {'text': '4'}}) for stem in ['First?', 'Second?']]
    assert retain_source_answers(candidates, 'First?\nSecond?\nAnswer: 4', []) == [(0, ['answerPayload']), (1, ['answerPayload'])]


def test_same_source_chinese_answer_key_is_not_an_empty_local_answer():
    candidate = ParsedQuestion.model_validate({**question('Printed?'), 'answerPayload': {'text': '4'}})
    assert retain_source_answers([candidate], '1. Printed?\n答案：\n1. 4', []) == []


def test_answer_key_cannot_resolve_reused_question_numbers_across_sections():
    candidates = [ParsedQuestion.model_validate({**question(stem), 'answerPayload': {'text': '4'}}) for stem in ['First?', 'Second?']]
    text = 'Section A\n1. First?\nSection B\n1. Second?'
    assert retain_source_answers(candidates, text, ['Answers:\n1. 4']) == [(0, ['answerPayload']), (1, ['answerPayload'])]


@pytest.mark.parametrize('visual', [False, True])
async def test_actual_import_clears_guesses_and_exports_review_flags(monkeypatch, visual):
    text = '1. Short answer: What is 2 + 2?\n2. Short answer: What is 3 + 3?\nReference answer: 6\nAnalysis: Three plus three.'
    guesses = [{**question(stem), 'id': f'{"page" if visual else "fragment"}:1:{index}',
                'sourceText': f'{stem}\nAnswer: {answer}\nAnalysis: {analysis}',
                'answerPayload': {'text': answer}, 'analysis': analysis}
               for index, (stem, answer, analysis) in enumerate([
                   ('What is 2 + 2?', '4', 'Two plus two.'), ('What is 3 + 3?', '6', 'Three plus three.'),
               ], 1)]
    files, reference = source(text)
    if visual:
        from practiq_ai.extractors import ExtractedDocument

        reference.update(sourceType='pdf', mediaType='application/pdf')
        old_key = reference['objectKey']
        reference['objectKey'] = document_source_key('pdf', reference['sha256'])
        files.blobs[reference['objectKey']] = files.blobs.pop(old_key)
        monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(text='', page_images=[make_image()])))
    tencent_provider(monkeypatch, [ocr_text_page(text)] if visual else None)
    model = FakeModel(responses=[{'questions': guesses, **({'figures': []} if visual else {})}])
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    result = await local_graph(store=MemoryStore()).ainvoke({'document': reference}, run_config())
    assert result['status'] == 'SUCCEEDED'
    kept = result['result']['questions']
    assert len(kept) == 2
    assert kept[0]['stem'] == 'What is 2 + 2?'
    assert kept[0]['answerPayload'] is None and kept[0]['analysis'] is None and kept[0]['needsReview']
    assert {'answerPayload', 'analysis'} <= set(kept[0]['missingFields'])
    assert kept[1]['answerPayload'] == {'text': '6'} and kept[1]['analysis'] == 'Three plus three.'
    assert result['processing']['quality']['reviewRequired']
    assert any('removed unverified answerPayload, analysis' in warning for warning in result['result']['warnings'])
    assert len(model.calls) == len(result['usage']) == 1


async def test_resumed_merge_also_sanitizes_stored_unit_results(monkeypatch):
    text = '1. Printed question?'
    files, reference = source(text)
    artifact = await files.put_artifact(text.encode(), source_sha256=reference['sha256'], kind='text', index=0, media_type='text/plain')
    parsed = {'questions': [{**question('Printed question?'), 'id': 'fragment:1:1', 'answerPayload': {'text': 'guessed'}, 'analysis': 'invented'}]}
    unit = await files.put_artifact(json.dumps({'parsed': parsed}).encode(), source_sha256=reference['sha256'],
                                  kind='unit-result', index=0, media_type='application/json')
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: pytest.fail('merge must be passive'))
    result = await document._merge(cast(document.DocumentState, {
        'document': reference, 'textRef': artifact.model_dump(),
        'chunkResults': [{'index': 0, 'parsed': {}, 'resultRef': unit.model_dump()}],
    }), passive=True)
    kept = result['result']['questions'][0]
    assert kept['answerPayload'] is None and kept['analysis'] is None and kept['needsReview']
    assert len(result['result']['questions']) == 1


async def test_text_ocr_cannot_add_answer_evidence_missing_from_original(monkeypatch):
    text = '1. Printed question?'
    files, reference = source(text)
    tencent_provider(monkeypatch, [ocr_text_page(text + '\nAnswer: 4\nAnalysis: invented')])
    model = FakeModel(responses=[{'questions': [{**question('Printed question?'), 'id': 'page:1:1',
        'answerPayload': {'text': '4'}, 'analysis': 'invented'}], 'figures': []}])
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    result = await local_graph(store=MemoryStore()).ainvoke({'document': reference}, run_config())
    kept = result['result']['questions'][0]
    assert kept['answerPayload'] is None and kept['analysis'] is None and kept['needsReview']
    assert len(model.calls) == len(result['usage']) == 1


@pytest.mark.parametrize('prefix', ['', '1. ', 'Short answer: ', '1. Short answer: '])
async def test_native_table_merge_retains_supplied_answers_and_clears_answerless_rows(monkeypatch, prefix):
    files, reference = source('synthetic table source')
    old_key = reference['objectKey']
    reference.update(sourceType='xlsx', mediaType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                     objectKey=document_source_key('xlsx', reference['sha256']))
    files.blobs[reference['objectKey']] = files.blobs.pop(old_key)
    layout = f'<table><tr><td>题目</td><td>答案</td><td>解析</td></tr><tr><td>{prefix}First?</td><td>4</td><td>printed</td></tr><tr><td>Second?</td><td></td><td></td></tr></table>'
    ocr = await files.put_artifact(json.dumps({'format': 'table', 'elements': [{'layout_xml': layout}]}).encode(),
        source_sha256=reference['sha256'], kind='ocr-page', index=0, media_type='application/json')
    parsed = {'questions': [{**question(stem), 'id': f'page:1:{index}', 'answerPayload': {'text': '4'}, 'analysis': 'printed'}
                            for index, stem in enumerate(['First?', 'Second?'], 1)]}
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    result = await document._merge(cast(document.DocumentState, {
        'document': reference, 'pageRefs': [ocr.model_dump()], 'ocrPageRefs': [ocr.model_dump()], 'visualTotal': 1,
        'visionResults': [{'index': 0, 'kind': 'page', 'artifact': ocr.model_dump(), 'parsed': parsed, 'visuals': []}],
    }), passive=True)
    kept = result['result']['questions']
    assert kept[0]['answerPayload'] == {'text': '4'} and kept[0]['analysis'] == 'printed'
    assert kept[1]['answerPayload'] is None and kept[1]['analysis'] is None and kept[1]['needsReview']


async def test_answer_key_proof_never_crosses_a_failed_ocr_page(monkeypatch):
    files, reference = source('synthetic PDF source')
    pages = [ocr_text_page('Answers:\n1. 4'), {'failed': True}, ocr_text_page('1. Printed?')]
    refs = [(await files.put_artifact(json.dumps(page).encode(), source_sha256=reference['sha256'],
             kind='ocr-page', index=index, media_type='application/json')).model_dump() for index, page in enumerate(pages)]
    # This is a visual source: its original bytes cannot prove textual answers.
    reference.update(sourceType='pdf', mediaType='application/pdf')
    parsed = {'questions': [{**question('Printed?'), 'id': 'page:3:1', 'answerPayload': {'text': '4'}}]}
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    result = await document._merge(cast(document.DocumentState, {
        'document': reference, 'pageRefs': refs, 'ocrPageRefs': refs, 'visualTotal': 1,
        'visionResults': [{'index': 2, 'kind': 'page', 'artifact': refs[2], 'parsed': parsed, 'visuals': []}],
    }), passive=True)
    kept = result['result']['questions'][0]
    assert kept['answerPayload'] is None and kept['needsReview']


async def test_resumed_tabular_fragments_restore_source_headers_before_proof(monkeypatch):
    files, reference = source('synthetic workbook source')
    old_key = reference['objectKey']
    reference.update(sourceType='xlsx', mediaType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                     objectKey=document_source_key('xlsx', reference['sha256']))
    files.blobs[reference['objectKey']] = files.blobs.pop(old_key)
    header = 'id\troot_task\tparent_id\toption_owner\tstem\tquestion_type\treference_answer\tevidence'
    rows = [f'{index}\t{index}\t\t\tQ{index}\tShort answer\tA{index}\t'
            + json.dumps({'analysis': f'Printed explanation {index}'}) for index in range(1, 18)]
    text = header + '\n' + '\n'.join(rows)
    text_ref = await files.put_artifact(text.encode(), source_sha256=reference['sha256'], kind='text', index=0, media_type='text/plain')
    units = [{'start': 0, 'end': len(text), 'fileName': 'Sheet1.csv', 'sourceType': 'csv', 'sourceIndex': 0, 'tabularRowsSafe': True}]
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: pytest.fail('resumed merge must be passive'))
    prepared = await document._assemble(cast(document.DocumentState, {'document': reference, 'textRef': text_ref.model_dump(), 'textUnits': units}))
    assert prepared['chunkHeaders'] == [None, header] and prepared['chunkNodeCounts'] == [16, 1]
    chunks = [{'index': unit, 'parsed': {'questions': [
        {**question(f'Q{index}'), 'id': f'fragment:{unit + 1}:{index}', 'sourceText': rows[index - 1],
         'answerPayload': {'text': f'A{index}'}, 'analysis': f'Printed explanation {index}'}
        for index in indexes]}} for unit, indexes in enumerate([range(1, 17), range(17, 18)])]
    result = await document._merge(cast(document.DocumentState, {
        'document': reference, 'textRef': text_ref.model_dump(), 'textUnits': units,
        'tabularRowsSafe': True, 'effectiveSourceType': 'csv', **prepared, 'chunkResults': chunks,
    }), passive=True)
    kept = result['result']['questions']
    assert len(kept) == 17
    for index, candidate in enumerate(kept, 1):
        assert candidate['answerPayload'] == {'text': f'A{index}'}
        assert candidate['analysis'] == f'Printed explanation {index}'
