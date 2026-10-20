import asyncio
from contextlib import AsyncExitStack
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from langgraph.store.memory import InMemoryStore
from pydantic import ValidationError

from practiq_ai import runtime, tencent
from practiq_ai.contracts import ImportSettings, ImportSettingsSnapshot
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.import_control import ImportControl
from practiq_ai.webapp import app
from tests.db_support import SERVICES, setup_api


@pytest.mark.parametrize('values', [
    {'tencentConcurrency': 0}, {'tencentConcurrency': 6}, {'tencentConcurrency': True},
    {'readRetryCount': -1}, {'readRetryCount': 6}, {'readRetryCount': '2'},
    {'retryBaseSeconds': 0}, {'retryBaseSeconds': float('nan')}, {'retryBaseSeconds': 11}, {'extra': 1},
])
def test_import_settings_reject_unsafe_or_unknown_values(values):
    with pytest.raises(ValidationError):
        ImportSettings.model_validate({'tencentConcurrency': 5, 'readRetryCount': 2, 'retryBaseSeconds': 1, **values})


async def test_lowering_concurrency_drains_existing_slots_and_preserves_cancelled_waiters():
    control = ImportControl()
    store = InMemoryStore()
    async with AsyncExitStack() as stack:
        await stack.enter_async_context(control.slot(AsyncMock()))
        await stack.enter_async_context(control.slot(AsyncMock()))
        await control.save(store, ImportSettingsSnapshot(revision=control.snapshot.revision, settings=ImportSettings(tencentConcurrency=1, readRetryCount=2, retryBaseSeconds=1)))
        async def wait():
            async with control.slot(AsyncMock()):
                assert control.active == 1
        cancelled = asyncio.create_task(wait())
        await asyncio.sleep(0)
        assert not cancelled.done() and control.active == 2
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        remaining = asyncio.create_task(wait())
        await asyncio.sleep(0)
        assert not remaining.done()
    await asyncio.wait_for(remaining, 1)
    assert control.active == 0


async def test_cancelled_work_releases_capacity_while_settings_storage_is_blocked():
    control = ImportControl()
    working, saving, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def write(*_args, **_kwargs):
        saving.set()
        await release.wait()
    async def work():
        async with control.slot(AsyncMock()):
            working.set()
            await asyncio.Event().wait()
    task = asyncio.create_task(work())
    await working.wait()
    save = asyncio.create_task(control.save(SimpleNamespace(aput=write), control.snapshot))
    try:
        await saving.wait()
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert control.active == 0
    finally:
        release.set()
        await save


@pytest.mark.parametrize('retries', [0, 1, 5])
async def test_configured_read_retries_and_base_delay_do_not_repeat_submissions(monkeypatch, retries):
    control = ImportControl()
    control.snapshot = ImportSettingsSnapshot(revision=uuid4(), settings=ImportSettings(tencentConcurrency=5, readRetryCount=retries, retryBaseSeconds=2))
    context = SimpleNamespace(context={'importControl': control}, execution_info=None)
    monkeypatch.setattr(tencent, 'guard', AsyncMock())
    monkeypatch.setattr(tencent, 'run_remaining', AsyncMock(return_value=1000))
    monkeypatch.setattr(tencent.random, 'uniform', lambda *_: 1)
    sleep = AsyncMock()
    monkeypatch.setattr(tencent.asyncio, 'sleep', sleep)
    operation = AsyncMock(side_effect=tencent.RequestRejected('RequestLimitExceeded', 'safe-request'))
    with pytest.raises(tencent.RequestRejected):
        await tencent._read(cast(Any, context), 'tencent_query', operation)
    assert operation.await_count == retries + 1
    assert sum(call.args[0] for call in sleep.await_args_list) == 2 * (2 ** retries - 1)
    assert all(0 < call.args[0] <= 1 for call in sleep.await_args_list)


