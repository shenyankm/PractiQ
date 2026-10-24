"""Durable results and pending reviews remain recoverable after stopped runs."""

import asyncio
from datetime import timedelta
from uuid import uuid4

import httpx
import pytest
from psycopg import OperationalError

from practiq_ai import runtime, task_api
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
)
from practiq_ai.database import utcnow
from practiq_ai.webapp import app
from tests.db_support import SERVICES, setup_api
from tests.support import parsed

pytestmark = pytest.mark.usefixtures('disposable_databases')


@pytest.mark.parametrize('result', [{'schemaVersion': 999}, None, 'unreadable'])
async def test_unreadable_checkpoint_is_isolated_during_restart_and_remains_deletable(monkeypatch, result):
    service, reference, model = await setup_api(monkeypatch, [parsed('damaged'), parsed('healthy'), parsed('new')])
    bad = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    healthy = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    calls_before = await task_api._calls(service, bad['threadId'])
    receipts_before = await service.db.rows('SELECT * FROM document_receipts WHERE thread_id=%s', (bad['threadId'],))
    await service.graphs['document_parser'].aupdate_state(
        {'configurable': {'thread_id': bad['threadId']}, 'metadata': {'practiqRunId': bad['runId']}},
        {'result': result}, as_node='finish',
    )
    async with service.db.connection() as conn:
        await conn.execute("UPDATE document_runs SET status='interrupted' WHERE run_id=ANY(%s)", ([bad['runId'], healthy['runId']],))
    await service.stop()
    original_snapshot = runtime.Service.snapshot
    if result == 'unreadable':
        async def unreadable_snapshot(self, task):
            if task['thread_id'] == bad['threadId']:
                raise ValueError('synthetic private checkpoint content')
            return await original_snapshot(self, task)
        monkeypatch.setattr(runtime.Service, 'snapshot', unreadable_snapshot)
    restarted = runtime.Service(service.db)
    SERVICES.append(restarted)
    await restarted.start()
    monkeypatch.setattr(runtime, 'current', restarted)
    async with asyncio.timeout(5):
        while not await restarted.ready():
            await asyncio.sleep(.01)
    assert len(model.calls) == 2
    row = (await service.db.rows('SELECT * FROM document_runs WHERE run_id=%s', (bad['runId'],)))[0]
    assert row['status'] == 'error' and row['error_code'] == 'TASK_CHECKPOINT_UNREADABLE'
    raw = await original_snapshot(restarted, (await service.db.rows('SELECT * FROM document_tasks WHERE thread_id=%s', (bad['threadId'],)))[0])
    assert raw.values['result'] == result
    assert await task_api._calls(restarted, bad['threadId']) == calls_before
    assert await service.db.rows('SELECT * FROM document_receipts WHERE thread_id=%s', (bad['threadId'],)) == receipts_before
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'test-token')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test', headers={'Authorization': 'Bearer test-token'}) as http:
        detail = (await http.get(f"/api/document-tasks/{bad['threadId']}")).json()
        assert detail['state'] == 'FAILED' and detail['blocking'] == ['TASK_CHECKPOINT_UNREADABLE']
        assert detail['result'] is None and detail['allowedActions'] == [] and not detail['resumeCompatible']
        head = (await http.get(f"/api/document-tasks/{bad['threadId']}/head")).json()
        assert head['state'] == 'FAILED' and not head['resumeCompatible']
        preview = (await http.get(f"/api/document-tasks/{bad['threadId']}/preview")).json()
        assert preview['state'] == 'FAILED' and preview['units'] == []
        listing = (await http.get('/api/document-tasks?state_filter=failed')).json()
        assert bad['threadId'] in [item['threadId'] for item in listing['items']]
        assert (await http.get(f"/api/document-tasks/{healthy['threadId']}")).json()['state'] == 'COMPLETED'
        response = await http.delete(f"/api/document-tasks/{bad['threadId']}")
        assert response.status_code == 200 and response.json()['deleted']
    assert not await service.db.rows('SELECT * FROM document_tasks WHERE thread_id=%s', (bad['threadId'],))
    assert not await service.db.checkpoint_heads([bad['threadId']])
    assert len(model.calls) == 2
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    async with asyncio.timeout(10):
        while (await service.db.rows('SELECT status FROM document_runs WHERE run_id=%s', (created['runId'],)))[0]['status'] in {'pending', 'running'} or restarted.active:
            await asyncio.sleep(.01)
    assert (await task_api.get_task(created['threadId']))['state'] == 'COMPLETED'
    assert len(model.calls) == 3


