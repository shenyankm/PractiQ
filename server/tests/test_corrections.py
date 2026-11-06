"""Manual revisions preserve model snapshots and never enqueue model work."""
import asyncio
import io
import json
from datetime import timedelta
from uuid import uuid4
from zipfile import ZipFile

import httpx
import pytest

from practiq_ai import task_api, webapp
from practiq_ai.contracts import (
    DocumentCorrections,
    DocumentCorrectionSave,
    DocumentParseResult,
    DocumentReference,
    DocumentTaskCreate,
    ParsedQuestion,
)
from practiq_ai.corrections import corrected_result, validate_edit
from practiq_ai.database import utcnow
from practiq_ai.errors import DocumentProcessingError
from tests.db_support import setup_api
from tests.support import parsed


def result():
    return DocumentParseResult.model_validate({**parsed(), "questions": [{**parsed()["questions"][0], "id": "q0"}], "schemaVersion": 3, "visualElements": [], "warnings": [], "confidenceScore": 80})


@pytest.mark.parametrize('field,value', [('id', 'new-id'), ('sourceText', 'invented evidence'), ('confidence', .99), ('parentId', 'other')])
def test_protected_provenance_is_not_editable(field, value):
    document = result()
    old = document.questions[0]
    with pytest.raises(DocumentProcessingError, match='cannot be edited'):
        validate_edit(old, old.model_copy(update={field: value}), document, 0)


def test_question_tree_is_revalidated_and_unknown_revision_is_rejected():
    document = result()
    document.questions[0].id = 'q0'
    old = document.questions[0]
    document.questions.append(old.model_copy())
    with pytest.raises(DocumentProcessingError, match='question group'):
        validate_edit(old, old.model_copy(update={'stem': 'edited'}), document, 0)
    with pytest.raises(DocumentProcessingError) as error:
        corrected_result(result(), DocumentCorrections(checkpointId='checkpoint'), uuid4())
    assert error.value.code == 'CORRECTION_NOT_FOUND'


@pytest.mark.usefixtures('disposable_databases')
async def test_http_correction_reopen_history_export_and_immutable_source(monkeypatch):
    service, reference, model = await setup_api(monkeypatch)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    thread = receipt['threadId']
    before = await task_api.get_task(thread)
    question = {**before['result']['questions'][0], 'stem': 'Human corrected stem', 'questionTypeId': '人工校对题型'}
    request = {'requestId': str(uuid4()), 'checkpointId': before['checkpointId'], 'expectedRevision': None,
               'questionIndex': 0, 'question': question}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as http:
        path = f'/api/document-tasks/{thread}/corrections'
        assert (await http.put(path, json=request, headers={'Origin': 'https://elsewhere.invalid'})).status_code == 403
        first = await http.put(path, json=request)
        assert first.status_code == 200, first.text
        saved = first.json()
        assert len(saved['edits']) == 1 and saved['edits'][0]['question']['needsReview']
        assert (await http.put(path, json=request)).json() == saved  # Lost response: explicit replay is idempotent.
        assert (await http.get(path)).json() == saved
        review = (await http.get(f'/api/document-tasks/{thread}/preview?include_result=false')).json()
        assert review['corrections'] == saved and all(not unit['questions'] for unit in review['units'])
        changed_request = {**request, 'question': {**question, 'stem': 'different'}}
        assert (await http.put(path, json=changed_request)).status_code == 409
        second = {**request, 'requestId': str(uuid4()), 'expectedRevision': request['requestId'], 'question': {**question, 'stem': 'Second correction'}}
        second_saved = await http.put(path, json=second)
        assert second_saved.status_code == 200, second_saved.text
        assert len(second_saved.json()['edits']) == 2
        for revision, stem in [(None, before['result']['questions'][0]['stem']), (request['requestId'], question['stem']), (second['requestId'], 'Second correction')]:
            params = {'checkpoint_id': before['checkpointId']}
            if revision:
                params['revision_id'] = revision
            response = await http.get(f'/api/document-tasks/{thread}/export', params=params)
            assert response.status_code == 200, response.text if response.status_code != 200 else ''
            with ZipFile(io.BytesIO(response.content)) as archive:
                payload = json.loads(archive.read('questions.json'))
            assert payload['result']['questions'][0]['stem'] == stem
            assert payload['result']['questions'][0]['sourceText'] == question['sourceText']
            if revision:
                assert payload['result']['questions'][0]['needsReview']
        assert (await http.get(f'/api/document-tasks/{thread}/export', params={'revision_id': str(uuid4())})).status_code == 404
        stale = {**second, 'requestId': str(uuid4()), 'checkpointId': 'other-checkpoint'}
        assert (await http.put(path, json=stale)).status_code == 409
        invalid = {**second, 'requestId': str(uuid4()), 'questionIndex': 100}
        assert (await http.put(path, json=invalid)).status_code == 422
        invalid = {**second, 'requestId': str(uuid4()), 'expectedRevision': second['requestId'], 'question': {**question, 'sourceText': 'fabricated'}}
        assert (await http.put(path, json=invalid)).json()['detail']['code'] == 'CORRECTION_PROTECTED_FIELD'
        assert (await http.get('/api/document-tasks/' + str(uuid4()) + '/corrections')).status_code == 404
        monkeypatch.setenv('AI_READ_ONLY', '1')
        assert (await http.get(path)).status_code == 200
        assert (await http.put(path, json=second)).json()['detail']['code'] == 'SERVICE_READ_ONLY'
        assert (await http.get(f'/api/document-tasks/{thread}/export', params={'revision_id': second['requestId']})).status_code == 200
    after = await task_api.get_task(thread)
    assert after['result'] == before['result'] and after['usage'] == before['usage'] and len(model.calls) == 1
    assert len(await service.db.rows('SELECT * FROM document_runs WHERE thread_id=%s', (thread,))) == 1


