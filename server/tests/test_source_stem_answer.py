import hashlib
from typing import cast
from uuid import uuid4

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.runtime import Runtime
from langgraph.types import Command
from pydantic import ValidationError

from practiq_ai import execution, llm
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document
from tests.support import (
    FakeModel,
    MemoryStore,
    local_graph,
    question,
    run_config,
    source,
    source_presence_hints,
)


@pytest.fixture(autouse=True)
def tencent_boundary(monkeypatch):
    from tests.support import tencent_provider
    return tencent_provider(monkeypatch)



def stem_hash(stem):
    return hashlib.sha256(stem.strip().encode()).hexdigest()


def validate(candidate, hints):
    token = document.EXPECTED_SOURCE_PRESENCE.set(cast(dict, hints))
    try:
        return document.ChunkParseResult.model_validate({'questions': candidate})
    finally:
        document.EXPECTED_SOURCE_PRESENCE.reset(token)


def test_known_typed_source_records_exact_stem_and_supplied_answer_presence():
    text = '1. Short answer: Keep Case, punctuation and ___.\nReference answer: supplied-answer-token'
    hints = source_presence_hints(text)
    assert hints is not None
    assert hints['1'].get('stem_sha256') == stem_hash('Keep Case, punctuation and ___.')
    assert hints['1'].get('need_answer') is True


async def test_conflicting_answer_retains_actual_source_without_paid_correction(monkeypatch):
    text = '1. Single choice: Printed stem\nA. One\nB. Two\nReference answer: B'
    candidate = {
        **question('Printed stem'), 'id': 'fragment:1:1', 'answerMode': 'choice',
        'choiceVariant': 'single', 'options': [{'label': 'A', 'content': 'One'}, {'label': 'B', 'content': 'Two'}],
        'answerPayload': {'correct': ['A']}, 'sourceText': text.replace('answer: B', 'answer: A'),
        'needsReview': False, 'analysis': 'Supplied explanation',
    }
    files, reference = source(text)
    model = FakeModel(responses=[{'questions': [candidate]}])
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    state = cast(document.ChunkTask, {
        'index': 0, 'total': 1, 'fileName': 'quiz.txt', 'sourceType': 'text',
        'artifact': {key: value for key, value in reference.items() if key not in {'sourceType', 'fileName'}},
        'sourcePresence': source_presence_hints(text),
    })
    result = await document._chunk(state, Runtime(store=MemoryStore()))
    parsed = result['chunkResults'][0]['parsed']
    assert parsed is not None
    kept = parsed['questions'][0]
    assert kept['answerPayload'] == {'correct': ['A']}
    assert kept['sourceText'] == text and kept['needsReview']
    assert len(model.calls) == len(result['usage']) == 1
    graph = local_graph(InMemorySaver(), store=MemoryStore())
    model.responses.append({'questions': [candidate]})
    completed = await graph.ainvoke({'document': reference}, run_config())
    assert completed['result']['questions'][0]['answerPayload'] is None
    assert completed['result']['questions'][0]['sourceText'] == text
    assert completed['result']['questions'][0]['needsReview']
    assert completed['processing']['quality']['reviewRequired']
    assert any('Answer/source conflict' in warning for warning in completed['result']['warnings'])
    assert len(model.calls) == 2


def test_known_source_rejects_paraphrased_stem():
    candidate = {**question('Reworded question'), 'id': 'fragment:1:1', 'answerPayload': {'text': 'A'}}
    hints = {'fragment:1:1': {'need_stem': True, 'stem_sha256': stem_hash('Original question')}}
    with pytest.raises(ValidationError, match='printed stem'):
        validate([candidate], hints)


@pytest.mark.parametrize('parsed_stem,accepted', [
    ('Keep Case, a  + b = ___.', True),
    ('  Keep Case, a  + b = ___.\n', True),
    ('keep Case, a  + b = ___.', False),
    ('Keep Case; a  + b = ___.', False),
    ('Keep Case, a + b = ___.', False),
    ('Keep Case, a  + b = __.', False),
])
def test_exact_stem_allows_outer_trim_and_preserves_inner_literal(parsed_stem, accepted):
    hints = {'fragment:1:1': {'need_stem': True, 'stem_sha256': stem_hash('Keep Case, a  + b = ___.')}}
    candidate = {**question(parsed_stem), 'id': 'fragment:1:1'}
    if accepted:
        assert validate([candidate], hints).questions[0].stem == parsed_stem.strip()
    else:
        with pytest.raises(ValidationError, match='printed stem'):
            validate([candidate], hints)


