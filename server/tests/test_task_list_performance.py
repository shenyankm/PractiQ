import json
from datetime import timedelta
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from practiq_ai import runtime, task_api
from practiq_ai.contracts import DocumentReference, DocumentTaskCreate
from practiq_ai.database import utcnow
from practiq_ai.errors import DocumentProcessingError
from tests.db_support import SERVICES, setup_api
from tests.support import parsed

pytestmark = pytest.mark.usefixtures('disposable_databases')


async def test_sparse_filter_and_completed_pages_do_not_decode_unrelated_history(monkeypatch):
    service, reference, model = await setup_api(monkeypatch, [])
    service.stopping = True
    service.wake.set()
    await service.loop
    source = str(uuid4())
    async with service.db.connection() as conn:
        await conn.execute('INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) VALUES (?,?,?,?,?,?)',
                           (source, source, 'document_parser', json.dumps(reference), 'return_partial', utcnow() + timedelta(days=1)))
    await service.graph.aupdate_state({'configurable': {'thread_id': source}},
                                    {'status': 'SUCCEEDED', 'result': parsed()}, as_node='finish')
    async with service.db.connection() as conn:
        for index in range(600):
            tid = str(uuid4())
            await conn.execute('INSERT INTO document_tasks SELECT ?,request_hash,graph_id,document,failure_policy,parent_thread_id,created_at,expires_at FROM document_tasks WHERE thread_id=?', (tid, source))
            await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context,status) VALUES (?,?,?,'{}','success')", (tid, tid, tid))
            await service.db.connections[0].execute(
                "INSERT INTO checkpoints SELECT ?,checkpoint_ns,checkpoint_id,parent_checkpoint_id,type,checkpoint,metadata FROM checkpoints WHERE thread_id=? AND checkpoint_ns='' ORDER BY checkpoint_id DESC LIMIT 1",
                (tid, source))
        active = str(uuid4())
        await conn.execute('INSERT INTO document_tasks SELECT ?,request_hash,graph_id,document,failure_policy,parent_thread_id,created_at,expires_at FROM document_tasks WHERE thread_id=?', (active, source))
        await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context,status) VALUES (?,?,?,'{}','pending')", (active, active, active))
    snapshots = AsyncMock(wraps=service.snapshot)
    monkeypatch.setattr(service, 'snapshot', snapshots)
    for _ in range(3):
        page = await task_api.list_tasks(state_filter='active')
        assert [item['threadId'] for item in page['items']] == [active]
        assert not page['hasMore']
    # The source has no run; its completed checkpoint must still be authoritative.
    assert snapshots.await_count == 4
    snapshots.reset_mock()
    service.task_summaries.clear()
    first = await task_api.list_tasks(state_filter='completed')
    assert len(first['items']) == 20 and first['hasMore']
    assert snapshots.await_count == 21
    assert await task_api.list_tasks(state_filter='completed') == first
    assert snapshots.await_count == 21
    second = await task_api.list_tasks(offset=20, state_filter='completed')
    assert len(second['items']) == 20 and second['hasMore']
    assert not {item['threadId'] for item in first['items']} & {item['threadId'] for item in second['items']}
    assert snapshots.await_count == 41
    expired_id = first['items'][0]['threadId']
    async with service.db.connection() as conn:
        await conn.execute('UPDATE document_tasks SET expires_at=? WHERE thread_id=?', (utcnow() - timedelta(seconds=1), expired_id))
    expired = await task_api.list_tasks(state_filter='expired')
    assert expired['items'][0]['threadId'] == expired_id
    assert expired['items'][0]['questionCount'] == 1
    assert not expired['hasMore']
    assert snapshots.await_count == 41
    changed_id = first['items'][1]['threadId']
    changed = parsed('Changed')
    changed['questions'].append({**changed['questions'][0], 'id': 'second-question'})
    await service.graph.aupdate_state({'configurable': {'thread_id': changed_id}},
                                    {'status': 'SUCCEEDED', 'result': changed}, as_node='finish')
    updated = await task_api.list_tasks(state_filter='completed')
    assert next(item for item in updated['items'] if item['threadId'] == changed_id)['questionCount'] == 2
    assert snapshots.await_count == 42
    monkeypatch.setenv('AI_MAX_BUSY_THREADS', '1')
    before = await service.db.rows('SELECT count(*) AS n FROM document_tasks')
    admit = AsyncMock(wraps=task_api._admit)
    monkeypatch.setattr(task_api, '_admit', admit)
    with pytest.raises(DocumentProcessingError) as rejected:
        await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    assert rejected.value.code == 'QUEUE_FULL' and admit.await_count == 1
    assert await service.db.rows('SELECT count(*) AS n FROM document_tasks') == before
    assert not model.calls


