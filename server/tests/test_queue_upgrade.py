"""Non-destructive, ownership-protected schema-1 outbox upgrade."""
import asyncio
from datetime import timedelta
from json import dumps
from uuid import uuid4

import pytest

from practiq_ai import manage, runtime, task_api
from practiq_ai.contracts import DocumentReference, DocumentTaskCreate
from practiq_ai.database import utcnow
from practiq_ai.execution import namespace
from tests.db_support import new_database, remove_saas_schema, setup_api

pytestmark = pytest.mark.usefixtures('disposable_databases')


async def test_upgrade_retains_history_receipts_files_deadlines_and_only_stages_recoverable_runs(monkeypatch):
    service, reference, model = await setup_api(monkeypatch)
    request = DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference))
    completed = await task_api.create_task(request)
    await service.wait_idle()
    detail = await task_api.get_task(completed['threadId'])
    await service.stop()
    db = service.db
    await db.open()
    monkeypatch.setenv('DATABASE_URI', db.uri)
    deadline = utcnow() + timedelta(seconds=100)
    ids = {}
    async with db.transaction() as conn:
        for state in ('pending', 'running', 'waiting', 'interrupted', 'error', 'success', 'cancelled', 'unknown', 'paused'):
            tid, rid = str(uuid4()), str(uuid4())
            ids[state] = (tid, rid)
            await conn.execute('INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,parent_thread_id,created_at,expires_at) SELECT %s,request_hash,graph_id,document,failure_policy,NULL,created_at,expires_at FROM document_tasks WHERE thread_id=%s', (tid, completed['threadId']))
            await conn.execute('INSERT INTO document_runs(run_id,thread_id,request_id,input,context,status,deadline,cancel_requested,pause_requested) VALUES(%s,%s,%s,%s,\'{}\',%s,%s,%s,%s)',
                               (rid, tid, rid, dumps({'document': reference, 'failurePolicy': 'return_partial'}), 'running' if state in {'cancelled', 'unknown', 'paused'} else state, deadline, state == 'cancelled', state == 'paused'))
        # A final checkpoint was saved before its run receipt reached success.
        await conn.execute("UPDATE document_runs SET status='running' WHERE run_id=%s", (completed['runId'],))
        await remove_saas_schema(conn)
        await conn.execute('DROP TABLE document_outbox')
        await conn.execute('UPDATE practiq_schema SET version=1')
    unknown_tid, unknown_rid = ids['unknown']
    await db.store.aput(namespace(unknown_tid, 'calls'), 'unknown', {'runId': unknown_rid, 'status': 'started'}, index=False)
    before_receipts = await db.rows('SELECT * FROM document_receipts')
    heads = await db.checkpoint_heads([completed['threadId']])
    with pytest.raises(RuntimeError, match='upgrade-db'):
        await db.check_schema()
    await manage.run('upgrade-db')
    await manage.run('upgrade-db')
    await db.check_schema()
    assert {row['run_id'] for row in await db.rows('SELECT * FROM document_outbox')} == {ids['pending'][1], ids['running'][1]}
    assert await db.rows('SELECT * FROM document_receipts') == before_receipts
    assert await db.checkpoint_heads([completed['threadId']]) == heads
    assert (await db.rows('SELECT deadline FROM document_runs WHERE run_id=%s', (ids['running'][1],)))[0]['deadline'] == deadline
    assert (await db.rows('SELECT status,error_code FROM document_runs WHERE run_id=%s', (unknown_rid,)))[0] == {'status': 'interrupted', 'error_code': 'MODEL_RESULT_UNKNOWN'}
    assert (await db.rows('SELECT status FROM document_runs WHERE run_id=%s', (ids['cancelled'][1],)))[0]['status'] == 'interrupted'
    service.graphs = {name: runtime.build_document_graph(db.checkpointer, store=db.store, name=name, source_types=types) for name, types in runtime.GRAPH_FORMATS.items()}
    service.accepting = True
    monkeypatch.setattr(runtime, 'current', service)
    assert (await task_api.get_task(completed['threadId']))['result'] == detail['result']
    assert await task_api.create_task(request) == completed
    assert await task_api.get_object_store().get_verified(DocumentReference.model_validate(reference))
    assert len(model.calls) == 1


async def test_upgrade_and_replay_cannot_take_live_service_ownership(monkeypatch):
    service, _, _ = await setup_api(monkeypatch)
    monkeypatch.setenv('DATABASE_URI', service.db.uri)
    with pytest.raises(RuntimeError, match='Stop the service'):
        await manage.run('upgrade-db')
    with pytest.raises(RuntimeError, match='Stop the service'):
        await manage.run('replay-run', str(uuid4()))


