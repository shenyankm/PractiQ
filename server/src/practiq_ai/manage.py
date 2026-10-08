"""Explicit database initialization and offline expired-state cleanup."""

import argparse
import asyncio
import os
from contextlib import asynccontextmanager

from .config import load
from .database import Database, watch_ownership
from .execution import namespace


@asynccontextmanager
async def exclusive(db: Database):
    conn = db.acquire('Stop the service before offline maintenance')
    monitor = None
    try:
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
        retained = {row['thread_id'] for row in await db.rows('SELECT thread_id FROM document_tasks')}
        # Interrupted API deletion can leave state after its task record was committed away.
        async with db.checkpointer.lock, db.connections[0].execute(
            'SELECT thread_id FROM checkpoints UNION SELECT thread_id FROM writes'
        ) as cursor:
            orphaned = {row[0] for row in await cursor.fetchall()} - retained
        offset = 0
        while namespaces := await db.store.alist_namespaces(prefix=('document_tasks',), max_depth=2, limit=100, offset=offset):
            orphaned.update(parts[1] for parts in namespaces if len(parts) == 2 and parts[1] not in retained)
            offset += len(namespaces)
        threads = {task['thread_id'] for task in tasks} | orphaned
        for thread_id in sorted(threads):
            await db.checkpointer.adelete_thread(thread_id)
            while items := await db.store.asearch(namespace(thread_id, '')[:2], limit=100, refresh_ttl=False):
                for item in items:
                    await db.store.adelete(item.namespace, item.key)
            async with db.transaction() as conn:
                await conn.execute('DELETE FROM document_receipts WHERE thread_id=?', (thread_id,))
                await conn.execute('DELETE FROM document_runs WHERE thread_id=?', (thread_id,))
                await conn.execute('DELETE FROM document_tasks WHERE thread_id=?', (thread_id,))
        return len(threads)


async def run(action: str):
    db = Database()
    await db.open()
    try:
        if action == 'init-db':
            async with exclusive(db):
                await db.initialize()
            print('Initialized dedicated SQLite task database')
        else:
            await db.check_schema()
            print(f'Task states removed: {await cleanup(db)}')
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