@pytest.mark.parametrize('answer', [None, {}])
def test_known_supplied_answer_cannot_be_omitted_or_empty_object(answer):
    candidate = {**question('Q'), 'id': 'fragment:1:1', 'answerPayload': answer}
    with pytest.raises(ValidationError, match='requires extracted answerPayload'):
        validate([candidate], {'fragment:1:1': {'need_answer': True}})


@pytest.mark.parametrize('mode,answer', [
    ('true_false', {'value': False}),
    ('short_answer', {'text': '0'}),
    ('short_answer', {'text': 'None'}),
    ('short_answer', {'text': None}),
])
def test_answer_presence_preserves_false_zero_literal_none_and_partial_answers(mode, answer):
    candidate = {**question('Q'), 'id': 'fragment:1:1', 'answerMode': mode, 'answerPayload': answer}
    parsed = validate([candidate], {'fragment:1:1': {'need_answer': True}})
    assert parsed.questions[0].answerPayload is not None


def csv_source(answer, *, status='supplied', kind='Short answer'):
    columns = ['id', 'root_task', 'question_type', 'stem', 'parent_id', 'option_owner', 'reference_answer']
    cells = ['1', 'root-1', kind, '  Printed stem  ', '', '', answer]
    if status is not None:
        columns.append('answer_status')
        cells.append(status)
    return '\t'.join(columns) + '\n' + '\t'.join(cells)


@pytest.mark.parametrize('answer,supplied', [
    ('', False), ('None', False), ('null', False), ('{}', False), ('[]', False), ('""', False),
    ('False', True), ('0', True), ('"None"', True), ('a supplied reference', True),
])
def test_safe_csv_answer_presence_distinguishes_absence_from_literal_values(answer, supplied):
    hints = source_presence_hints(csv_source(answer), source_type='csv', tabular_rows_safe=True)
    assert hints is not None
    assert hints['1'].get('stem_sha256') == stem_hash('Printed stem')
    assert bool(hints['1'].get('need_answer')) is supplied


@pytest.mark.parametrize('status,supplied', [(None, True), ('supplied', True), ('absent', False), ('unknown', False)])
def test_csv_optional_answer_status_must_confirm_supplied_when_present(status, supplied):
    hints = source_presence_hints(csv_source('reference', status=status), source_type='csv', tabular_rows_safe=True)
    assert hints is not None
    assert bool(hints['1'].get('need_answer')) is supplied


@pytest.mark.parametrize('body,supplied', [
    ('Reference answer: False', True),
    ('Reference answer: 0', True),
    ('Reference answer: "None"', True),
    ('Reference answer:', False),
    ('Reference answer: None', False),
    ('Reference answer: null', False),
    ('Reference answer: []', False),
    ('Answer: A', False),
    ('Reference answer: A\nReference answer: B', False),
    ('Reference answer: A\nAnswer: B', False),
    ('Reference answer: A\nSupplied answer: B', False),
    ('Reference answer: A\nAnswer status: absent', False),
])
def test_txt_answer_presence_uses_only_unique_unambiguous_reference_line(body, supplied):
    hints = source_presence_hints('1. Short answer: Printed stem\n' + body)
    assert hints is not None
    assert bool(hints['1'].get('need_answer')) is supplied


@pytest.mark.parametrize('text', [
    '1. Short answer: First line\nAn unlabelled continuation of the stem\nReference answer: A',
    '1. Short answer: Stem Reference answer: A\nReference answer: A',
    '1. Short answer: Stem No reference answer is supplied for this question.\nReference answer: A',
    '1. Short answer: Stem\nAn arbitrary body line\nReference answer: A',
])
def test_unknown_body_or_inline_local_field_cannot_enable_exact_or_answer_gate(text):
    hints = source_presence_hints(text)
    assert hints is None or (not hints['1'].get('stem_sha256') and not hints['1'].get('need_answer'))


@pytest.mark.parametrize('label', ['答案', '参考答案', '正确答案', '标准答案', '答案解析', '解析', '解答',
                                   '分析', '评分标准', '评分细则', 'answer', 'Analysis', 'Reference answer'])
@pytest.mark.parametrize('colon', [':', '：'])
def test_inline_answer_and_analysis_labels_disable_exact_stem_hash(label, colon):
    hints = source_presence_hints(f'1. Short answer: What is 2+2? {label}{colon} 4')
    assert hints is not None and hints['1']['need_stem']
    assert not hints['1'].get('stem_sha256') and not hints['1'].get('need_answer')
    candidate = {**question('What is 2+2?'), 'id': '1', 'answerPayload': {'text': '4'}}
    assert validate([candidate], hints).questions[0].stem == 'What is 2+2?'