async def test_reconciliation_does_not_quarantine_database_outages(monkeypatch):
    service, reference, _model = await setup_api(monkeypatch)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    async with service.db.connection() as conn:
        await conn.execute("UPDATE document_runs SET status='interrupted' WHERE run_id=%s", (created['runId'],))

    async def unavailable(_task):
        raise OperationalError('synthetic database outage')

    monkeypatch.setattr(service, 'snapshot', unavailable)
    with pytest.raises(OperationalError):
        await service.reconcile()
    row = (await service.db.rows('SELECT status,error_code FROM document_runs WHERE run_id=%s', (created['runId'],)))[0]
    assert row == {'status': 'interrupted', 'error_code': None}


async def test_cancelled_task_can_export_completed_content_without_resuming(monkeypatch):
    service, reference, model = await setup_api(monkeypatch)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    await service.graphs['document_parser'].aupdate_state(
        {'configurable': {'thread_id': created['threadId']}, 'metadata': {'practiqRunId': created['runId']}},
        {'nextStage': 'finish'}, as_node='result_review',
    )
    async with service.db.connection() as conn:
        await conn.execute("UPDATE document_runs SET status='interrupted',cancel_requested=true WHERE run_id=%s", (created['runId'],))
    detail = await task_api.get_task(created['threadId'])
    assert detail['state'] == 'CANCELLED' and detail['canExportCompleted']
    with await task_api.export_task(created['threadId'], detail['checkpointId'], completed=True) as archive:
        assert archive.read(2) == b'PK'
    assert (await task_api.get_task(created['threadId']))['state'] == 'CANCELLED'
    assert len(model.calls) == 1


async def test_cancellation_with_an_unreadable_terminal_result_quarantines_only_that_run(monkeypatch):
    service, reference, model = await setup_api(monkeypatch)
    original = service.snapshot
    cancelled = False

    async def corrupt_and_cancel(task):
        nonlocal cancelled
        snapshot = await original(task)
        if not cancelled and snapshot.values.get('status') == 'SUCCEEDED' and not snapshot.next:
            cancelled = True
            await service.graphs['document_parser'].aupdate_state(
                {'configurable': {'thread_id': task['thread_id']}, 'metadata': {'practiqRunId': snapshot.metadata['practiqRunId']}},
                {'result': None}, as_node='finish',
            )
            raise asyncio.CancelledError
        return snapshot

    monkeypatch.setattr(service, 'snapshot', corrupt_and_cancel)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    detail = await task_api.get_task(created['threadId'])
    assert detail['state'] == 'FAILED' and detail['blocking'] == ['TASK_CHECKPOINT_UNREADABLE']
    assert detail['allowedActions'] == [] and not detail['canExportCompleted'] and not detail['resumeCompatible']
    assert service.accepting and len(model.calls) == 1


