"""Bounded connection reuse keeps transactions isolated and never replays failed work."""

import asyncio

import pytest
from psycopg import OperationalError

from tests.db_support import new_database

pytestmark = pytest.mark.usefixtures('disposable_databases')


async def test_short_connections_reuse_backend_and_rollback_failures():
    db = await new_database()
    backends = []
    for _ in range(3):
        async with db.connection() as conn:
            backends.append(conn.info.backend_pid)
    assert len(set(backends)) == 1
    async with db.connection() as conn:
        await conn.execute('CREATE TABLE connection_probe(value integer)')
    with pytest.raises(ValueError, match='cancel write'):
        async with db.connection() as conn:
            await conn.execute('BEGIN')
            await conn.execute('INSERT INTO connection_probe VALUES(1)')
            raise ValueError('cancel write')
    async with db.connection() as conn:
        assert conn.info.backend_pid != backends[0]
        row = await (await conn.execute('SELECT count(*) AS n FROM connection_probe')).fetchone()
        assert row is not None and row['n'] == 0


async def test_cancelled_borrower_discards_connection_and_rolls_back():
    db = await new_database()
    async with db.connection() as conn:
        await conn.execute('CREATE TABLE cancellation_probe(value integer)')
    entered = asyncio.Event()
    pid = None
    async def write():
        nonlocal pid
        async with db.connection() as conn:
            pid = conn.info.backend_pid
            await conn.execute('BEGIN')
            await conn.execute('INSERT INTO cancellation_probe VALUES(1)')
            entered.set()
            await asyncio.Event().wait()
    pending = asyncio.create_task(write())
    await asyncio.wait_for(entered.wait(), 2)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    async with db.connection() as conn:
        assert conn.info.backend_pid != pid
        row = await (await conn.execute('SELECT count(*) AS n FROM cancellation_probe')).fetchone()
        assert row is not None and row['n'] == 0


async def test_cancelled_transaction_entry_discards_driver_transaction_state(monkeypatch):
    from psycopg.transaction import AsyncTransaction
    db = await new_database()
    enter = AsyncTransaction.__aenter__
    async def cancelled(transaction):
        await enter(transaction)
        raise asyncio.CancelledError
    with monkeypatch.context() as patch:
        patch.setattr(AsyncTransaction, '__aenter__', cancelled)
        with pytest.raises(asyncio.CancelledError):
            async with db.transaction():
                pytest.fail('Cancelled entry must not reach business SQL')
    async with db.transaction() as conn:
        assert await (await conn.execute('SELECT 1')).fetchone()


async def test_borrowers_are_bounded_and_cancelled_waiters_release_capacity():
    db = await new_database()
    release = asyncio.Event()
    entered = asyncio.Event()
    backends = []
    async def borrow():
        async with db.connection() as conn:
            backends.append(conn.info.backend_pid)
            if len(backends) == 4:
                entered.set()
            await release.wait()
    borrowers = [asyncio.create_task(borrow()) for _ in range(4)]
    await asyncio.wait_for(entered.wait(), 2)
    async def fifth():
        async with db.connection():
            raise AssertionError('All four slots are still borrowed')
    waiting = asyncio.create_task(fifth())
    # Let it enter the semaphore wait without relying on wall-clock sleeps.
    await asyncio.sleep(0)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    release.set()
    await asyncio.gather(*borrowers)
    assert len(set(backends)) == 4
    async with db.connection() as conn:
        assert conn.info.backend_pid in backends


async def test_broken_connection_is_discarded_without_retry_and_close_reaps_borrowed_connections():
    db = await new_database()
    async with db.connection() as conn:
        pid = conn.info.backend_pid
    await db.rows('SELECT pg_terminate_backend(%s)', (pid,))
    with pytest.raises(OperationalError):
        async with db.connection() as conn:
            await conn.execute('SELECT 1')
    async with db.connection() as conn:
        assert conn.info.backend_pid != pid
        await db.close()
    assert conn.closed
    await db.open()
    assert await db.rows('SELECT 1')
