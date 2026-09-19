"""Explicit database initialization and offline expired-state cleanup."""

import argparse
import asyncio
import os
from contextlib import asynccontextmanager

from .config import load
from .database import INSTANCE_LOCK, Database, watch_ownership
from .execution import namespace


@asynccontextmanager
async def exclusive(db: Database):
    conn = await db.lock_connection()
    monitor = None
    try:
        row = await (await conn.execute('SELECT pg_try_advisory_lock(%s) AS acquired', (INSTANCE_LOCK,))).fetchone()
        if not row or not row['acquired']:
            raise RuntimeError('Stop the service before offline maintenance')
        monitor = asyncio.create_task(watch_ownership(conn, lambda: os._exit(70)))
        yield
    finally:
        if monitor:
            monitor.cancel()
            await asyncio.gather(monitor, return_exceptions=True)
        await conn.close()


async def cleanup(db: Database) -> int:
    if not load().maintenance:
        raise RuntimeError('Cleanup requires AI_MAINTENANCE_MODE=true')
    async with exclusive(db):
        tasks = await db.rows("SELECT thread_id FROM document_tasks t WHERE expires_at <= now() AND NOT EXISTS (SELECT 1 FROM document_runs r WHERE r.thread_id=t.thread_id AND r.status IN ('pending','running'))")
        for task in tasks:
            thread_id = task['thread_id']
            await db.checkpointer.adelete_thread(thread_id)
            while items := await db.store.asearch(namespace(thread_id, '')[:2], limit=100, refresh_ttl=False):
                for item in items:
                    await db.store.adelete(item.namespace, item.key)
            async with db.transaction() as conn:
                await conn.execute('DELETE FROM document_receipts WHERE thread_id=%s', (thread_id,))
                await conn.execute('DELETE FROM document_runs WHERE thread_id=%s', (thread_id,))
                await conn.execute('DELETE FROM document_tasks WHERE thread_id=%s', (thread_id,))
        return len(tasks)


async def run(action: str):
    db = Database()
    await db.open()
    try:
        if action == 'init-db':
            async with exclusive(db):
                await db.initialize()
            print('Initialized dedicated OSS task database')
        else:
            await db.check_schema()
            print(f'Expired tasks removed: {await cleanup(db)}')
    finally:
        await db.close()


def main():
    from dotenv import load_dotenv

    from .config import SERVER_ROOT
    load_dotenv(SERVER_ROOT.parent / '.env', override=False)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['init-db', 'cleanup-state'])
    asyncio.run(run(parser.parse_args().action))


if __name__ == '__main__':
    main()
