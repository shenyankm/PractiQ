"""Opt-in answer generation never changes the source extraction path."""

from copy import deepcopy

import pytest
from pydantic import ValidationError

from practiq_ai.contracts import (
    DocumentParseInput,
    DocumentReference,
    DocumentTaskCreate,
    ParsedQuestion,
    document_source_key,
)
from practiq_ai.graphs import answer_generation as generation
from tests.support import upload


def question(**changes):
    return ParsedQuestion(id='q1', stem='What is 1 + 1?', answerMode='short_answer', questionTypeId='Short answer',
                          sourceText='1. What is 1 + 1?', **changes).model_dump(mode='json')


def state(**changes):
    return {'generateAnswers': True, 'result': {'schemaVersion': 3, 'questions': [question()], 'groups': [],
            'visualElements': [], 'warnings': [], 'missingFields': [], 'confidenceScore': 100},
            'processing': {'chunks': {'total': 1, 'succeeded': 1, 'skipped': 0},
                           'visuals': {'total': 0, 'succeeded': 0, 'skipped': 0}, 'truncated': False,
                           'failures': [], 'questionSources': [], 'quality': {'reviewRequired': True, 'reviewQuestionCount': 1, 'issues': []}},
            'status': 'SUCCEEDED', **changes}


def test_generation_contract_is_opt_in_and_strict():
    metadata = upload()
    assert metadata.sha256
    reference = DocumentReference.model_validate({**metadata.model_dump(), 'objectKey': document_source_key(metadata.sourceType, metadata.sha256)})
    assert not DocumentParseInput(document=reference).generateAnswers
    request = {'requestId': '00000000-0000-4000-8000-000000000000', 'document': reference}
    assert not DocumentTaskCreate.model_validate(request).generateAnswers
    assert DocumentTaskCreate.model_validate(request | {'generateAnswers': True}).generateAnswers
    with pytest.raises(ValidationError):
        DocumentTaskCreate.model_validate(request | {'generateAnswers': 'true'})


def test_generated_content_fills_only_missing_fields_and_requires_review():
    original = question(answerPayload={'text': '2'})
    candidate = generation.completed_question(original, {'answerPayload': {'text': 'wrong'}, 'analysis': '1 + 1 = 2.'})
    assert candidate['answerPayload'] == {'text': '2'}
    assert candidate['analysis'] == '1 + 1 = 2.' and candidate['needsReview']
    assert original['analysis'] is None


def test_invalid_answers_are_rejected_against_the_original_question():
    original = ParsedQuestion.model_validate({'id': 'q1', 'stem': 'Pick two', 'answerMode': 'choice', 'choiceVariant': 'multiple',
                                             'options': [{'label': 'A', 'content': 'one'}, {'label': 'B', 'content': 'two'}]}).model_dump(mode='json')
    with pytest.raises(ValueError):
        generation.completed_question(original, {'answerPayload': {'correct': ['Z']}, 'analysis': 'Invalid option'})


async def test_disabled_or_complete_questions_make_no_generation_calls(monkeypatch):
    current = state(generateAnswers=False)
    assert (await generation.gate(current))['nextStage'] == 'result_review_pause'
    current = state(result=state()['result'] | {'questions': [question(answerPayload={'text': '2'}, analysis='Provided')]})
    assert (await generation.gate(current))['nextStage'] == 'result_review_pause'


async def test_generation_budget_is_reserved_before_calls_and_never_reset(monkeypatch):
    monkeypatch.setenv('AI_TASK_MAX_MODEL_CALLS', '4')
    current = state(reservedCalls=3, callAllowances={})
    update = await generation.gate(current)
    assert update['reservedCalls'] == 4 and update['callAllowance'] == 1
    assert (await generation.gate(current | update))['reservedCalls'] == 4
    stopped = await generation.gate(state(reservedCalls=4))
    assert stopped['nextStage'] == 'result_review_pause' and stopped['status'] == 'PARTIAL'


async def test_known_generation_is_checkpointed_and_passive_projection_does_not_call_models(monkeypatch):
    current = state()
    before = deepcopy(current)
    calls = []

    async def fake_call(model, messages, schema, kind, **kwargs):
        calls.append(kind)
        return schema.model_validate({'answerPayload': {'text': '2'}, 'analysis': 'Add the two ones.'}), [], None

    monkeypatch.setattr(generation, 'get_model', lambda: object())
    monkeypatch.setattr(generation, 'structured_call', fake_call)
    current.update(await generation.gate(current))
    update = await generation.generate(current, None)
    assert update['result']['questions'][0]['answerPayload'] == {'text': '2'}
    assert 'AI' in update['result']['warnings'][0]
    assert (await generation.gate(current | update))['nextStage'] == 'result_review_pause'
    projected = generation.project(before['result'], before['processing'], update['answerResults'])
    assert projected[0] == update['result'] and len(calls) == 1
    assert before['result']['questions'][0]['answerPayload'] is None


