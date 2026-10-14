"""Deduplication is explicit, receipt-compatible and frozen per admitted task."""
from uuid import uuid4

import pytest
from pydantic import ValidationError

from practiq_ai import task_api
from practiq_ai.contracts import (
    DocumentParseInput,
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
    DocumentTaskReparse,
)
from practiq_ai.errors import DocumentProcessingError
from tests.db_support import setup_api
from tests.support import parsed


def source():
    return DocumentReference(sourceType='text', mediaType='text/plain', sha256='a' * 64, sizeBytes=10,
                             objectKey=f'practiq-agent/sources/{"a" * 64}/source.txt')


def test_false_dedup_preserves_historical_create_payload():
    request = DocumentTaskCreate(requestId=uuid4(), document=source())
    old_payload = request.model_dump(mode='json', exclude={'officeMode', 'deduplicateQuestions'})
    assert not DocumentParseInput(document=source()).deduplicateQuestions
    assert task_api._create_payload(request) == old_payload
    assert task_api._create_payload(request.model_copy(update={'deduplicateQuestions': False})) == old_payload
    assert task_api._create_payload(request.model_copy(update={'deduplicateQuestions': True})) == {**old_payload, 'deduplicateQuestions': True}


@pytest.mark.parametrize('value', [0, 1, 'false', 'true', None, [], {}])
def test_deduplication_rejects_non_boolean_request_values(value):
    for model, extra in [(DocumentParseInput, {}), (DocumentTaskCreate, {'requestId': uuid4()})]:
        with pytest.raises(ValidationError):
            model.model_validate({'document': source(), 'deduplicateQuestions': value, **extra})


def test_control_and_reparse_cannot_change_the_frozen_dedup_option():
    for model, extra in [(DocumentTaskControl, {'action': 'resume'}), (DocumentTaskReparse, {})]:
        with pytest.raises(ValidationError):
            model.model_validate({'requestId': uuid4(), 'deduplicateQuestions': True, **extra})


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('enabled', [False, True])
async def test_dedup_flag_is_admitted_once_replayed_and_preserved_on_reparse(monkeypatch, enabled):
    service, reference, model = await setup_api(monkeypatch, [parsed('First'), parsed('Second')])
    request = DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), deduplicateQuestions=enabled)
    receipt = await task_api.create_task(request)
    await service.wait_idle()
    first_input = (await service.db.rows('SELECT input FROM document_runs WHERE run_id=%s', (receipt['runId'],)))[0]['input']
    assert first_input['deduplicateQuestions'] is enabled
    if not enabled:
        # Historical initial runs predate the optional flag.
        async with service.db.connection() as connection:
            await connection.execute("UPDATE document_runs SET input=input-'deduplicateQuestions' WHERE run_id=%s", (receipt['runId'],))
    assert await task_api.create_task(request) == receipt
    with pytest.raises(DocumentProcessingError) as conflict:
        await task_api.create_task(request.model_copy(update={'deduplicateQuestions': not enabled}))
    assert conflict.value.code == 'REQUEST_CONFLICT'
    child = await task_api.reparse_task(receipt['threadId'], DocumentTaskReparse(requestId=uuid4()))
    await service.wait_idle()
    second_input = (await service.db.rows('SELECT input FROM document_runs WHERE run_id=%s', (child['runId'],)))[0]['input']
    assert second_input['deduplicateQuestions'] is enabled
    assert len(model.calls) == 2


@pytest.mark.usefixtures('disposable_databases')
async def test_retry_preserves_admitted_dedup_flag(monkeypatch):
    invalid = {'questions': [{'stem': ''}]}
    service, reference, _model = await setup_api(monkeypatch, [invalid, invalid, parsed('Fixed')])
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), deduplicateQuestions=True))
    await service.wait_idle()
    detail = await task_api.get_task(receipt['threadId'])
    assert detail['status'] == 'PARTIAL'
    retry = await task_api.control_task(receipt['threadId'], DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=detail['checkpointId']))
    await service.wait_idle()
    retry_input = (await service.db.rows('SELECT input FROM document_runs WHERE run_id=%s', (retry['runId'],)))[0]['input']
    assert retry_input['deduplicateQuestions'] is True
    assert (await task_api.get_task(receipt['threadId']))['status'] == 'SUCCEEDED'
