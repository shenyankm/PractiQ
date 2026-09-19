import asyncio
from datetime import timedelta
from sqlite3 import OperationalError
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
from tests.db_support import SERVICES, new_database, setup_api
from tests.support import parsed

pytestmark = pytest.mark.usefixtures("disposable_databases")


async def test_schema_initialization_is_explicit_and_refuses_existing_data(monkeypatch):
    db = await new_database()
    with pytest.raises(RuntimeError, match='empty dedicated'):
        await db.initialize()
    async with db.connection() as conn:
        await conn.execute("PRAGMA user_version=99")
    with pytest.raises(RuntimeError, match='Initialize'):
        await db.check_schema()
    await db.close()


async def test_singleton_lock_readiness_and_failed_start_cleanup(monkeypatch):
    from unittest.mock import Mock

    build = Mock(wraps=runtime.build_document_graph)
    monkeypatch.setattr(runtime, "build_document_graph", build)
    db = await new_database()
    service = runtime.Service(db)
    await service.start()
    SERVICES.append(service)
    assert await service.ready()
    assert {call.kwargs["name"]: call.kwargs["source_types"] for call in build.call_args_list} == {
        "document_parser": None, "text_csv_parser": ("text", "csv"),
        "pdf_parser": ("pdf",),
    }
    assert set(service.graphs) == {call.kwargs["name"] for call in build.call_args_list}
    contender = runtime.Service(Database(db.directory))
    with pytest.raises(RuntimeError, match='Another service'):
        await contender.start()
    with pytest.raises(RuntimeError, match='Stop the service'):
        async with exclusive(db):
            pass
    monkeypatch.setenv('AI_DEPLOYMENT_WORKERS', '2')
    monkeypatch.setenv('N_JOBS_PER_WORKER', '1')
    with pytest.raises(ValueError, match='one Uvicorn'):
        await runtime.Service(Database(db.directory)).start()
    monkeypatch.setenv('AI_DEPLOYMENT_WORKERS', '1')
    await service.stop(timeout=0)
    assert not await service.ready()


async def test_expired_state_cleanup_is_offline_and_idempotent(monkeypatch):
    service, reference, _ = await setup_api(monkeypatch)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    uri = service.db.directory
    await service.stop(timeout=0)
    db = Database(uri)
    await db.open()
    try:
        with pytest.raises(RuntimeError, match='MAINTENANCE'):
            await cleanup(db)
        monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')
        async with db.connection() as conn:
            await conn.execute('UPDATE document_tasks SET expires_at=?', (utcnow() - timedelta(days=1),))
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
    async with service.db.connection() as conn:
        await conn.execute('UPDATE document_tasks SET expires_at=? WHERE thread_id=?', (utcnow()-timedelta(seconds=1), receipt['threadId']))
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
    uri = service.db.directory
    await service.stop(timeout=0)
    db = Database(uri)
    await db.open()
    async with db.connection() as conn:
        await conn.execute('UPDATE document_runs SET deadline=? WHERE run_id=?', (utcnow()-timedelta(seconds=1), receipt['runId']))
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
    uri = service.db.directory
    await service.stop(timeout=0)
    db = Database(uri)
    await db.open()
    try:
        async with db.connection() as conn:
            await conn.execute('UPDATE document_tasks SET expires_at=?', (utcnow()-timedelta(seconds=1),))
        monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')
        assert await cleanup(db) == 0
        assert (await db.rows('SELECT thread_id FROM document_tasks'))[0]['thread_id'] == receipt['threadId']
    finally:
        await db.close()


async def test_control_waiters_do_not_starve_scheduler_connections(monkeypatch):
    service, reference, _ = await setup_api(monkeypatch, [(30, parsed())])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    fatal = []
    service.fatal = fatal.append
    entered, release = asyncio.Event(), asyncio.Event()
    original = task_api._read_task
    async def delayed(*args):
        entered.set()
        await release.wait()
        return await original(*args)
    monkeypatch.setattr(task_api, '_read_task', delayed)
    requests = [asyncio.create_task(task_api.control_task(created['threadId'],
                DocumentTaskControl(requestId=uuid4(), action='pause', runId=created['runId']))) for _ in range(24)]
    try:
        await asyncio.wait_for(entered.wait(), 2)
        await asyncio.sleep(0.1)
        assert await asyncio.wait_for(service.db.rows('SELECT 1'), 1)
        assert await service.ready() and not fatal
    finally:
        release.set()
        await asyncio.wait_for(asyncio.gather(*requests), 10)
    assert not fatal