@pytest.mark.parametrize('label', ['答案', '解析'])
async def test_inline_chinese_evidence_is_separated_without_correction_calls(monkeypatch, label):
    text = f'1. Short answer: What is 2+2? {label}：4'
    complete = {**question('What is 2+2?'), 'id': 'fragment:1:1', 'sourceText': text,
                'answerPayload': {'text': '4'} if label == '答案' else None,
                'analysis': '4' if label == '解析' else None}
    files, reference = source(text)
    model = FakeModel(responses=[{'questions': [complete]}])
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    state = cast(document.ChunkTask, {
        'index': 0, 'total': 1, 'fileName': 'quiz.txt', 'sourceType': 'text',
        'artifact': {key: value for key, value in reference.items() if key not in {'sourceType', 'fileName'}},
        'sourcePresence': source_presence_hints(text),
    })
    result = await document._chunk(state, Runtime(store=MemoryStore()))
    kept = result['chunkResults'][0]['parsed']['questions'][0]
    assert kept['stem'] == 'What is 2+2?'
    assert kept['answerPayload'] == complete['answerPayload'] and kept['analysis'] == complete['analysis']
    assert len(model.calls) == len(result['usage']) == 1


@pytest.mark.parametrize('kind', ['Reading comprehension', 'Listening'])
def test_composite_parent_has_no_answer_requirement_but_supplied_child_does(kind):
    text = (
        f'1. {kind}: Complete printed parent\nReference answer: Parent note\n'
        '2. Short answer: Printed leaf\nParent ID: 1.\nReference answer: leaf reference'
    )
    hints = source_presence_hints(text)
    assert hints is not None
    assert hints['1'].get('stem_sha256') == stem_hash('Complete printed parent')
    assert not hints['1'].get('need_answer') and hints['2'].get('need_answer') is True


def test_presence_validation_reports_all_known_failures_for_both_records():
    hints = {f'fragment:1:{index}': {
        'need_stem': True, 'need_options': True, 'need_analysis': True, 'need_answer': True,
        'stem_sha256': stem_hash(f'Original {index}'),
    } for index in (1, 2)}
    candidates = [{
        **question('Changed stem' if index == 1 else 'Identifiable source'),
        'id': f'fragment:1:{index}', 'stem': 'Changed stem' if index == 1 else None,
        'answerMode': 'choice', 'choiceVariant': 'single', 'options': [], 'analysis': None, 'answerPayload': None,
    } for index in (1, 2)]
    with pytest.raises(ValidationError) as caught:
        validate(candidates, hints)
    message = caught.value.errors()[0]['msg']
    assert 'Source record fragment:1:1 must preserve the complete printed stem' in message
    assert 'Source record fragment:1:2 requires extracted stem' in message
    for identifier in hints:
        for field in ('options', 'analysis', 'answerPayload'):
            assert f'Source record {identifier} requires extracted {field}' in message


@pytest.mark.parametrize('omitted', ['stem', 'answerPayload'])
async def test_literal_or_answer_omission_is_corrected_without_losing_attempt_usage(monkeypatch, omitted):
    text = '1. Short answer: Printed stem\nReference answer: supplied reference'
    complete = {**question('Printed stem'), 'id': 'fragment:1:1', 'sourceText': text,
                'answerPayload': {'text': 'supplied reference'}}
    incomplete = {**complete, omitted: 'Paraphrased stem' if omitted == 'stem' else None}
    files, reference = source(text)
    model = FakeModel(responses=[{'questions': [incomplete]}, {'questions': [complete]}])
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    state = cast(document.ChunkTask, {
        'index': 0, 'total': 1, 'fileName': 'quiz.txt', 'sourceType': 'text',
        'artifact': {key: value for key, value in reference.items() if key not in {'sourceType', 'fileName'}},
        'sourcePresence': source_presence_hints(text),
    })
    result = await document._chunk(state, Runtime(store=MemoryStore()))
    assert result['chunkResults'][0]['parsed']['questions'][0][omitted] == complete[omitted]
    assert len(model.calls) == len(result['usage']) == 2
    assert [(item['inputTokens'], item['outputTokens']) for item in result['usage']] == [(10, 5), (10, 5)]
    assert document.EXPECTED_SOURCE_PRESENCE.get() is None


