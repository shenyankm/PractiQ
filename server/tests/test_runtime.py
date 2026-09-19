import asyncio
from datetime import timedelta
from uuid import UUID, uuid4

import pytest

from practiq_ai import runtime, task_api
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
)
from practiq_ai.database import Database, utcnow
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.manage import cleanup, exclusive
from tests.db_support import SERVICES, new_database
from tests.test_task_api import setup_api
from tests.test_task_execution import parsed


async def test_schema_initialization_is_explicit_and_refuses_existing_data(monkeypatch):
    db = await new_database()
    with pytest.raises(RuntimeError, match='empty dedicated'):
        await db.initialize()
    async with db.pool.connection() as conn:
        await conn.execute("COMMENT ON TABLE document_tasks IS 'unsupported'")
    with pytest.raises(RuntimeError, match='Initialize'):
        await db.check_schema()
    await db.close()


async def test_singleton_lock_readiness_and_failed_start_cleanup(monkeypatch):
    db = await new_database()
    service = runtime.Service(db)
    await service.start()
    SERVICES.append(service)
    assert await service.ready()
    contender = runtime.Service(Database(db.uri))
    with pytest.raises(RuntimeError, match='Another service'):
        await contender.start()
    with pytest.raises(RuntimeError, match='Stop the service'):
        async with exclusive(db):
            pass
    monkeypatch.setenv('AI_DEPLOYMENT_WORKERS', '2')
    monkeypatch.setenv('N_JOBS_PER_WORKER', '1')
    with pytest.raises(RuntimeError, match='one Uvicorn'):
        await runtime.Service(Database(db.uri)).start()
    monkeypatch.setenv('AI_DEPLOYMENT_WORKERS', '1')
    await service.stop(timeout=0)
    assert not await service.ready()


async def test_expired_state_cleanup_is_offline_and_idempotent(monkeypatch):
    service, reference, _ = await setup_api(monkeypatch)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    uri = service.db.uri
    await service.stop(timeout=0)
    db = Database(uri)
    await db.open()
    try:
        with pytest.raises(RuntimeError, match='MAINTENANCE'):
            await cleanup(db)
        monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')
        async with db.pool.connection() as conn:
            await conn.execute('UPDATE document_tasks SET expires_at=%s', (utcnow() - timedelta(days=1),))
        assert await cleanup(db) == 1
        assert await cleanup(db) == 0
        assert not await db.rows('SELECT * FROM document_tasks')
        assert not await db.store.asearch(('document_tasks',), refresh_ttl=False)
        assert not [item async for item in db.checkpointer.alist({'configurable': {'thread_id': receipt['threadId']}})]
    finally:
        await db.close()


async def test_queue_is_persistent_and_concurrent_admission_is_bounded(monkeypatch):
    service, reference, _ = await setup_api(monkeypatch, [(30, parsed())])
    monkeypatch.setenv('AI_MAX_BUSY_THREADS', '1')
    requests = [DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)) for _ in range(5)]
    results = await asyncio.gather(*(task_api.create_task(request) for request in requests), return_exceptions=True)
    assert sum(isinstance(value, dict) for value in results) == 1
    assert all(isinstance(value, dict) or isinstance(value, DocumentProcessingError) and value.code == 'QUEUE_FULL' for value in results)
    assert len(await service.db.rows('SELECT * FROM document_tasks')) == 1
    receipt = next(value for value in results if isinstance(value, dict))
    # Stale run IDs cannot cancel a different execution.
    with pytest.raises(DocumentProcessingError, match='no longer current'):
        await task_api.control_task(receipt['threadId'], DocumentTaskControl(requestId=uuid4(), action='interrupt', runId=uuid4()))


async def test_parent_not_found_expired_task_and_invalid_checkpoint(monkeypatch):
    service, reference, _ = await setup_api(monkeypatch)
    request = DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), parentThreadId=uuid4())
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.create_task(request)
    assert error.value.status_code == 404
    with pytest.raises(DocumentProcessingError):
        await task_api.get_task(str(uuid4()))
    receipt = await task_api.create_task(request.model_copy(update={'parentThreadId': None}))
    await service.wait_idle()
    child = await task_api.create_task(request.model_copy(update={'requestId': uuid4(), 'parentThreadId': UUID(receipt['threadId'])}))
    assert child['threadId'] != receipt['threadId']
    async with service.db.pool.connection() as conn:
        await conn.execute('UPDATE document_tasks SET expires_at=%s WHERE thread_id=%s', (utcnow()-timedelta(seconds=1), receipt['threadId']))
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.get_task(receipt['threadId'])
    assert error.value.code == 'TASK_EXPIRED'
    with pytest.raises(DocumentProcessingError) as expired_replay:
        await task_api.create_task(request.model_copy(update={'parentThreadId': None}))
    assert expired_replay.value.code == 'TASK_EXPIRED'


async def test_readiness_and_client_fail_closed_without_runtime(monkeypatch):
    monkeypatch.setattr(runtime, 'current', None)
    with pytest.raises(DocumentProcessingError) as error:
        task_api.client()
    assert error.value.status_code == 503
    from practiq_ai.webapp import readiness
    assert (await readiness()).status_code == 503


async def test_runtime_task_budget_and_deadline_are_durable(monkeypatch):
    monkeypatch.setenv('AI_RUN_TIMEOUT_SECONDS', '1')
    service, reference, model = await setup_api(monkeypatch, [(30, parsed())])
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    state = await task_api.get_task(receipt['threadId'])
    assert state['state'] == 'FAILED'
    assert state['blocking'] == ['RUN_DEADLINE_EXCEEDED']
    assert len(state['unknownUsageCalls']) == len(model.calls) == 1


async def test_restart_preserves_deadline_and_does_not_refund_unknown_call(monkeypatch):
    service, reference, model = await setup_api(monkeypatch, [(30, parsed()), parsed()])
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    async with asyncio.timeout(10):
        while not model.calls:
            await asyncio.sleep(0.01)
    before = await task_api.get_task(receipt['threadId'])
    uri = service.db.uri
    await service.stop(timeout=0)
    db = Database(uri)
    await db.open()
    async with db.pool.connection() as conn:
        await conn.execute('UPDATE document_runs SET deadline=%s WHERE run_id=%s', (utcnow()-timedelta(seconds=1), receipt['runId']))
    restarted = runtime.Service(db)
    await restarted.start()
    SERVICES.append(restarted)
    monkeypatch.setattr(runtime, 'current', restarted)
    async with asyncio.timeout(10):
        while await db.rows("SELECT run_id FROM document_runs WHERE status IN ('pending','running')"):
            await asyncio.sleep(0.01)
    state = await task_api.get_task(receipt['threadId'])
    assert state['runId'] == receipt['runId']
    assert state['blocking'] == ['RUN_DEADLINE_EXCEEDED']
    assert state['modelBudget'] == before['modelBudget']
    assert len(state['unknownUsageCalls']) == len(model.calls) == 1


async def test_maintenance_cleanup_skips_expired_queued_run(monkeypatch):
    service, reference, _ = await setup_api(monkeypatch, [(30, parsed())])
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    uri = service.db.uri
    await service.stop(timeout=0)
    db = Database(uri)
    await db.open()
    try:
        async with db.pool.connection() as conn:
            await conn.execute('UPDATE document_tasks SET expires_at=%s', (utcnow()-timedelta(seconds=1),))
        monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')
        assert await cleanup(db) == 0
        assert (await db.rows('SELECT thread_id FROM document_tasks'))[0]['thread_id'] == receipt['threadId']
    finally:
        await db.close()