@pytest.mark.parametrize('cancel_requested', [False, True])
@pytest.mark.parametrize('terminal_status', ['SUCCEEDED', 'PARTIAL'])
async def test_cancellation_after_final_checkpoint_keeps_result_exportable(monkeypatch, cancel_requested, terminal_status):
    service, reference, model = await setup_api(monkeypatch)
    original = service.snapshot
    cancelled = False

    async def cancel_after_result(task):
        nonlocal cancelled
        snapshot = await original(task)
        if not cancelled and snapshot.values.get('status') == 'SUCCEEDED' and not snapshot.next:
            cancelled = True
            run_id = snapshot.metadata['practiqRunId']
            if terminal_status == 'PARTIAL':
                await service.graphs['document_parser'].aupdate_state(
                    {'configurable': {'thread_id': task['thread_id']}, 'metadata': {'practiqRunId': run_id}},
                    {'status': 'PARTIAL'}, as_node='finish',
                )
            async with service.db.connection() as conn:
                await conn.execute('UPDATE document_runs SET cancel_requested=%s WHERE run_id=%s', (cancel_requested, run_id))
            raise asyncio.CancelledError
        return snapshot

    monkeypatch.setattr(service, 'snapshot', cancel_after_result)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    assert cancelled
    detail = await task_api.get_task(created['threadId'])
    assert detail['state'] == 'COMPLETED' and detail['status'] == terminal_status
    assert detail['result']['questions'] and detail['canExportCompleted'] and detail['allowedActions'] == []
    assert (await service.db.rows('SELECT status FROM document_runs WHERE run_id=%s', (created['runId'],)))[0]['status'] == 'success'
    with await task_api.export_task(created['threadId'], detail['checkpointId'], completed=True) as archive:
        assert archive.read(2) == b'PK'
    assert len(model.calls) == 1


@pytest.mark.parametrize('stopped', ['cancelled', 'failed'])
async def test_stopped_review_decision_keeps_accept_partial_action(monkeypatch, stopped):
    service, reference, model = await setup_api(monkeypatch, [parsed(), *([{'questions': [{'stem': ''}]}] * 2)], parts=['a', 'b'])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), failurePolicy='review'))
    await service.wait_idle()
    thread_id = created['threadId']
    waiting = await task_api.get_task(thread_id)
    assert waiting['state'] == 'WAITING_REVIEW'
    original = service.execute

    async def expired_decision(run):
        await original({**run, 'deadline': utcnow() - timedelta(seconds=1)})

    if stopped == 'failed':
        monkeypatch.setattr(service, 'execute', expired_decision)
    await service.execution_slots.acquire()
    try:
        decision = await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action='accept_partial', checkpointId=waiting['checkpointId']))
        if stopped == 'cancelled':
            await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action='interrupt', runId=decision['runId']))
            async with asyncio.timeout(5):
                while (await service.db.rows('SELECT status FROM document_runs WHERE run_id=%s', (decision['runId'],)))[0]['status'] != 'interrupted':
                    await asyncio.sleep(.01)
    finally:
        service.execution_slots.release()
    await service.wait_idle()
    monkeypatch.setattr(service, 'execute', original)
    detail = await task_api.get_task(thread_id)
    assert detail['state'] == 'WAITING_REVIEW'
    assert 'accept_partial' in detail['allowedActions'] and 'resume' not in detail['allowedActions']
    assert thread_id in [item['threadId'] for item in (await task_api.list_tasks(state_filter='review'))['items']]
    for state in ('cancelled', 'failed'):
        assert thread_id not in [item['threadId'] for item in (await task_api.list_tasks(state_filter=state))['items']]
    before = len(model.calls)
    await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action='accept_partial', checkpointId=detail['checkpointId']))
    await service.wait_idle()
    result_review = await task_api.get_task(thread_id)
    assert result_review['checkpointId'] != detail['checkpointId']
    assert result_review['state'] == 'WAITING_REVIEW'
    assert 'accept_partial' in result_review['allowedActions'] and 'resume' not in result_review['allowedActions']
    await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action='accept_partial', checkpointId=result_review['checkpointId']))
    await service.wait_idle()
    completed = await task_api.get_task(thread_id)
    assert completed['state'] == 'COMPLETED' and completed['status'] == 'PARTIAL'
    assert len(model.calls) == before