async def test_hint_prompt_contains_field_names_but_neither_stem_hash_nor_answer(monkeypatch):
    text = '1. Short answer: source-stem-marker\nReference answer: source-answer-marker'
    hints = source_presence_hints(text)
    assert hints is not None and hints['1'].get('stem_sha256') and hints['1'].get('need_answer')
    files, reference = source(text)
    model = FakeModel(responses=[{'questions': [{
        **question('source-stem-marker'), 'id': 'fragment:1:1', 'sourceText': text,
        'answerPayload': {'text': 'source-answer-marker'},
    }]}])
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    state = cast(document.ChunkTask, {
        'index': 0, 'total': 1, 'fileName': 'quiz.txt', 'sourceType': 'text',
        'artifact': {key: value for key, value in reference.items() if key not in {'sourceType', 'fileName'}},
        'sourcePresence': hints,
    })
    await document._chunk(state, Runtime(store=MemoryStore()))
    prompt = cast(str, model.calls[0][1].content)
    assert prompt.endswith(text)
    context = prompt[:-len(text)]
    assert 'fragment:1:1' in context and 'stem' in context and 'answerPayload' in context
    assert all(value not in context for value in ('source-stem-marker', 'source-answer-marker', 'stem_sha256', stem_hash('source-stem-marker')))


@pytest.mark.parametrize('pause', [False, True])
async def test_two_source_records_are_corrected_together_with_one_additional_call(monkeypatch, pause):
    printed = [
        '1. Short answer: Printed first stem exactly.\nReference answer: first reference',
        '2. Short answer: Printed second stem exactly.\nReference answer: second reference',
    ]
    text = '\n'.join(printed)
    complete = [{
        **question(stem), 'id': f'fragment:1:{index}', 'sourceText': printed[index - 1],
        'answerPayload': {'text': answer},
    } for index, (stem, answer) in enumerate([
        ('Printed first stem exactly.', 'first reference'),
        ('Printed second stem exactly.', 'second reference'),
    ], 1)]
    incomplete = [{**candidate, 'stem': f'Short stem {index}', 'answerPayload': None}
                  for index, candidate in enumerate(complete, 1)]
    observed = []

    def response(questions):
        presence = document.EXPECTED_SOURCE_PRESENCE.get()
        assert presence is not None
        observed.append(set(presence))
        return {'questions': questions}

    async def extract(_kind, _payload):
        return ExtractedDocument(text=text)

    files, reference = source(text)
    model = FakeModel(responses=[lambda *_args: response(incomplete), lambda *_args: response(complete)])
    store = MemoryStore()
    monkeypatch.setattr(document, 'extract', extract)
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    graph = local_graph(InMemorySaver(), store=store)
    config = run_config()
    if pause:
        original, first = llm.structured_attempt, True

        async def attempt(*args, **kwargs):
            nonlocal first
            result = await original(*args, **kwargs)
            if first:
                first = False
                await store.aput(execution.namespace('thread-1', 'pause'), str(config.get('run_id')), {'requested': True})
            return result

        monkeypatch.setattr(llm, 'structured_attempt', attempt)
    result = await graph.ainvoke({'document': reference}, config)
    if pause:
        assert result['__interrupt__'] and len(model.calls) == 1
        checkpoint = (await graph.aget_state(config)).values
        assert len(checkpoint['chunkPresence']) == 1
        for index, candidate in enumerate(complete, 1):
            hints = checkpoint['chunkPresence'][0][str(index)]
            assert hints['need_answer'] is True and hints['stem_sha256'] == stem_hash(candidate['stem'])
        assert document.EXPECTED_SOURCE_PRESENCE.get() is None
        result = await graph.ainvoke(
            Command(resume={item.id: {'action': 'resume'} for item in result['__interrupt__']}),
            {**config, 'run_id': uuid4()},
        )
    assert result['status'] == 'SUCCEEDED' and len(model.calls) == 2
    assert [candidate['stem'] for candidate in result['result']['questions']] == [candidate['stem'] for candidate in complete]
    assert [candidate['answerPayload'] for candidate in result['result']['questions']] == [candidate['answerPayload'] for candidate in complete]
    feedback = model.calls[1][-1].text
    for identifier in ('fragment:1:1', 'fragment:1:2'):
        assert f'Source record {identifier} must preserve the complete printed stem' in feedback
        assert f'Source record {identifier} requires extracted answerPayload' in feedback
    assert observed == [{'fragment:1:1', 'fragment:1:2'}] * 2
    state = (await graph.aget_state(config)).values
    assert [(usage['inputTokens'], usage['outputTokens']) for usage in state['usage']] == [(10, 5), (10, 5)]
    records = await store.asearch(execution.namespace('thread-1', 'calls'))
    assert len(records) == 2 and {item.value['validation'] for item in records} == {'failed', 'passed'}
    assert all(item.value['durableResult'] and item.value['usageStatus'] == 'known' for item in records)
    assert document.EXPECTED_SOURCE_PRESENCE.get() is None