@pytest.mark.usefixtures('disposable_databases')
async def test_concurrent_saves_conflict_without_losing_revision_and_expiry_applies(monkeypatch):
    service, reference, _ = await setup_api(monkeypatch)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    thread = receipt['threadId']
    detail = await task_api.get_task_model(thread)
    assert detail.result and detail.checkpointId
    requests = [DocumentCorrectionSave(requestId=uuid4(), checkpointId=detail.checkpointId, expectedRevision=None,
                    questionIndex=0, question=detail.result.questions[0].model_copy(update={'stem': stem})) for stem in ['One', 'Two']]
    saves = await asyncio.gather(*(task_api.save_correction(thread, request) for request in requests), return_exceptions=True)
    assert sum(isinstance(value, DocumentCorrections) for value in saves) == 1
    assert sum(isinstance(value, DocumentProcessingError) and value.code == 'CORRECTION_CONFLICT' for value in saves) == 1
    saved = await task_api.get_corrections(thread)
    assert len(saved.edits) == 1
    async with service.db.connection() as conn:
        await conn.execute("UPDATE document_runs SET status='running' WHERE thread_id=%s", (thread,))
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.save_correction(thread, requests[0])
    assert error.value.code == 'CORRECTION_NOT_READY'
    async with service.db.connection() as conn:
        await conn.execute("UPDATE document_runs SET status='success' WHERE thread_id=%s", (thread,))
        await conn.execute('UPDATE document_tasks SET expires_at=%s WHERE thread_id=%s', (utcnow() - timedelta(seconds=1), thread))
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.get_corrections(thread)
    assert error.value.code == 'TASK_EXPIRED'


@pytest.mark.usefixtures('disposable_databases')
async def test_answer_edit_references_and_generated_type_contract(monkeypatch):
    source = parsed()
    source['questions'][0].update(answerMode='choice', choiceVariant='single', questionTypeId='单选题',
                                 options=[{'label': 'A', 'content': 'First'}, {'label': 'B', 'content': 'Second'}], answerPayload={'correct': ['A']})
    service, reference, model = await setup_api(monkeypatch, [source])
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    detail = await task_api.get_task_model(receipt['threadId'])
    assert detail.result and detail.checkpointId
    request = DocumentCorrectionSave(requestId=uuid4(), checkpointId=detail.checkpointId, expectedRevision=None,
                  questionIndex=0, question=ParsedQuestion.model_validate({**detail.result.questions[0].model_dump(), 'answerPayload': {'correct': ['B']}}))
    saved = await task_api.save_correction(receipt['threadId'], request)
    assert saved.edits[0].question.model_dump()['answerPayload'] == {'correct': ['B']}
    assert len(model.calls) == 1


