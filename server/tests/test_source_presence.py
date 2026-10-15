import asyncio
from copy import deepcopy
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
from practiq_ai.graphs.chunking import SourcePresenceHint, source_presence_hints
from tests.support import (
    FakeModel,
    MemoryStore,
    local_graph,
    question,
    run_config,
    source,
)

SOURCE = (
    '1. Single choice: source-stem-token\n'
    'A. source-option-token-a\nB. source-option-token-b\n'
    'Answer: A\nAnalysis: source-analysis-token'
)
PRESENCE: SourcePresenceHint = {'need_stem': True, 'need_options': True, 'need_analysis': True}


def complete_question():
    return {
        **question('source-stem-token'),
        'id': 'fragment:1:1', 'sourceText': SOURCE,
        'answerMode': 'choice', 'questionTypeId': 'Single choice', 'choiceVariant': 'single',
        'options': [{'label': 'A', 'content': 'source-option-token-a'},
                    {'label': 'B', 'content': 'source-option-token-b'}],
        'answerPayload': {'correct': ['A']}, 'analysis': 'source-analysis-token',
    }


def chunk_task(reference, presence, *, index=0):
    return cast(document.ChunkTask, {
        'index': index, 'total': 2, 'fileName': 'quiz.txt', 'sourceType': 'text',
        'artifact': {key: value for key, value in reference.items() if key not in {'sourceType', 'fileName'}},
        'sourcePresence': presence,
    })


@pytest.fixture
def presence_graph(monkeypatch):
    async def extract(_kind, _payload):
        return ExtractedDocument(text=SOURCE)

    monkeypatch.setattr(document, 'extract', extract)

    def build(responses):
        files, reference = source(SOURCE)
        model, store = FakeModel(responses=responses), MemoryStore()
        monkeypatch.setattr(document, 'get_object_store', lambda: files)
        monkeypatch.setattr(document, 'get_model', lambda: model)
        return local_graph(InMemorySaver(), store=store), store, model, reference

    return build


@pytest.mark.parametrize('field', ['stem', 'options', 'analysis'])
async def test_present_source_field_omission_is_corrected_and_both_calls_are_recorded(presence_graph, field):
    complete = complete_question()
    incomplete = deepcopy(complete)
    incomplete[field] = [] if field == 'options' else None
    if field == 'options':
        incomplete['answerPayload'] = None
    graph, store, model, reference = presence_graph([
        {'questions': [incomplete]}, {'questions': [complete]},
    ])
    config = run_config()
    result = await graph.ainvoke({'document': reference}, config)
    assert result['status'] == 'SUCCEEDED'
    assert result['result']['questions'][0][field] == complete[field]
    assert len(model.calls) == 2 and field in model.calls[1][-1].text
    state = (await graph.aget_state(config)).values
    assert [(item['inputTokens'], item['outputTokens']) for item in state['usage']] == [(10, 5), (10, 5)]
    records = await store.asearch(execution.namespace('thread-1', 'calls'))
    assert len(records) == 2
    assert {item.value['validation'] for item in records} == {'failed', 'passed'}
    assert all(item.value['durableResult'] and item.value['usageStatus'] == 'known' for item in records)
    assert document.EXPECTED_SOURCE_PRESENCE.get() is None


@pytest.mark.parametrize('content', [None, '', ' \t\n'])
async def test_present_source_options_require_nonempty_content_and_keep_failed_usage(presence_graph, content):
    complete = complete_question()
    empty_options = deepcopy(complete)
    empty_options['options'] = [{'label': label, 'content': content} for label in 'ABCD']
    graph, store, model, reference = presence_graph([
        {'questions': [empty_options]}, {'questions': [complete]},
    ])
    result = await graph.ainvoke({'document': reference}, run_config())
    assert result['status'] == 'SUCCEEDED'
    assert result['result']['questions'][0]['options'] == complete['options']
    assert len(model.calls) == 2 and 'options' in model.calls[1][-1].text
    records = await store.asearch(execution.namespace('thread-1', 'calls'))
    assert {item.value['validation'] for item in records} == {'failed', 'passed'}
    assert len(records) == 2 and all(item.value['durableResult'] and item.value['usageStatus'] == 'known' for item in records)
    assert document.EXPECTED_SOURCE_PRESENCE.get() is None


@pytest.mark.parametrize('field', ['stem', 'analysis'])
def test_known_source_whitespace_fields_do_not_count_as_present(field):
    token = document.EXPECTED_SOURCE_PRESENCE.set({'fragment:1:1': PRESENCE})
    try:
        candidate = complete_question()
        candidate[field] = ' \t\n'
        with pytest.raises(ValidationError, match=f'requires extracted {field}'):
            document.ChunkParseResult.model_validate({'questions': [candidate]})
    finally:
        document.EXPECTED_SOURCE_PRESENCE.reset(token)


