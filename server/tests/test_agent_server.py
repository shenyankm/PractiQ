"""Real HTTP process + PostgreSQL recovery acceptance, with no external models."""
import asyncio
import hashlib
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from tests.db_support import new_database

ROOT = Path(__file__).parents[1]


class Server:
    def __init__(self, tmp_path, uri, phase=''):
        self.root = tmp_path
        self.root.mkdir(exist_ok=True)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        self.env = {**os.environ, 'DATABASE_URI': uri, 'AI_STORAGE_DIR': str(tmp_path / 'files'),
                    'TEST_EVENTS': str(tmp_path), 'TEST_PHASE': phase, 'N_JOBS_PER_WORKER': '1',
                    'AI_GRAPH_MAX_CONCURRENCY': '1', 'AI_DEPLOYMENT_WORKERS': '1',
                    'PYTHONPATH': str(ROOT / 'src') + os.pathsep + str(ROOT)}
        self.client = httpx.Client(base_url=f'http://127.0.0.1:{port}', headers={'Authorization': 'Bearer test-token'}, timeout=5)
        self.port = port
        self.process = None
        self.log = None

    def start(self):
        self.log = (self.root / 'server.log').open('a')
        self.process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'tests.runtime_app:app',
            '--host', '127.0.0.1', '--port', str(self.port), '--workers', '1'], cwd=ROOT, env=self.env,
            stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError((self.root / 'server.log').read_text())
            try:
                if self.client.get('/ready').status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.05)
        raise AssertionError('Service did not start')

    def stop(self, kill=False):
        if self.process and self.process.poll() is None:
            self.process.kill() if kill else self.process.terminate()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.log:
            self.log.close()

    def submit(self, review=False):
        payload = b'1. First' if not review else b'1. Different source'
        value = self.client.post('/api/uploads', json={'sourceType': 'text', 'fileName': 'test.txt', 'mediaType': 'text/plain',
            'sha256': hashlib.sha256(payload).hexdigest(), 'sizeBytes': len(payload)}).json()
        if value['upload']:
            self.client.put(value['upload']['url'], content=payload).raise_for_status()
        request = {'requestId': str(uuid4()), 'document': value['document'], 'failurePolicy': 'review' if review else 'return_partial'}
        response = self.client.post('/api/document-tasks', json=request)
        response.raise_for_status()
        assert self.client.post('/api/document-tasks', json=request).json() == response.json()
        return response.json()

    def state(self, receipt):
        response = self.client.get('/api/document-tasks/' + receipt['threadId'])
        response.raise_for_status()
        return response.json()

    def control(self, receipt, action, **kwargs):
        request = {'requestId': str(uuid4()), 'action': action, **kwargs}
        response = self.client.post('/api/document-tasks/' + receipt['threadId'] + '/control', json=request)
        response.raise_for_status()
        return request, response.json()

    def wait(self, receipt, expected):
        state = {}
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            state = self.state(receipt)
            if state['state'] in expected:
                return state
            assert state['state'] != 'FAILED', (state, (self.root / 'server.log').read_text())
            time.sleep(0.05)
        raise AssertionError(state)

    def marker(self, name):
        deadline = time.monotonic() + 20
        while not (self.root / name).exists():
            assert time.monotonic() < deadline, (self.root / 'server.log').read_text()
            time.sleep(0.02)

    def calls(self):
        path = self.root / 'calls'
        return len(path.read_text().splitlines()) if path.exists() else 0


async def prepare(tmp_path, phase=''):
    db = await new_database()
    await db.close()
    # psycopg's DSN is accepted by the runtime; config validates URI in production.
    from psycopg.conninfo import conninfo_to_dict
    v = conninfo_to_dict(db.uri)
    uri = f"postgresql://{v['user']}:{v['password']}@{v['host']}:{v['port']}/{v['dbname']}"
    return Server(tmp_path, uri, phase)


async def test_oss_server_auth_routes_and_graphs(tmp_path):
    server = await prepare(tmp_path)
    try:
        await asyncio.to_thread(server.start)
        assert server.client.get('/ok', headers={'Authorization': ''}).json() == {'ok': True}
        assert server.client.post('/api/uploads', json={}, headers={'Authorization': ''}).status_code == 401
        assert server.client.post('/api/uploads', json={}).status_code == 422
        for route in ['/threads', '/runs', '/store/items', '/assistants/search', '/api/v1/ai/parse-document']:
            assert server.client.post(route, json={}).status_code == 404
        receipt = server.submit()
        state = await asyncio.to_thread(server.wait, receipt, {'COMPLETED'})
        assert state['status'] == 'SUCCEEDED' and len(state['usage']) == 1
        assert 'practiq_workers_max 1' in server.client.get('/api/metrics').text
    finally:
        server.stop(kill=True)
        server.client.close()