@pytest.mark.parametrize('call_status', [None, 'started', 'completed'])
async def test_startup_recovers_upgrade_interrupted_after_schema_commit(monkeypatch, call_status):
    service, reference, model = await setup_api(monkeypatch)
    await service.stop()
    db = service.db
    await db.open()
    service.accepting = True
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    deadline = utcnow() + timedelta(seconds=100)
    async with db.transaction() as conn:
        await conn.execute("UPDATE document_runs SET status='running',deadline=%s WHERE run_id=%s", (deadline, receipt['runId']))
        await remove_saas_schema(conn)
        await conn.execute('DROP TABLE document_outbox')
        await conn.execute('UPDATE practiq_schema SET version=1')
    async with manage.exclusive(db):
        await db.upgrade()
    if call_status:
        await db.store.aput(namespace(receipt['threadId'], 'calls'), 'legacy-call',
                           {'callKey': str(uuid4()), 'runId': receipt['runId'], 'status': call_status,
                            'modelId': 'fake', 'callKind': 'document_parse',
                            'inputTokens': 10 if call_status == 'completed' else None,
                            'outputTokens': 5 if call_status == 'completed' else None}, index=False)
    # Simulate process death before upgrade reconciliation/outbox staging.
    assert not await db.rows('SELECT * FROM document_outbox')
    recovered = runtime.Service(db)
    try:
        await recovered.start()
        async with asyncio.timeout(10):
            while (await db.rows('SELECT status FROM document_runs'))[0]['status'] in {'pending', 'running'}:
                await asyncio.sleep(.02)
        assert (await db.rows('SELECT run_id,deadline,status FROM document_runs'))[0] == {
            'run_id': receipt['runId'], 'deadline': deadline, 'status': 'interrupted' if call_status else 'success'}
        assert len(model.calls) == (0 if call_status else 1)
        if call_status:
            assert (await db.rows('SELECT error_code FROM document_runs'))[0]['error_code'] == 'MODEL_RESULT_UNKNOWN'
            assert not await db.rows('SELECT * FROM document_outbox')
    finally:
        await recovered.stop(timeout=0)


async def test_startup_does_not_reset_published_outbox_or_replay_dead_letters(monkeypatch):
    from unittest.mock import AsyncMock

    from practiq_ai import messaging

    service, reference, model = await setup_api(monkeypatch)
    await service.stop()
    await service.db.open()
    service.accepting = True
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    published = utcnow() - timedelta(minutes=5)
    async with service.db.connection() as conn:
        await conn.execute('UPDATE document_outbox SET published_at=%s WHERE run_id=%s', (published, receipt['runId']))
    publish = AsyncMock()
    monkeypatch.setattr(messaging, 'publish', publish)
    observed = asyncio.Event()
    original = service.db.rows
    async def rows(query, params=()):
        result = await original(query, params)
        if 'LIMIT 100' in query and 'document_outbox' in query:
            observed.set()
        return result
    monkeypatch.setattr(service.db, 'rows', rows)
    recovered = runtime.Service(service.db)
    try:
        await recovered.start()
        await asyncio.wait_for(observed.wait(), 10)
        assert (await service.db.rows('SELECT published_at FROM document_outbox'))[0]['published_at'] == published
        publish.assert_not_awaited()
        assert not model.calls
    finally:
        await recovered.stop(timeout=0)


@pytest.mark.parametrize('version', [0, 99])
async def test_upgrade_refuses_unknown_schema_without_mutation(version):
    db = await new_database()
    async with db.connection() as conn:
        await conn.execute('UPDATE practiq_schema SET version=%s', (version,))
    tables = await db.tables()
    with pytest.raises(RuntimeError, match='schema 1'):
        await db.upgrade()
    assert await db.tables() == tables
    assert await db.rows('SELECT version FROM practiq_schema') == [{'version': version}]


async def test_explicit_replay_stages_only_pending_known_calls(monkeypatch):
    service, reference, _ = await setup_api(monkeypatch)
    entered, release = asyncio.Event(), asyncio.Event()
    original = service.execute
    async def execute(run):
        entered.set()
        await release.wait()
        await original(run)
    monkeypatch.setattr(service, 'execute', execute)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await asyncio.wait_for(entered.wait(), 5)
    release.set()
    await service.wait_idle()
    await service.stop()
    db = service.db
    await db.open()
    with pytest.raises(RuntimeError, match='pending run'):
        await manage.replay_run(db, receipt['runId'])
    async with db.connection() as conn:
        await conn.execute("UPDATE document_runs SET status='pending' WHERE run_id=%s", (receipt['runId'],))
    await manage.replay_run(db, receipt['runId'])
    assert (await db.rows('SELECT published_at FROM document_outbox'))[0]['published_at'] is None
    await db.store.aput(namespace(receipt['threadId'], 'calls'), 'unknown', {'runId': receipt['runId'], 'status': 'started'}, index=False)
    with pytest.raises(RuntimeError, match='unknown'):
        await manage.replay_run(db, receipt['runId'])
