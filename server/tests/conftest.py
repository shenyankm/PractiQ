import os
import subprocess
import time
from uuid import uuid4

import psycopg
import pytest


@pytest.fixture(scope='session', autouse=True)
def postgres_server():
    """CI supplies PostgreSQL; local runs own one disposable Docker container."""
    if os.environ.get('TEST_DATABASE_URI'):
        yield
        return
    name = 'practiq-tests-' + uuid4().hex[:12]
    subprocess.run(['docker', 'run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=isolated-test-only',
                    '-p', '127.0.0.1::5432', 'postgres:16-bookworm'], check=True, capture_output=True)
    try:
        port = subprocess.check_output(['docker', 'port', name, '5432'], text=True).strip().rsplit(':', 1)[1]
        uri = f'postgresql://postgres:isolated-test-only@127.0.0.1:{port}/postgres'
        for _ in range(100):
            try:
                with psycopg.connect(uri):
                    break
            except psycopg.OperationalError:
                time.sleep(0.1)
        else:
            raise RuntimeError('Test PostgreSQL did not start')
        os.environ['TEST_DATABASE_URI'] = uri
        yield
    finally:
        os.environ.pop('TEST_DATABASE_URI', None)
        subprocess.run(['docker', 'rm', '-f', name], check=True, capture_output=True)


@pytest.fixture(autouse=True)
async def disposable_databases():
    yield
    from tests.db_support import cleanup
    await cleanup()