@pytest.mark.parametrize('stage', ['checkpoint', 'store', 'business'])
async def test_initialization_retries_owned_partial_database(monkeypatch, stage):
    from practiq_ai import database
    db = await new_database(initialize=False)
    with monkeypatch.context() as patch:
        if stage == 'business':
            patch.setattr(database, 'DDL', database.DDL + '\n SELECT missing_initialization_function();')
        else:
            owner = db.checkpointer if stage == 'checkpoint' else db.store
            original = owner.setup
            async def fail():
                await original()
                raise RuntimeError('interrupted initialization')
            patch.setattr(owner, 'setup', fail)
        with pytest.raises(OperationalError if stage == 'business' else RuntimeError):
            await db.initialize()
    assert (await db.rows("SELECT name AS marker FROM sqlite_master WHERE name='practiq_initialization'"))[0]['marker']
    await db.initialize()
    await db.check_schema()
    assert not await db.rows("SELECT name FROM sqlite_master WHERE name='practiq_initialization'")
    await db.close()


async def test_initialization_refuses_unrecognized_nonempty_database():
    db = await new_database(initialize=False)
    async with db.connection() as conn:
        await conn.executescript("CREATE TABLE foreign_data (value text); INSERT INTO foreign_data VALUES ('keep');")
    with pytest.raises(RuntimeError, match='empty dedicated'):
        await db.initialize()
    assert await db.rows('SELECT * FROM foreign_data') == [{'value': 'keep'}]
    await db.close()


@pytest.mark.parametrize('expired', [False, True])
async def test_recovery_preflight_is_inside_run_deadline(monkeypatch, expired):
    service, reference, model = await setup_api(monkeypatch, [(30, parsed())])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    async with asyncio.timeout(10):
        while not model.calls:
            await asyncio.sleep(0.01)
    await service.stop(timeout=0)
    db = Database(service.db.directory)
    await db.open()
    # Restart/graph construction must not consume the interval under test.
    execution_time = utcnow()
    monkeypatch.setattr(runtime, 'utcnow', lambda: execution_time)
    deadline = execution_time + timedelta(seconds=-1 if expired else 0.3)
    async with db.connection() as conn:
        await conn.execute('UPDATE document_runs SET deadline=? WHERE run_id=?', (deadline, created['runId']))
    entered, stopped = asyncio.Event(), asyncio.Event()
    async def preflight(_):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
    monkeypatch.setattr(task_api, '_preflight', preflight)
    restarted = runtime.Service(db)
    fatal = []
    monkeypatch.setattr(restarted, 'fatal', fatal.append)
    SERVICES.append(restarted)
    await restarted.start()
    async with asyncio.timeout(3):
        while (rows := await db.rows('SELECT status,error_code FROM document_runs WHERE run_id=?', (created['runId'],)))[0]['status'] != 'error':
            await asyncio.sleep(0.01)
    assert rows[0]['error_code'] == 'RUN_DEADLINE_EXCEEDED' and not fatal
    assert entered.is_set() == stopped.is_set() == (not expired)


