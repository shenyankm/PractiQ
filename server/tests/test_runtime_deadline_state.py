import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock

import pytest

from practiq_ai import runtime, telemetry
from practiq_ai.database import Database, utcnow
from practiq_ai.execution import namespace
from tests.support import MemoryStore


@pytest.mark.parametrize('unknown', [False, True])
@pytest.mark.parametrize('expired', [False, True])
async def test_deadline_preserves_only_this_runs_unknown_result(monkeypatch, unknown, expired):
    store = MemoryStore()
    thread_id, run_id = 'deadline-thread', 'deadline-run'
    call = {'status': 'started', 'runId': run_id}
    await store.aput(namespace(thread_id, 'calls'), 'older-run', {**call, 'runId': 'older-run'})
    await store.aput(namespace('other-thread', 'calls'), 'other-thread', call)
    if expired and unknown:
        await store.aput(namespace(thread_id, 'calls'), 'unknown-call', call)
    execute = AsyncMock(return_value=SimpleNamespace(fetchone=AsyncMock(return_value={'thread_id': thread_id})))

    @asynccontextmanager
    async def connection():
        yield SimpleNamespace(execute=execute)

    task = {'graph_id': 'document_parser', 'document': {'sourceType': 'text'},
            'expires_at': utcnow() + timedelta(hours=1)}
    rows = AsyncMock(side_effect=lambda query, _params: [task] if query.startswith('SELECT * FROM document_tasks') else [])
    service = runtime.Service(cast(Database, SimpleNamespace(rows=rows, connection=connection, store=store)))
    service.execution_slots = asyncio.Semaphore(1)
    snapshot = SimpleNamespace(config={}, metadata={}, interrupts=(), values={}, next=('prepare',))
    service.snapshot = AsyncMock(return_value=snapshot)

    async def deadline(*_args, **_kwargs):
        if unknown:
            await store.aput(namespace(thread_id, 'calls'), 'unknown-call', call)
        raise TimeoutError

    service.graphs['document_parser'] = SimpleNamespace(ainvoke=AsyncMock(side_effect=deadline))
    monkeypatch.setattr(runtime, 'require_model_config', lambda: None)
    run = {'run_id': run_id, 'thread_id': thread_id, 'base_checkpoint': None,
           'deadline': utcnow() + timedelta(seconds=-1 if expired else 60),
           'pause_requested': False, 'command': None, 'input': {}, 'context': {}}
    code = 'MODEL_RESULT_UNKNOWN' if unknown else 'RUN_DEADLINE_EXCEEDED'
    counter = telemetry.failures.labels(code)
    before = counter._value.get()
    with telemetry.capture_events() as events:
        await service.execute(run)
    finish = execute.call_args_list[-1].args
    status = 'interrupted' if unknown else 'error'
    assert finish[1][:3] == (status, code, run_id)
    assert counter._value.get() == before + 1
    assert [item for item in events if item['event'] == 'document_run_state'] == [
        {'event': 'document_run_state', 'timestamp': events[-1]['timestamp'],
         'threadId': thread_id, 'runId': run_id, 'status': status, 'errorCode': code},
    ]
    assert service.execution_slots._value == 1
    assert service.graphs['document_parser'].ainvoke.call_count == (0 if expired else 1)
    if unknown:
        saved = await store.aget(namespace(thread_id, 'calls'), 'unknown-call')
        assert saved is not None and saved.value == call
