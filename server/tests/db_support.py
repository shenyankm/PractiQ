"""Real disposable SQLite databases for runtime tests."""
import asyncio
from tempfile import TemporaryDirectory
from typing import Any, cast

from practiq_ai import execution, task_api
from practiq_ai.database import Database
from tests.support import parsed, setup_graph

DATABASES = []
SERVICES = []


async def new_database(initialize=True):
    directory = TemporaryDirectory(prefix='practiq-test-')
    db = Database(directory.name)
    DATABASES.append((directory, db))
    await db.open()
    if initialize:
        await db.initialize()
    return db


async def cleanup():
    while SERVICES:
        service = SERVICES.pop()
        if not service.stopping:
            await service.stop(timeout=0)
    while DATABASES:
        directory, db = DATABASES.pop()
        await db.close()
        directory.cleanup()


async def setup_api(monkeypatch, responses=None, parts=None):
    from practiq_ai import runtime
    _graph, _store, files, reference, model = setup_graph(monkeypatch, responses if responses is not None else [parsed()], parts=parts)
    db = await new_database()
    service = cast(Any, runtime.Service(db))
    await service.start()
    SERVICES.append(service)
    monkeypatch.setattr(runtime, 'current', service)
    monkeypatch.setattr(task_api, 'get_object_store', lambda: files)
    monkeypatch.setattr(execution, 'get_object_store', lambda: files)
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