async def test_filtered_candidates_use_latest_run_and_keep_ambiguous_interrupts_authoritative(monkeypatch):
    service, reference, _ = await setup_api(monkeypatch, [])
    service.stopping = True
    service.wake.set()
    await service.loop
    tid = str(uuid4())
    async with service.db.connection() as conn:
        await conn.execute('INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) VALUES (?,?,?,?,?,?)',
                           (tid, tid, 'document_parser', json.dumps(reference), 'return_partial', utcnow() + timedelta(days=1)))
        await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context,status,created_at) VALUES (?,?,?,'{}','pending',?)", (str(uuid4()), tid, str(uuid4()), utcnow() - timedelta(days=1)))
        newest = str(uuid4())
        await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context,status) VALUES (?,?,?,'{}','interrupted')", (newest, tid, newest))
    assert not (await task_api.list_tasks(state_filter='active'))['items']
    assert (await task_api.list_tasks(state_filter='interrupted'))['items'][0]['threadId'] == tid
    snapshot = await service.snapshot((await service.db.rows('SELECT * FROM document_tasks WHERE thread_id=?', (tid,)))[0])
    from langgraph.types import Interrupt
    current = snapshot._replace(interrupts=(Interrupt({'kind': 'pause'}),))
    calls = AsyncMock(side_effect=lambda _task: current)
    monkeypatch.setattr(service, 'snapshot', calls)
    assert (await task_api.list_tasks(state_filter='paused'))['items'][0]['threadId'] == tid
    assert not (await task_api.list_tasks(state_filter='review'))['items']
    current = snapshot._replace(interrupts=(Interrupt({'kind': 'review'}),))
    assert (await task_api.list_tasks(state_filter='review'))['items'][0]['threadId'] == tid
    assert not (await task_api.list_tasks(state_filter='paused'))['items']
    assert calls.await_count == 4  # Non-quiescent checkpoints never reuse a completion summary.
    async with service.db.connection() as conn:
        await conn.execute('UPDATE document_runs SET cancel_requested=1 WHERE run_id=?', (newest,))
    assert (await task_api.list_tasks(state_filter='cancelled'))['items'][0]['threadId'] == tid
    assert not (await task_api.list_tasks(state_filter='review'))['items']
    async with service.db.connection() as conn:
        await conn.execute('DELETE FROM document_runs WHERE thread_id=?', (tid,))
    assert (await task_api.list_tasks(state_filter='review'))['items'][0]['threadId'] == tid
    current = snapshot._replace(interrupts=(Interrupt({'kind': 'pause'}),))
    assert (await task_api.list_tasks(state_filter='paused'))['items'][0]['threadId'] == tid


async def test_startup_reads_one_snapshot_per_thread_for_historical_interrupted_runs(monkeypatch):
    service, reference, model = await setup_api(monkeypatch, [])
    await service.stop()
    await service.db.open()
    tid = str(uuid4())
    async with service.db.connection() as conn:
        await conn.execute('INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) VALUES (?,?,?,?,?,?)',
                           (tid, tid, 'document_parser', json.dumps(reference), 'return_partial', utcnow() + timedelta(days=1)))
        for _ in range(30):
            rid = str(uuid4())
            await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context,status) VALUES (?,?,?,'{}','interrupted')", (rid, tid, rid))
    restarted = runtime.Service(service.db)
    SERVICES.append(restarted)
    snapshots = AsyncMock(wraps=restarted.snapshot)
    monkeypatch.setattr(restarted, 'snapshot', snapshots)
    await restarted.start()
    assert snapshots.await_count == 1
    assert len(await service.db.rows("SELECT run_id FROM document_runs WHERE status='interrupted'")) == 30
    assert not model.calls