def test_known_source_requires_content_in_every_local_option():
    token = document.EXPECTED_SOURCE_PRESENCE.set({'fragment:1:1': PRESENCE})
    try:
        candidate = complete_question()
        candidate['options'][1]['content'] = ' \t'
        with pytest.raises(ValidationError, match='requires extracted options'):
            document.ChunkParseResult.model_validate({'questions': [candidate]})
    finally:
        document.EXPECTED_SOURCE_PRESENCE.reset(token)


@pytest.mark.parametrize('identifier', [None, 'fragment:1:2'])
def test_known_source_requires_exact_record_ids(identifier):
    token = document.EXPECTED_SOURCE_PRESENCE.set({'fragment:1:1': PRESENCE})
    try:
        candidate = complete_question()
        candidate['id'] = identifier
        with pytest.raises(ValidationError, match='Question IDs must match'):
            document.ChunkParseResult.model_validate({'questions': [candidate]})
    finally:
        document.EXPECTED_SOURCE_PRESENCE.reset(token)


async def test_shared_option_child_keeps_empty_local_options(monkeypatch):
    text = (
        '1. Word bank: Complete the passage\nMaterial: [blank:2]\nA. red\nB. blue\n'
        '2. Single choice: Blank two\nParent ID: 1. Shared option owner: 1.\nA. red\nB. blue'
    )
    presence = source_presence_hints(text)
    assert presence is not None and presence['1']['need_options'] and not presence['2']['need_options']
    root_id, child_id = 'fragment:1:1', 'fragment:1:2'
    parent = {
        **question('Complete the passage'), 'id': root_id, 'answerMode': 'word_bank',
        'options': [{'label': 'A', 'content': 'red'}, {'label': 'B', 'content': 'blue'}],
        'passage': [{'partType': 'blank', 'questionId': child_id}],
    }
    child = {
        **question('Blank two'), 'id': child_id, 'parentId': root_id, 'optionSourceId': root_id,
        'answerMode': 'choice', 'choiceVariant': 'single', 'options': [], 'answerPayload': {'correct': ['A']},
    }
    files, reference = source(text)
    model = FakeModel(responses=[{'questions': [parent, child]}])
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    result = await document._chunk(chunk_task(reference, presence), Runtime(store=MemoryStore()))
    assert result['chunkResults'][0]['parsed']['questions'][1]['options'] == []
    assert len(model.calls) == len(result['usage']) == 1
    assert document.EXPECTED_SOURCE_PRESENCE.get() is None


def test_unknown_source_keeps_incomplete_draft_available():
    assert document.EXPECTED_SOURCE_PRESENCE.get() is None
    draft = {**question('Printed but incomplete'), 'stem': None, 'options': [], 'analysis': None}
    parsed = document.ChunkParseResult.model_validate({'questions': [draft]})
    assert parsed.questions[0].stem is None and parsed.questions[0].needsReview


def test_source_option_with_missing_content_remains_an_incomplete_draft():
    text = SOURCE + '\nC.'
    hints = source_presence_hints(text)
    assert hints is not None and not hints['1']['need_options']
    token = document.EXPECTED_SOURCE_PRESENCE.set({'fragment:1:1': hints['1']})
    try:
        candidate = complete_question()
        candidate['options'].append({'label': 'C', 'content': None})
        parsed = document.ChunkParseResult.model_validate({'questions': [candidate]})
        assert parsed.questions[0].options[2].content is None and parsed.questions[0].needsReview
    finally:
        document.EXPECTED_SOURCE_PRESENCE.reset(token)


async def test_presence_is_isolated_between_chunks_and_restored_after_error(monkeypatch):
    files, reference = source('source')
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: object())
    observed, restored = [], []
    sentinel: dict[str, SourcePresenceHint] = {
        'fragment:99:1': {'need_stem': False, 'need_options': False, 'need_analysis': False},
    }
    token = document.EXPECTED_SOURCE_PRESENCE.set(sentinel)

    async def parse(_model, _messages, schema, _kind, **_kwargs):
        before = document.EXPECTED_SOURCE_PRESENCE.get()
        await asyncio.sleep(0)
        assert document.EXPECTED_SOURCE_PRESENCE.get() == before
        observed.append(before)
        if before == {'fragment:2:1': {'need_analysis': True}}:
            raise RuntimeError('controlled interruption')
        return schema.model_validate({'questions': [{**question('Q'), 'id': 'fragment:1:1'}]}), [], None

    async def run(task):
        try:
            return await document._chunk(task, Runtime())
        finally:
            restored.append(document.EXPECTED_SOURCE_PRESENCE.get())

    monkeypatch.setattr(document, 'structured_call', parse)
    try:
        tasks = [chunk_task(reference, {'1': {'need_stem': True}}),
                 chunk_task(reference, {'1': {'need_analysis': True}}, index=1)]
        outcomes = await asyncio.gather(*(run(task) for task in tasks), return_exceptions=True)
        assert {'fragment:1:1': {'need_stem': True}} in observed
        assert {'fragment:2:1': {'need_analysis': True}} in observed
        assert isinstance(outcomes[1], RuntimeError)
        assert restored == [sentinel, sentinel] and document.EXPECTED_SOURCE_PRESENCE.get() == sentinel
    finally:
        document.EXPECTED_SOURCE_PRESENCE.reset(token)


