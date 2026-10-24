"""Pure HTTP regressions for task reads, settings errors and paused controls."""

from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from langgraph.types import Interrupt, StateSnapshot
from psycopg import OperationalError

from practiq_ai import runtime, task_api, webapp
from practiq_ai.contracts import ArtifactReference
from practiq_ai.database import utcnow
from practiq_ai.import_control import ImportControl
from tests.support import MemoryStore, source


@pytest.fixture
async def http(monkeypatch):
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'test-token')
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=webapp.app, raise_app_exceptions=False),
        base_url='http://test', headers={'Authorization': 'Bearer test-token'},
    ) as client:
        yield client


@pytest.fixture
def saved_tasks(monkeypatch):
    files, reference = source('Synthetic saved source')
    tasks, runs, snapshots = {}, {}, {}
    for _ in range(2):
        thread_id, run_id = str(uuid4()), str(uuid4())
        tasks[thread_id] = {
            'thread_id': thread_id, 'graph_id': 'document_parser', 'document': reference,
            'failure_policy': 'return_partial', 'parent_thread_id': None,
            'created_at': utcnow(), 'expires_at': utcnow() + timedelta(days=1),
        }
        runs[thread_id] = {
            'thread_id': thread_id, 'run_id': run_id, 'status': 'success',
            'error_code': None, 'pause_requested': False, 'cancel_requested': False,
            'started_at': utcnow(),
        }
        snapshots[thread_id] = StateSnapshot(
            values={'status': 'SUCCEEDED'}, next=(),
            config={'configurable': {'checkpoint_id': str(uuid4())}},
            metadata=None, created_at=None, parent_config=None, tasks=(), interrupts=(),
        )

    async def rows(sql, params=()):
        if 'FROM document_tasks' in sql and sql.startswith('SELECT t.*'):
            return list(tasks.values())[:params[-2]]
        if sql.startswith('SELECT * FROM document_tasks WHERE thread_id='):
            return [tasks[params[0]]] if params[0] in tasks else []
        if sql.startswith('SELECT * FROM document_runs WHERE run_id IN'):
            return [runs[thread_id] for thread_id in params[0]]
        if sql.startswith('SELECT * FROM document_runs WHERE thread_id='):
            return [runs[params[0]]]
        pytest.fail(f'Unexpected fixture query: {sql}')

    async def snapshot(task):
        value = snapshots[task['thread_id']]
        if isinstance(value, Exception):
            raise value
        return value

    async def checkpoint_heads(thread_ids):
        return {thread_id: 'saved-head' for thread_id in thread_ids}

    async def execute(sql, params=()):
        assert sql.startswith('SELECT r.*, t.expires_at'), sql
        return SimpleNamespace(fetchone=AsyncMock(return_value=None))

    @asynccontextmanager
    async def connection():
        yield SimpleNamespace(execute=execute)

    db = SimpleNamespace(
        rows=AsyncMock(side_effect=rows), store=MemoryStore(),
        checkpoint_heads=AsyncMock(side_effect=checkpoint_heads),
        connection=connection, transaction=connection,
    )
    service = SimpleNamespace(
        db=db, accepting=True, snapshot=AsyncMock(side_effect=snapshot),
        checkpoint_id=runtime.Service.checkpoint_id, task_summaries=OrderedDict(),
        import_control=ImportControl(),
    )
    monkeypatch.setattr(runtime, 'current', service)
    monkeypatch.setattr(task_api, 'get_object_store', lambda: files)
    monkeypatch.setattr(webapp, 'get_object_store', lambda: files)
    return SimpleNamespace(service=service, tasks=tasks, runs=runs, snapshots=snapshots,
                           files=files, reference=reference)


