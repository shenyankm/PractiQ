import asyncio
from unittest.mock import AsyncMock

import pytest

from practiq_ai import temporary
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import isolated


async def test_shared_budget_rejects_overcommit_and_recovers_after_close():
    budget = temporary.Budget(384)
    archive = await budget.acquire(300, timeout=0)
    with pytest.raises(DocumentProcessingError) as error:
        await budget.acquire(100, timeout=0)
    assert error.value.code == 'TEMPORARY_BUSY' and error.value.status_code == 503
    archive.release()
    archive.release()
    work = await budget.acquire(384, timeout=0)
    assert budget.used == 384
    work.release()
    assert budget.used == 0


async def test_budget_wait_cancellation_never_leaks_capacity():
    budget = temporary.Budget(10)
    active = await budget.acquire(10, timeout=0)
    waiting = asyncio.create_task(budget.acquire(5, timeout=30))
    await asyncio.sleep(0)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    active.release()
    assert budget.used == 0
    with pytest.raises(DocumentProcessingError):
        await budget.acquire(11, timeout=0)


async def test_extraction_waits_for_zip_before_creating_any_workspace(monkeypatch):
    budget = temporary.current()
    archive = await budget.acquire(budget.limit, timeout=0)
    worker = AsyncMock()
    monkeypatch.setattr(isolated, '_extract', worker)
    waiting = asyncio.create_task(isolated.extract('text', b'small'))
    await asyncio.sleep(0.02)
    assert not worker.called
    archive.release()
    await waiting
    assert worker.await_count == 1 and budget.used == 0


async def test_preparation_slot_serializes_and_releases_after_failure():
    entered = asyncio.Event()
    async with temporary.preparation(1):
        async def second():
            async with temporary.preparation(1):
                entered.set()
                raise ValueError('failed worker')
        waiting = asyncio.create_task(second())
        await asyncio.sleep(0.02)
        assert not entered.is_set()
    with pytest.raises(ValueError):
        await waiting
    assert temporary.current().used == 0


async def test_budget_wait_has_a_deadline():
    budget = temporary.Budget(10)
    lease = await budget.acquire(10)
    try:
        with pytest.raises(DocumentProcessingError, match='Temporary resources'):
            await budget.acquire(1, timeout=0.01)
        assert budget.used == 10
    finally:
        lease.release()


def test_office_scratch_guard_includes_profiles_and_intermediate_files(tmp_path, monkeypatch):
    from practiq_ai import office
    monkeypatch.setenv('PRACTIQ_OFFICE_WORKSPACE', str(tmp_path))
    (tmp_path / 'profile').mkdir()
    with (tmp_path / 'profile/oversized').open('wb') as stream:
        stream.truncate(301 * 1024 * 1024)
    with pytest.raises(office.OfficeError, match='OFFICE_OUTPUT_LIMIT'):
        office._check_workspace()