@pytest.mark.usefixtures('disposable_databases')
async def test_shared_option_correction_replay_normalizes_against_its_historical_tree(monkeypatch):
    service, reference, model = await setup_api(monkeypatch)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    thread = receipt['threadId']
    document = result()
    parent = ParsedQuestion.model_validate({'id': 'bank', 'stem': 'Word bank', 'answerMode': 'word_bank',
                            'options': [{'label': 'A', 'content': 'First'}, {'label': 'B', 'content': 'Second'}],
                            'passage': [{'partType': 'text', 'textValue': 'Choose '}, {'partType': 'blank', 'questionId': 'child'}]})
    child = ParsedQuestion(id='child', parentId='bank', optionSourceId='bank', stem='Choose',
                           answerMode='choice', choiceVariant='single', answerPayload={'correct': ['A']})
    document.questions = [parent, child]
    document = DocumentParseResult.model_validate(document.model_dump(mode='json'))
    await service.graph.aupdate_state({'configurable': {'thread_id': thread}},
                                      {'result': document.model_dump(mode='json')}, as_node='finish')
    before = await task_api.get_task(thread)
    request = {'requestId': str(uuid4()), 'checkpointId': before['checkpointId'], 'expectedRevision': None,
               'questionIndex': 1, 'question': {**before['result']['questions'][1], 'answerPayload': {'correct': ['b']}}}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as http:
        path = f'/api/document-tasks/{thread}/corrections'
        first = await http.put(path, json=request)
        assert first.status_code == 200, first.text
        saved = first.json()
        assert saved['edits'][0]['question']['answerPayload'] == {'correct': ['B']}
        assert (await http.put(path, json=request)).json() == saved
        different = {**request, 'question': {**request['question'], 'answerPayload': {'correct': ['a']}}}
        assert (await http.put(path, json=different)).json()['detail']['code'] == 'REQUEST_CONFLICT'
        invalid = {**request, 'question': {**request['question'], 'answerPayload': {'correct': ['C']}}}
        assert (await http.put(path, json=invalid)).json()['detail']['code'] == 'REQUEST_CONFLICT'
        different_index = {**request, 'questionIndex': 0, 'question': before['result']['questions'][0]}
        assert (await http.put(path, json=different_index)).json()['detail']['code'] == 'REQUEST_CONFLICT'
        # Later edits can remove the old label; replay uses the tree preceding its own receipt.
        second = {**request, 'requestId': str(uuid4()), 'expectedRevision': request['requestId'],
                  'question': {**request['question'], 'answerPayload': {'correct': ['A']}}}
        assert (await http.put(path, json=second)).status_code == 200
        third = {**request, 'requestId': str(uuid4()), 'expectedRevision': second['requestId'], 'questionIndex': 0,
                 'question': {**before['result']['questions'][0], 'options': [{'label': 'A', 'content': 'First'}]}}
        latest = await http.put(path, json=third)
        assert latest.status_code == 200, latest.text
        assert (await http.put(path, json=request)).json() == latest.json()
        assert len((await http.get(path)).json()['edits']) == 3
    after = await task_api.get_task(thread)
    assert after['result'] == before['result'] and after['usage'] == before['usage'] and len(model.calls) == 1


def test_editable_rich_text_preserves_structure_and_original_source():
    original = result()
    question = original.questions[0]
    changed = question.model_copy(deep=True)
    changed.contentBlocks[0].textValue = 'Human corrected rich text'
    candidate = validate_edit(question, changed, original.model_copy(deep=True), 0)
    assert candidate.contentBlocks[0].textValue == 'Human corrected rich text'
    assert question.contentBlocks[0].textValue == 'First'
    assert candidate.sourceText == question.sourceText
    changed.contentBlocks[0].jsonValue = {'resource': 'invented'}
    with pytest.raises(DocumentProcessingError) as error:
        validate_edit(question, changed, original.model_copy(deep=True), 0)
    assert error.value.code == 'CORRECTION_PROTECTED_FIELD'


async def test_split_original_page_is_authorized_only_with_its_saved_metadata():
    from langgraph.types import StateSnapshot
    reference = {'objectKey': 'managed-original-page', 'sha256': 'a' * 64, 'mediaType': 'image/png', 'sizeBytes': 10}
    snapshot = StateSnapshot(values={'inputParts': [{'sourcePage': 2, 'originalPageRef': reference}]},
                             next=(), config={}, metadata=None, created_at=None, parent_config=None, tasks=(), interrupts=())
    assert await task_api.artifact_is_public(snapshot, 'b' * 64, reference)
    for field, value in [('objectKey', 'other-source'), ('sha256', 'c' * 64), ('sizeBytes', 11)]:
        assert not await task_api.artifact_is_public(snapshot, 'b' * 64, {**reference, field: value})
