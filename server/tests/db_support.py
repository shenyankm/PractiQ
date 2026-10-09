"""Real disposable PostgreSQL databases for runtime tests."""
import asyncio
import atexit
import os
import subprocess
import time
from typing import Any, cast
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import psycopg
from psycopg import sql

from practiq_ai import execution, task_api
from practiq_ai.database import Database
from tests.support import parsed, setup_graph

DATABASES = []
SERVICES = []


TEST_URI = None


def test_uri():
    global TEST_URI
    if TEST_URI is not None:
        return TEST_URI
    configured = os.environ.get('TEST_DATABASE_URI')
    if configured:
        if urlsplit(configured).scheme not in {'postgresql', 'postgres'}:
            raise ValueError('TEST_DATABASE_URI must be a PostgreSQL URL')
        TEST_URI = configured
        return TEST_URI
    name = 'practiq-tests-' + uuid4().hex
    subprocess.run(['docker', 'run', '--detach', '--name', name, '--publish', '127.0.0.1::5432',
                    '--env', 'POSTGRES_PASSWORD=practiq-test', '--tmpfs', '/var/lib/postgresql/data',
                    'postgres:16'], check=True, capture_output=True, timeout=120)
    atexit.register(lambda: subprocess.run(['docker', 'rm', '--force', name], capture_output=True, check=False, timeout=20))
    port = subprocess.check_output(['docker', 'port', name, '5432/tcp'], text=True, timeout=10).strip().rsplit(':', 1)[1]
    TEST_URI = f'postgresql://postgres:practiq-test@127.0.0.1:{port}/postgres'
    deadline = time.monotonic() + 30
    while True:
        try:
            with psycopg.connect(TEST_URI, connect_timeout=1):
                return TEST_URI
        except psycopg.OperationalError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(.1)


def create_database():
    name = 'practiq_test_' + uuid4().hex
    admin = test_uri()
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    url = urlsplit(admin)
    return urlunsplit((url.scheme, url.netloc, '/' + name, url.query, ''))


async def new_database(initialize=True):
    db = Database(await asyncio.to_thread(create_database))
    DATABASES.append(db)
    await db.open()
    if initialize:
        await db.initialize()
    return db


async def cleanup():
    while SERVICES:
        service = SERVICES.pop()
        await service.stop(timeout=0)
    while DATABASES:
        db = DATABASES.pop()
        await db.close()
        async with await psycopg.AsyncConnection.connect(test_uri(), autocommit=True) as conn:
            name = urlsplit(db.uri).path.lstrip('/')
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
    monkeypatch.setattr(execution, 'get_object_store', lambda: files)
    # Recompile the real parsing workflow with persistent backends and the patched model.
    service.graph = service.graphs['document_parser']
    service.data = db.store
    service.jobs = 'inspect document_runs for runtime state'
    async def finish():
        async with asyncio.timeout(15):
            while await db.rows(f"SELECT run_id FROM document_runs WHERE thread_id IN ({execution.SUPPORTED_TASKS_SQL}) AND status IN ('pending','running')"):
                await asyncio.sleep(0.01)
    service.wait_idle = finish
    return service, reference, model