@pytest.mark.parametrize('run_status', ['success', 'waiting'])
@pytest.mark.parametrize('read', ['list', 'detail', 'head'])
async def test_unreadable_terminal_checkpoint_degrades_without_breaking_task_reads(http, saved_tasks, run_status, read):
    healthy, damaged = saved_tasks.tasks
    path = {
        'list': '/api/document-tasks',
        'detail': f'/api/document-tasks/{damaged}',
        'head': f'/api/document-tasks/{damaged}/head',
    }[read]
    assert (await http.get(path, headers={'Authorization': 'Bearer wrong'})).status_code == 401
    before = await http.get(path)
    assert before.status_code == 200, before.text
    saved_tasks.runs[damaged]['status'] = run_status
    saved_tasks.snapshots[damaged] = ValueError('synthetic unreadable checkpoint')
    saved_tasks.service.task_summaries.clear()
    healthy_head = await http.get(f'/api/document-tasks/{healthy}/head')
    assert healthy_head.status_code == 200 and healthy_head.json()['state'] == 'COMPLETED'

    response = await http.get(path)
    assert response.status_code == 200, response.text
    wire = response.json()
    if read == 'list':
        items = {item['threadId']: item for item in wire['items']}
        assert set(items) == {healthy, damaged}
        assert items[healthy]['state'] == 'COMPLETED'
        assert items[damaged]['state'] == 'FAILED'
    else:
        assert wire['state'] == 'FAILED' and not wire['resumeCompatible']
        if read == 'detail':
            assert wire['blocking'] == ['TASK_CHECKPOINT_UNREADABLE']
            assert wire['allowedActions'] == [] and wire['result'] is None
    assert saved_tasks.runs[damaged]['status'] == run_status
    assert saved_tasks.runs[damaged]['error_code'] is None


@pytest.mark.parametrize('action', ['resume', 'retry_failed', 'accept_partial'])
async def test_unreadable_checkpoint_cannot_admit_model_work(http, saved_tasks, action):
    thread_id = next(iter(saved_tasks.tasks))
    saved_tasks.snapshots[thread_id] = ValueError('synthetic unreadable checkpoint')
    detail = (await http.get(f'/api/document-tasks/{thread_id}')).json()
    response = await http.post(f'/api/document-tasks/{thread_id}/control', json={
        'requestId': str(uuid4()), 'action': action, 'checkpointId': detail['checkpointId'],
    })
    assert response.status_code == 409 and response.json()['detail']['code'] == 'TASK_CHECKPOINT_UNREADABLE'
    assert saved_tasks.runs[thread_id]['status'] == 'success'


@pytest.mark.parametrize('failure,status,code', [
    (OperationalError('synthetic database outage'), 503, 'TASK_SERVICE_UNAVAILABLE'),
    (TimeoutError('synthetic read deadline'), 504, 'CONTROL_TIMEOUT'),
])
async def test_checkpoint_infrastructure_failures_are_not_quarantined(http, saved_tasks, failure, status, code):
    thread_id = next(iter(saved_tasks.tasks))
    saved_tasks.snapshots[thread_id] = failure
    response = await http.get(f'/api/document-tasks/{thread_id}')
    assert response.status_code == status and response.json()['detail']['code'] == code
    assert saved_tasks.runs[thread_id]['status'] == 'success'
    assert saved_tasks.runs[thread_id]['error_code'] is None


@pytest.mark.parametrize('method', ['GET', 'PUT'])
@pytest.mark.parametrize('unavailable', ['absent', 'draining'])
async def test_import_settings_map_unavailable_runtime_to_structured_503(http, monkeypatch, method, unavailable):
    control = ImportControl()
    monkeypatch.setattr(runtime, 'current', None if unavailable == 'absent' else SimpleNamespace(accepting=False))
    body = {'json': control.snapshot.model_dump(mode='json')} if method == 'PUT' else {}
    assert (await http.request(method, '/api/import-settings', headers={'Authorization': 'Bearer wrong'}, **body)).status_code == 401
    comparison = await http.get('/api/document-tasks')
    assert comparison.status_code == 503 and comparison.json()['detail']['code'] == 'TASK_SERVICE_UNAVAILABLE'

    response = await http.request(method, '/api/import-settings', **body)
    assert response.status_code == 503, response.text
    assert response.json()['detail']['code'] == 'TASK_SERVICE_UNAVAILABLE'


async def test_import_settings_map_store_write_error_to_structured_503(http, saved_tasks, monkeypatch):
    control = saved_tasks.service.import_control
    original = control.snapshot.model_dump(mode='json')
    write = AsyncMock(side_effect=OperationalError('synthetic store outage'))
    monkeypatch.setattr(saved_tasks.service.db.store, 'aput', write)
    response = await http.put('/api/import-settings', json=original)
    write.assert_awaited_once()
    assert control.snapshot.model_dump(mode='json') == original
    assert response.status_code == 503, response.text
    assert response.json()['detail']['code'] == 'TASK_SERVICE_UNAVAILABLE'