@pytest.mark.parametrize('phase', ['queued', 'model', 'model_saved', 'completed'])
async def test_process_kill_automatically_recovers_same_run(tmp_path, phase):
    server = await prepare(tmp_path, phase)
    try:
        await asyncio.to_thread(server.start)
        receipt = server.submit()
        await asyncio.to_thread(server.marker, phase)
        before = server.state(receipt)
        server.stop(kill=True)
        await asyncio.to_thread(server.start)
        after = await asyncio.to_thread(server.wait, receipt, {'COMPLETED'})
        assert after['runId'] == receipt['runId']
        assert after['status'] == 'SUCCEEDED'
        assert server.calls() == 1
        assert len(after['unknownUsageCalls']) == (1 if phase == 'model' else 0)
        if phase != 'queued':
            assert after['modelBudget']['reserved'] == before['modelBudget']['reserved']
    finally:
        server.stop(kill=True)
        server.client.close()


@pytest.mark.parametrize('phase', ['review_before', 'review_after'])
async def test_review_decision_survives_process_kill_without_reapplication(tmp_path, phase):
    server = await prepare(tmp_path, phase)
    try:
        await asyncio.to_thread(server.start)
        receipt = server.submit(review=True)
        waiting = await asyncio.to_thread(server.wait, receipt, {'WAITING_REVIEW'})
        server.stop(kill=True)
        await asyncio.to_thread(server.start)
        assert server.state(receipt)['state'] == 'WAITING_REVIEW'
        request, accepted = server.control(receipt, 'accept_partial', checkpointId=waiting['checkpointId'])
        await asyncio.to_thread(server.marker, phase)
        server.stop(kill=True)
        await asyncio.to_thread(server.start)
        done = await asyncio.to_thread(server.wait, receipt, {'COMPLETED'})
        assert done['runId'] == accepted['runId'] and server.calls() == 1
        assert done['processing']['quality']['reviewRequired']
        assert server.client.post('/api/document-tasks/' + receipt['threadId'] + '/control', json=request).json() == accepted
    finally:
        server.stop(kill=True)
        server.client.close()


async def test_user_interrupt_is_not_automatically_resumed(tmp_path):
    server = await prepare(tmp_path, 'model')
    try:
        await asyncio.to_thread(server.start)
        receipt = server.submit()
        await asyncio.to_thread(server.marker, 'model')
        server.control(receipt, 'interrupt', runId=receipt['runId'])
        interrupted = await asyncio.to_thread(server.wait, receipt, {'INTERRUPTED'})
        server.stop(kill=True)
        await asyncio.to_thread(server.start)
        assert server.state(receipt)['state'] == 'INTERRUPTED'
        assert server.calls() == 0
        server.control(receipt, 'resume', checkpointId=interrupted['checkpointId'])
        state = await asyncio.to_thread(server.wait, receipt, {'COMPLETED'})
        assert len(state['unknownUsageCalls']) == 1 and server.calls() == 1
    finally:
        server.stop(kill=True)
        server.client.close()


async def test_database_lock_loss_exits_process_and_recovery_is_exclusive(tmp_path):
    server = await prepare(tmp_path, 'model')
    from psycopg import AsyncConnection

    from practiq_ai.database import INSTANCE_LOCK
    try:
        await asyncio.to_thread(server.start)
        receipt = server.submit()
        await asyncio.to_thread(server.marker, 'model')
        async with await AsyncConnection.connect(server.env['DATABASE_URI'], autocommit=True) as conn:
            row = await (await conn.execute("SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=%s", (INSTANCE_LOCK,))).fetchone()
            assert row
            await conn.execute('SELECT pg_terminate_backend(%s)', (row[0],))
        assert server.process is not None
        await asyncio.to_thread(server.process.wait, 10)
        assert server.process.returncode == 70
        server.stop()
        await asyncio.to_thread(server.start)
        done = await asyncio.to_thread(server.wait, receipt, {'COMPLETED'})
        assert done['runId'] == receipt['runId'] and len(done['unknownUsageCalls']) == 1
    finally:
        server.stop(kill=True)
        server.client.close()


async def test_manual_pause_remains_paused_after_restart(tmp_path):
    server = await prepare(tmp_path, 'model')
    try:
        await asyncio.to_thread(server.start)
        receipt = server.submit()
        await asyncio.to_thread(server.marker, 'model')
        server.control(receipt, 'pause', runId=receipt['runId'])
        server.stop(kill=True)
        await asyncio.to_thread(server.start)
        state = await asyncio.to_thread(server.wait, receipt, {'PAUSED'})
        server.stop(kill=True)
        await asyncio.to_thread(server.start)
        assert server.state(receipt)['state'] == 'PAUSED'
        server.control(receipt, 'resume', checkpointId=state['checkpointId'])
        done = await asyncio.to_thread(server.wait, receipt, {'COMPLETED'})
        assert done['status'] == 'SUCCEEDED'
    finally:
        server.stop(kill=True)
        server.client.close()