async def test_known_failure_preserves_extracted_questions_without_automatic_retry(monkeypatch):
    current = state()

    async def fake_call(*args, **kwargs):
        return None, [], 'OUTPUT_INVALID'

    monkeypatch.setattr(generation, 'get_model', lambda: object())
    monkeypatch.setattr(generation, 'structured_call', fake_call)
    current.update(await generation.gate(current))
    update = await generation.generate(current, None)
    assert update['status'] == 'PARTIAL'
    assert update['result']['questions'] == current['result']['questions']
    assert (await generation.gate(current | update))['nextStage'] == 'result_review_pause'


def test_changed_source_questions_cannot_reuse_generated_answers():
    original = question()
    record = {'questionHash': generation.question_hash(original), 'answerPayload': {'text': '2'}, 'analysis': 'One plus one.', 'failureCode': None}
    changed = state()
    changed['result']['questions'][0]['stem'] = 'What is 2 + 2?'
    result, _, _ = generation.project(changed['result'], changed['processing'], {'q1': record})
    assert result['questions'][0]['answerPayload'] is None


@pytest.mark.usefixtures('disposable_databases')
async def test_real_task_generation_keeps_receipts_source_proofs_and_passive_exports(monkeypatch):
    from uuid import uuid4

    from practiq_ai import task_api
    from tests.db_support import setup_api
    from tests.support import parsed

    extracted = parsed('First')
    extracted['questions'][0]['answerPayload'] = None
    extracted['questions'][0]['analysis'] = None
    service, reference, model = await setup_api(monkeypatch, [extracted, {'answerPayload': {'text': 'Generated answer'}, 'analysis': 'Generated explanation'}])
    monkeypatch.setattr(generation, 'get_model', lambda: model)
    request = DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), generateAnswers=True)
    receipt = await task_api.create_task(request)
    await service.wait_idle()
    detail = await task_api.get_task(receipt['threadId'])
    assert detail['state'] == 'COMPLETED', detail
    assert detail['result']['questions'][0]['answerPayload'] == {'text': 'Generated answer'}
    assert detail['result']['questions'][0]['needsReview']
    assert len(model.calls) == 2 and len(detail['usage']) == 2
    assert detail['modelBudget']['reserved'] == 8
    assert (await task_api.create_task(request)) == receipt
    for _ in range(2):
        assert (await task_api.get_task(receipt['threadId']))['result'] == detail['result']
    import json
    from zipfile import ZipFile
    payload = await task_api.export_task(receipt['threadId'], detail['checkpointId'])
    try:
        with ZipFile(payload) as archive:
            bank = json.loads(archive.read('questions.json'))
        assert bank['result']['questions'][0]['answerPayload'] == {'text': 'Generated answer'}
        assert bank['processing']['quality']['reviewRequired']
    finally:
        payload.close()
    assert len(model.calls) == 2
    from practiq_ai.contracts import DocumentTaskReparse
    model.responses.extend([extracted, {'answerPayload': {'text': 'New generated answer'}, 'analysis': 'New explanation'}])
    reparsed = await task_api.reparse_task(receipt['threadId'], DocumentTaskReparse(requestId=uuid4()))
    await service.wait_idle()
    assert (await task_api.get_task(reparsed['threadId']))['result']['questions'][0]['answerPayload'] == {'text': 'New generated answer'}
    assert len(model.calls) == 4
    assert (await task_api.get_task(receipt['threadId']))['result'] == detail['result']


@pytest.mark.usefixtures('disposable_databases')
async def test_unknown_generation_stops_and_passive_reads_do_not_replay_it(monkeypatch):
    from uuid import uuid4

    import httpx2
    from openai import APIConnectionError

    from practiq_ai import task_api
    from tests.db_support import setup_api
    from tests.support import parsed
    from tests.support import question as extracted_question

    extracted = parsed('First')
    extracted['questions'].append(extracted_question('Second'))
    service, reference, model = await setup_api(monkeypatch, [extracted,
        {'answerPayload': {'text': 'Saved generated answer'}, 'analysis': 'Saved explanation'},
        APIConnectionError(request=httpx2.Request('POST', 'https://fixture.example'))])
    monkeypatch.setattr(generation, 'get_model', lambda: model)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), generateAnswers=True))
    await service.wait_idle()
    detail = await task_api.get_task(receipt['threadId'])
    assert 'MODEL_RESULT_UNKNOWN' in detail['blocking'], detail
    assert detail['result']['questions'][0]['answerPayload'] == {'text': 'Saved generated answer'}
    assert detail['result']['questions'][1]['answerPayload'] is None
    assert len(detail['unknownUsageCalls']) == 1 and len(model.calls) == 3
    import json
    from zipfile import ZipFile
    payload = await task_api.export_task(receipt['threadId'], detail['checkpointId'], completed=True)
    try:
        with ZipFile(payload) as archive:
            bank = json.loads(archive.read('questions.json'))
        assert bank['result']['questions'][0]['answerPayload'] == {'text': 'Saved generated answer'}
        assert bank['result']['questions'][1]['answerPayload'] is None
    finally:
        payload.close()
    for _ in range(2):
        await task_api.get_task(receipt['threadId'])
    assert len(model.calls) == 3
