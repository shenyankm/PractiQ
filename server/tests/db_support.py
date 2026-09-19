"""Real, disposable PostgreSQL databases for runtime tests."""
import asyncio
import os
from typing import Any, cast
from uuid import uuid4

from psycopg import AsyncConnection, sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from practiq_ai import task_api
from practiq_ai.database import Database
from tests.support import parsed, setup_graph

DATABASES = []
SERVICES = []


async def new_database():
    base = os.environ['TEST_DATABASE_URI']
    name = 'practiq_test_' + uuid4().hex
    async with await AsyncConnection.connect(base, autocommit=True) as conn:
        await conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    DATABASES.append((base, name))
    settings = conninfo_to_dict(base)
    settings['dbname'] = name
    db = Database(make_conninfo('', **settings))
    await db.open()
    await db.initialize()
    return db


async def cleanup():
    while SERVICES:
        service = SERVICES.pop()
        if not service.stopping:
            await service.stop(timeout=0)
    while DATABASES:
        base, name = DATABASES.pop()
        async with await AsyncConnection.connect(base, autocommit=True) as conn:
            await conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))


async def setup_api(monkeypatch, responses=None, parts=None):
    from practiq_ai import runtime
    _graph, _store, files, reference, model = setup_graph(monkeypatch, responses if responses is not None else [parsed()], parts=parts)
    db = await new_database()
    service = cast(Any, runtime.Service(db))
    await service.start()
    SERVICES.append(service)
    monkeypatch.setattr(runtime, 'current', service)
    monkeypatch.setattr(task_api, 'get_object_store', lambda: files)
    # Recompile the real parsing workflow with persistent backends and the patched model.
    service.graph = service.graphs['document_parser']
    service.data = db.store
    service.jobs = 'inspect document_runs for runtime state'
    async def finish():
        async with asyncio.timeout(15):
            while await db.rows("SELECT run_id FROM document_runs WHERE status IN ('pending','running')"):
                await asyncio.sleep(0.01)
    service.wait_idle = finish
    return service, reference, model
