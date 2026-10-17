"""Deadline cancellation preserves completed fragments and unknown provider usage."""

import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4
from zipfile import ZipFile

import pytest

from practiq_ai import execution, runtime, task_api
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskCreate,
)
from tests.db_support import setup_api
from tests.support import parsed


@pytest.mark.usefixtures('disposable_databases')
async def test_dispatched_deadline_preserves_partial_export_and_unknown_usage(monkeypatch):
    monkeypatch.setenv('AI_GRAPH_MAX_CONCURRENCY', '1')
    deadlines = []

    def execution_timeout(seconds):
        deadline = asyncio.timeout(seconds)
        deadlines.append(deadline)
        return deadline

    runtime_asyncio = SimpleNamespace(**vars(asyncio))
    runtime_asyncio.timeout = execution_timeout
    monkeypatch.setattr(runtime, 'asyncio', runtime_asyncio)

    def expire_second_call(_messages, _schema):
        deadlines[-1].reschedule(asyncio.get_running_loop().time())
        return (30, parsed('Second'))

    service, reference, model = await setup_api(
        monkeypatch, [parsed('First'), expire_second_call], parts=['1. First\n', '2. Second'],
    )
    receipt = await task_api.create_task(DocumentTaskCreate(
        requestId=uuid4(), document=DocumentReference.model_validate(reference),
    ))
    await service.wait_idle()
    detail = await task_api.get_task(receipt['threadId'])
    assert detail['state'] == 'INTERRUPTED', detail
    assert detail['blocking'] == ['MODEL_RESULT_UNKNOWN']
    assert detail['canExportCompleted'] and 'resume' in detail['allowedActions']
    assert len(model.calls) == 2 and deadlines[-1].expired()

    assert len(detail['unknownUsageCalls']) == 1
    unknown_key = detail['unknownUsageCalls'][0]
    saved_call = await service.db.store.aget(
        execution.namespace(receipt['threadId'], 'calls'), unknown_key, refresh_ttl=False,
    )
    assert saved_call and saved_call.value['usageStatus'] == 'unknown'
    assert saved_call.value['inputTokens'] is saved_call.value['outputTokens'] is None
    with await task_api.export_task(receipt['threadId'], detail['checkpointId'], completed=True) as bank, ZipFile(bank) as archive:
        payload = json.loads(archive.read('questions.json'))
    assert payload['status'] == 'PARTIAL'
    assert [question['stem'] for question in payload['result']['questions']] == ['First']
    assert len(model.calls) == 2
    assert (await task_api.get_task(receipt['threadId']))['runId'] == receipt['runId']