@pytest.mark.parametrize('quarantined', [False, True])
async def test_artifact_read_honors_unreadable_checkpoint_quarantine(http, saved_tasks, monkeypatch, quarantined):
    thread_id = next(iter(saved_tasks.tasks))
    if quarantined:
        saved_tasks.runs[thread_id].update(status='error', error_code='TASK_CHECKPOINT_UNREADABLE')
    saved_tasks.snapshots[thread_id] = ValueError('synthetic private checkpoint content')
    reference = ArtifactReference(
        objectKey=f"practiq-agent/artifacts/{saved_tasks.reference['sha256']}/chunks/0.json",
        sha256='0' * 64, mediaType='application/json', sizeBytes=1,
    ).model_dump(mode='json')
    endpoint = f'/api/artifacts/read?thread_id={thread_id}'
    download = AsyncMock(wraps=saved_tasks.files.get_verified)
    monkeypatch.setattr(saved_tasks.files, 'get_verified', download)
    assert (await http.post(endpoint, json=reference, headers={'Authorization': 'Bearer wrong'})).status_code == 401
    assert (await http.post('/api/artifacts/read', json=reference)).status_code == 404
    assert (await http.post('/api/artifacts/read?thread_id=invalid', json=reference)).status_code == 422
    assert (await http.post(f'/api/artifacts/read?thread_id={uuid4()}', json=reference)).status_code == 404
    foreign = {**reference, 'objectKey': reference['objectKey'].replace(saved_tasks.reference['sha256'], 'f' * 64)}
    assert (await http.post(endpoint, json=foreign)).status_code == 404
    saved_tasks.service.snapshot.assert_not_awaited()
    detail = await http.get(f'/api/document-tasks/{thread_id}')
    assert detail.status_code == 200 and detail.json()['blocking'] == ['TASK_CHECKPOINT_UNREADABLE']
    assert detail.json()['allowedActions'] == [] and not detail.json()['resumeCompatible']
    saved_tasks.service.snapshot.reset_mock()
    # The immutable source remains readable without consulting a quarantined checkpoint.
    source_ref = {key: saved_tasks.reference[key] for key in ('objectKey', 'sha256', 'mediaType', 'sizeBytes')}
    source_response = await http.post(endpoint, json=source_ref)
    assert source_response.status_code == 200 and source_response.content == b'Synthetic saved source'
    download.reset_mock()

    response = await http.post(endpoint, json=reference)
    assert response.status_code == 404, response.text
    assert response.json()['detail']['code'] == 'ARTIFACT_NOT_FOUND'
    if quarantined:
        saved_tasks.service.snapshot.assert_not_awaited()
    download.assert_not_awaited()


@pytest.mark.parametrize('run_status,state', [('interrupted', 'CANCELLED'), ('error', 'FAILED')])
async def test_cancelled_paused_checkpoint_does_not_advertise_rejected_retry(http, saved_tasks, run_status, state):
    thread_id = next(iter(saved_tasks.tasks))
    saved_tasks.runs[thread_id].update(status=run_status, cancel_requested=True, started_at=None)
    snapshot = saved_tasks.snapshots[thread_id]
    saved_tasks.snapshots[thread_id] = snapshot._replace(
        values={'document': saved_tasks.reference, 'phase': 'chunk',
                'chunkResults': [{'index': 0, 'parsed': None, 'failureCode': 'OUTPUT_INVALID'}]},
        next=('chunk_gate',), interrupts=(Interrupt(value={'kind': 'pause'}, id='saved-pause'),),
    )
    endpoint = f'/api/document-tasks/{thread_id}'
    assert (await http.get(endpoint, headers={'Authorization': 'Bearer wrong'})).status_code == 401
    response = await http.get(endpoint)
    assert response.status_code == 200, response.text
    detail = response.json()
    assert detail['state'] == state and detail['failures'][0]['retryable']
    request = {'requestId': str(uuid4()), 'action': 'retry_failed', 'checkpointId': detail['checkpointId']}
    assert (await http.post(endpoint + '/control', json=request,
                            headers={'Authorization': 'Bearer wrong'})).status_code == 401
    retry = await http.post(endpoint + '/control', json=request)
    assert retry.status_code == 409, retry.text
    assert retry.json()['detail']['code'] == 'INVALID_CONTROL'
    assert detail['allowedActions'] == ['resume'], retry.text