async def test_desktop_restart_requires_explicit_resume_and_lists_tasks(monkeypatch):
    monkeypatch.setenv('AI_DESKTOP_MODE', '1')
    service, reference, model = await setup_api(monkeypatch, [(30, parsed()), parsed()])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    async with asyncio.timeout(10):
        while not model.calls:
            await asyncio.sleep(0.01)
    directory = service.db.directory
    await service.stop(timeout=0)
    restarted = runtime.Service(Database(directory))
    await restarted.start()
    SERVICES.append(restarted)
    monkeypatch.setattr(runtime, 'current', restarted)
    await asyncio.sleep(0.15)
    assert len(model.calls) == 1
    state = await task_api.get_task(created['threadId'])
    assert state['state'] == 'INTERRUPTED' and 'resume' in state['allowedActions']
    listing = await task_api.list_tasks(1, 0)
    assert listing['items'][0]['threadId'] == created['threadId']
    assert not listing['hasMore']
    assert not (await task_api.list_tasks(1, 1))['items']
    await task_api.control_task(created['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=state['checkpointId']))
    async with asyncio.timeout(10):
        while await restarted.db.rows("SELECT run_id FROM document_runs WHERE status IN ('pending','running')"):
            await asyncio.sleep(0.01)
    assert (await task_api.get_task(created['threadId']))['state'] == 'COMPLETED'


async def test_sqlite_write_contention_keeps_reads_responsive():
    db = await new_database()
    async def contender():
        async with db.transaction():
            raise AssertionError('Competing writer must not enter')
    try:
        async with db.connection() as owner:
            await owner.execute('BEGIN IMMEDIATE')
            waiting = asyncio.create_task(contender())
            try:
                await asyncio.sleep(.05)
                assert await asyncio.wait_for(db.rows('SELECT 1'), 1)
                with pytest.raises(OperationalError, match='locked'):
                    await asyncio.wait_for(waiting, 7)
            finally:
                await owner.rollback()
                if not waiting.done():
                    waiting.cancel()
                    await asyncio.gather(waiting, return_exceptions=True)
        async with db.transaction() as conn:
            await conn.execute('SELECT 1')
    finally:
        await db.close()


async def test_sqlite_disk_full_rolls_back_without_partial_task():
    db = await new_database()
    try:
        async with db.connection() as conn:
            row = await (await conn.execute('PRAGMA page_count')).fetchone()
            assert row is not None
            pages = row['page_count']
            await conn.execute(f'PRAGMA max_page_count={pages}')
            with pytest.raises(OperationalError, match='full'):
                await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) VALUES('test','hash','document_parser',?,'review',?)", ('"' + 'x' * 1_000_000 + '"', utcnow()))
            await conn.rollback()
        assert not await db.rows('SELECT * FROM document_tasks')
    finally:
        await db.close()


async def test_missing_checkpoint_tables_fail_closed():
    db = await new_database()
    try:
        await db.connections[0].execute('DROP TABLE writes')
        with pytest.raises(RuntimeError, match='Incomplete SQLite state'):
            await db.check_schema()
        assert await db.rows('PRAGMA user_version') == [{'user_version': 1}]
    finally:
        await db.close()

@pytest.mark.parametrize('graph_id', ['docx_parser', 'document_parser'])
async def test_retired_word_tasks_remain_readable_but_never_run(monkeypatch, graph_id):
    from json import dumps

    service, reference, model = await setup_api(monkeypatch)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    thread_id = receipt['threadId']
    legacy = {**reference, 'sourceType': 'docx', 'fileName': 'old.docx'}
    async with service.db.connection() as conn:
        await conn.execute('UPDATE document_tasks SET graph_id=?,document=? WHERE thread_id=?',
                           (graph_id, dumps(legacy), thread_id))
    await service.graphs['document_parser'].aupdate_state(
        {'configurable': {'thread_id': thread_id}},
        {'embeddedRefs': [reference], 'visionResults': [
            {'kind': 'embedded', 'index': 0, 'visuals': [{'description': 'Historical figure'}]}]},
    )
    result = await task_api.get_task(thread_id)
    assert result['progress']['visuals'] == {'total': 1, 'succeeded': 1, 'failed': 0, 'remaining': 0}
    assert (await service.snapshot({'graph_id': graph_id, 'thread_id': thread_id})).values['embeddedRefs'] == [reference]
    assert result['state'] == 'COMPLETED' and result['result']['questions']
    assert not result['allowedActions'] and 'PDF' in result['blocking'][0]
    for action in ('resume', 'retry_failed', 'accept_partial'):
        with pytest.raises(DocumentProcessingError, match='PDF') as error:
            await task_api.control_task(thread_id, DocumentTaskControl(
                requestId=uuid4(), action=action, checkpointId=result['checkpointId']))
        assert error.value.code == 'WORD_FORMAT_REMOVED'
    calls = len(model.calls)
    run = (await service.db.rows('SELECT * FROM document_runs WHERE run_id=?', (receipt['runId'],)))[0]
    await service.execute(run)
    assert len(model.calls) == calls
    result = await task_api.get_task(thread_id)
    assert result['state'] == 'FAILED' and not result['allowedActions']
    assert (await service.db.rows('SELECT error_code FROM document_runs WHERE run_id=?', (receipt['runId'],)))[0]['error_code'] == 'WORD_FORMAT_REMOVED'
    assert await service.ready()