@pytest.mark.parametrize('fail_review', [False, True])
async def test_review_preserves_presence_requirements_and_resets_after_failure(monkeypatch, fail_review):
    files, reference = source(SOURCE)
    model = FakeModel(responses=[{'questions': [complete_question()]}])
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setenv('AI_IMPORT_REVIEW', 'true')

    async def review(_model, _messages, parsed, schema, **_kwargs):
        assert document.EXPECTED_SOURCE_PRESENCE.get() == {'fragment:1:1': PRESENCE}
        incomplete = complete_question()
        incomplete['analysis'] = None
        with pytest.raises(ValidationError, match='requires extracted analysis'):
            schema.model_validate({'questions': [incomplete]})
        if fail_review:
            raise RuntimeError('controlled review failure')
        return parsed, [], None

    monkeypatch.setattr(document, 'review_extraction', review)
    if fail_review:
        with pytest.raises(RuntimeError, match='controlled review failure'):
            await document._chunk(chunk_task(reference, {'1': PRESENCE}), Runtime(store=MemoryStore()))
    else:
        result = await document._chunk(chunk_task(reference, {'1': PRESENCE}), Runtime(store=MemoryStore()))
        assert result['chunkResults'][0]['parsed']['questions'][0]['analysis'] == 'source-analysis-token'
    assert document.EXPECTED_SOURCE_PRESENCE.get() is None
    assert document.EXPECTED_NODE_COUNT.get() is None


async def test_presence_prompt_carries_ids_and_field_names_without_source_values(monkeypatch):
    files, reference = source(SOURCE)
    model = FakeModel(responses=[{'questions': [complete_question()]}])
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    await document._chunk(chunk_task(reference, {'1': PRESENCE}), Runtime(store=MemoryStore()))
    prompt = cast(str, model.calls[0][1].content)
    assert prompt.endswith(SOURCE)
    context = prompt[:-len(SOURCE)]
    assert 'fragment:1:1' in context and all(f'"{field}"' in context for field in ('stem', 'options', 'analysis'))
    assert all(value not in context for value in ('source-stem-token', 'source-option-token-a', 'source-analysis-token'))
    hints_by_id = source_presence_hints(SOURCE)
    assert hints_by_id is not None
    assert all(type(value) is bool for hints in hints_by_id.values() for name, value in hints.items() if name != 'stem_sha256')
    assert all(hints['stem_sha256'] not in context for hints in hints_by_id.values() if 'stem_sha256' in hints)


async def test_presence_correction_resume_reuses_first_attempt_and_usage(monkeypatch, presence_graph):
    incomplete = complete_question()
    incomplete['analysis'] = None
    graph, store, model, reference = presence_graph([
        {'questions': [incomplete]}, {'questions': [complete_question()]},
    ])
    original, config, first = llm.structured_attempt, run_config(), True

    async def attempt(*args, **kwargs):
        nonlocal first
        result = await original(*args, **kwargs)
        if first:
            first = False
            await store.aput(execution.namespace('thread-1', 'pause'), str(config.get('run_id')), {'requested': True})
        return result

    monkeypatch.setattr(llm, 'structured_attempt', attempt)
    paused = await graph.ainvoke({'document': reference}, config)
    assert paused['__interrupt__'] and len(model.calls) == 1
    assert document.EXPECTED_SOURCE_PRESENCE.get() is None
    resumed = await graph.ainvoke(
        Command(resume={item.id: {'action': 'resume'} for item in paused['__interrupt__']}),
        {**config, 'run_id': uuid4()},
    )
    assert resumed['status'] == 'SUCCEEDED' and len(model.calls) == 2
    assert 'requires extracted analysis' in model.calls[1][-1].text
    state = (await graph.aget_state(config)).values
    assert len(state['usage']) == 2 and len({item['callKey'] for item in state['usage']}) == 2
    records = await store.asearch(execution.namespace('thread-1', 'calls'))
    assert len(records) == 2 and all(item.value['durableResult'] for item in records)
    assert document.EXPECTED_SOURCE_PRESENCE.get() is None


def test_known_source_reports_all_missing_fields_in_one_correction():
    token = document.EXPECTED_SOURCE_PRESENCE.set({'fragment:1:1': PRESENCE})
    try:
        candidate = complete_question()
        candidate.update(stem=None, options=[], analysis=None, answerPayload=None)
        with pytest.raises(ValidationError) as error:
            document.ChunkParseResult.model_validate({'questions': [candidate]})
        feedback = str(error.value)
        assert all(f'requires extracted {field}' in feedback for field in ('stem', 'options', 'analysis'))
    finally:
        document.EXPECTED_SOURCE_PRESENCE.reset(token)