@pytest.mark.usefixtures('disposable_databases')
async def test_authenticated_settings_survive_service_restart_and_reject_stale_writes(monkeypatch):
    service, _, model = await setup_api(monkeypatch)
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'test-token')
    headers = {'Authorization': 'Bearer test-token'}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
        assert (await http.get('/api/import-settings')).status_code == 401
        assert (await http.put('/api/import-settings', json={})).status_code == 401
        original = (await http.get('/api/import-settings', headers=headers)).json()
        value = {**original, 'settings': {'tencentConcurrency': 2, 'readRetryCount': 0, 'retryBaseSeconds': 2}}
        invalid = await http.put('/api/import-settings', headers=headers, json={**value, 'settings': {'tencentConcurrency': 6}})
        assert invalid.status_code == 422
        assert (await http.get('/api/import-settings', headers=headers)).json() == original
        saved = await http.put('/api/import-settings', headers=headers, json=value)
        assert saved.status_code == 200 and saved.json()['settings'] == value['settings']
        assert saved.json()['revision'] != original['revision']
        assert (await http.put('/api/import-settings', headers=headers, json=value)).status_code == 409
        await service.stop(timeout=0)
        restarted = runtime.Service(service.db)
        await restarted.start()
        SERVICES.append(restarted)
        monkeypatch.setattr(runtime, 'current', restarted)
        assert (await http.get('/api/import-settings', headers=headers)).json() == saved.json()
        monkeypatch.setenv('AI_READ_ONLY', '1')
        assert (await http.put('/api/import-settings', headers=headers, json=saved.json())).status_code == 409
        assert (await http.get('/api/import-settings', headers=headers)).json() == saved.json()
    assert not model.calls


@pytest.mark.parametrize('omitted', ['tencentConcurrency', 'readRetryCount', 'retryBaseSeconds'])
@pytest.mark.usefixtures('disposable_databases')
async def test_settings_put_rejects_incomplete_snapshots_without_overwriting_saved_values(monkeypatch, omitted):
    await setup_api(monkeypatch)
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'test-token')
    headers = {'Authorization': 'Bearer test-token'}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
        initial = (await http.get('/api/import-settings', headers=headers)).json()
        value = {**initial, 'settings': {'tencentConcurrency': 2, 'readRetryCount': 4, 'retryBaseSeconds': 3}}
        saved = (await http.put('/api/import-settings', headers=headers, json=value)).json()
        incomplete = {**saved, 'settings': {key: value for key, value in saved['settings'].items() if key != omitted}}
        assert (await http.put('/api/import-settings', headers=headers, json=incomplete)).status_code == 422
        assert (await http.get('/api/import-settings', headers=headers)).json() == saved


async def test_long_read_backoff_observes_pause_within_one_second_without_replaying_the_read(monkeypatch):
    control = ImportControl()
    control.snapshot = ImportSettingsSnapshot(revision=uuid4(), settings=ImportSettings(tencentConcurrency=5, readRetryCount=5, retryBaseSeconds=10))
    context = SimpleNamespace(context={'importControl': control}, execution_info=None)
    paused = False
    delays = []
    async def check(_runtime):
        if paused:
            raise DocumentProcessingError(409, 'pause', 'TASK_PAUSED')
    async def sleep(delay):
        nonlocal paused
        delays.append(delay)
        paused = True
    monkeypatch.setattr(tencent, 'guard', check)
    monkeypatch.setattr(tencent, 'run_remaining', AsyncMock(return_value=1000))
    monkeypatch.setattr(tencent.random, 'uniform', lambda *_: 1.2)
    monkeypatch.setattr(tencent.asyncio, 'sleep', sleep)
    operation = AsyncMock(side_effect=tencent.RequestRejected('RequestLimitExceeded', 'safe-request'))
    with pytest.raises(DocumentProcessingError) as error:
        await tencent._read(cast(Any, context), 'tencent_query', operation)
    assert error.value.code == 'TASK_PAUSED'
    assert delays == [1]
    assert operation.await_count == 1
