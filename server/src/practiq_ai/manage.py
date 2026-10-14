"""Explicit database initialization and offline expired-state cleanup."""

import argparse
import asyncio
import os
from contextlib import asynccontextmanager
from uuid import UUID

from .config import load
from .database import Database, watch_ownership
from .saas import cleanup_task_store


@asynccontextmanager
async def exclusive(db: Database):
    conn = await db.acquire('Stop the service before offline maintenance')
    monitors = []
    payment_owner = None
    try:
        payment_owner = await db.acquire('Stop the payment service before offline maintenance', slot=3)
        for owner in (conn, payment_owner):
            monitors.append(asyncio.create_task(watch_ownership(owner, lambda: os._exit(70))))
        yield
    finally:
        for monitor in monitors:
            monitor.cancel()
        await asyncio.gather(*monitors, return_exceptions=True)
        if payment_owner:
            await payment_owner.close()
        await conn.close()


async def cleanup(db: Database) -> int:
    if not load().maintenance:
        raise RuntimeError('Cleanup requires AI_MAINTENANCE_MODE=true')
    async with exclusive(db):
        tasks = await db.rows("SELECT thread_id FROM document_tasks t WHERE expires_at <= now() AND NOT EXISTS (SELECT 1 FROM document_runs r WHERE r.thread_id=t.thread_id AND r.status IN ('pending','running'))")
        retained = {row['thread_id'] for row in await db.rows('SELECT thread_id FROM document_tasks')}
        # Interrupted API deletion can leave state after its task record was committed away.
        async with db.checkpointer.lock, db.connections[0].cursor() as cursor:
            await cursor.execute(
                'SELECT thread_id FROM checkpoints UNION SELECT thread_id FROM checkpoint_writes UNION SELECT thread_id FROM checkpoint_blobs'
            )
            orphaned = {row['thread_id'] for row in await cursor.fetchall()} - retained
        offset = 0
        while namespaces := await db.store.alist_namespaces(prefix=('document_tasks',), max_depth=2, limit=100, offset=offset):
            orphaned.update(parts[1] for parts in namespaces if len(parts) == 2 and parts[1] not in retained)
            offset += len(namespaces)
        threads = {task['thread_id'] for task in tasks} | orphaned
        for thread_id in sorted(threads):
            await db.checkpointer.adelete_thread(thread_id)
            await cleanup_task_store(db, thread_id)
            async with db.transaction() as conn:
                await conn.execute('DELETE FROM document_receipts WHERE thread_id=%s', (thread_id,))
                await conn.execute('DELETE FROM document_runs WHERE thread_id=%s', (thread_id,))
                await conn.execute('DELETE FROM document_tasks WHERE thread_id=%s', (thread_id,))
        return len(threads)


async def replay_run(db: Database, run_id: str):
    """Explicitly republish an unfinished dead-lettered run without new model consent."""
    from .execution import require_supported_task
    from .runtime import Service

    if str(UUID(run_id)) != run_id:
        raise ValueError('A canonical run UUID is required')
    async with exclusive(db):
        rows = await db.rows('SELECT r.*,t.graph_id,t.document FROM document_runs r JOIN document_tasks t USING(thread_id) WHERE run_id=%s', (run_id,))
        if not rows or rows[0]['status'] != 'pending' or rows[0]['cancel_requested']:
            raise RuntimeError('Only an unfinished pending run can be replayed; use explicit API recovery for stopped runs')
        require_supported_task(rows[0])
        if await Service(db).unknown_calls(rows[0]):
            raise RuntimeError('Model result unknown; use explicit API recovery instead of dead-letter replay')
        async with db.transaction() as conn:
            await conn.execute('INSERT INTO document_outbox(run_id) VALUES (%s) ON CONFLICT(run_id) DO UPDATE SET published_at=NULL', (run_id,))


async def run(action: str, run_id: str | None = None):
    db = Database()
    await db.open()
    try:
        if action == 'init-db':
            async with exclusive(db):
                await db.initialize()
            print('Initialized dedicated PostgreSQL service database')
        elif action == 'upgrade-db':
            from .graphs.document import build_document_graph
            from .runtime import GRAPH_FORMATS, Service

            async with exclusive(db):
                await db.upgrade()
                service = Service(db)
                service.graphs = {name: build_document_graph(db.checkpointer, store=db.store, name=name, source_types=types)
                                  for name, types in GRAPH_FORMATS.items()}
                await service.reconcile(stop_unknown=True)
            print('Upgraded PostgreSQL service schema and staged recoverable runs; no models executed')
        elif action == 'replay-run':
            await db.check_schema()
            if run_id is None:
                raise ValueError('replay-run requires --run-id')
            await replay_run(db, run_id)
            print('Staged the existing run for confirmed publication; original dead letter is retained')
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
    parser.add_argument('action', choices=['init-db', 'upgrade-db', 'replay-run', 'cleanup-state'])
    parser.add_argument('--run-id')
    args = parser.parse_args()
    asyncio.run(run(args.action, args.run_id))


if __name__ == '__main__':
    main()
