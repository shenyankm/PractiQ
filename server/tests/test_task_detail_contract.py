import json
import runpy
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError

from practiq_ai import task_api
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskCreate,
    DocumentTaskDetail,
)
from practiq_ai.database import utcnow
from practiq_ai.webapp import app
from tests.db_support import new_database, setup_api

APP_ROOT = Path(__file__).resolve().parents[2] / 'app'


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize(('state', 'run_status', 'pause', 'cancel', 'phase', 'blocking', 'actions'), [
    ('PENDING', 'pending', False, False, 'pending', [], ['pause', 'interrupt']),
    ('RUNNING', 'running', False, False, 'vision', [], ['pause', 'interrupt']),
    ('PAUSING', 'running', True, False, 'chunk', [], ['interrupt']),
    ('PAUSED', 'interrupted', False, False, 'chunk', [{'kind': 'pause'}], ['resume']),
    ('INTERRUPTED', 'interrupted', False, False, 'prepare', [], ['resume']),
    ('CANCELLED', 'interrupted', False, True, 'chunk', [], ['resume']),
    ('WAITING_REVIEW', 'interrupted', False, False, 'result_review', [{'kind': 'review', 'stage': 'result', 'canAccept': True}], ['accept_partial']),
    ('COMPLETED', 'success', False, False, 'completed', [], []),
    ('FAILED', 'error', False, False, 'prepare', [], ['resume']),
])
async def test_task_detail_http_contract_for_saved_states(monkeypatch, state, run_status, pause, cancel, phase, blocking, actions):
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'test-token')
    monkeypatch.setenv('LLM_API_KEY', 'fake-key')
    monkeypatch.setenv('LLM_MODEL', 'fake-model')
    monkeypatch.setenv('LLM_BASE_URL', 'https://example.invalid/v1')
    db = await new_database()
    thread_id, run_id = str(uuid4()), str(uuid4())
    expires = utcnow() + timedelta(days=1)
    document = {'sourceType': 'text', 'fileName': 'fixture.txt'}
    async with db.connection() as conn:
        await conn.execute('INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) VALUES (?,?,?,?,?,?)',
                           (thread_id, thread_id, 'document_parser', json.dumps(document), 'review', expires))
        await conn.execute('INSERT INTO document_runs(run_id,thread_id,request_id,context,status,pause_requested,cancel_requested,error_code) VALUES (?,?,?,\'{}\',?,?,?,?)',
                           (run_id, thread_id, run_id, run_status, pause, cancel, 'STAGE_ERROR' if state == 'FAILED' else None))
    values = {'phase': phase, 'status': 'SUCCEEDED' if state == 'COMPLETED' else '', 'result': {}, 'processing': {}}
    snapshot = SimpleNamespace(values=values, interrupts=[SimpleNamespace(id=str(i), value=value) for i, value in enumerate(blocking)],
                               next=('chunk_gate',) if state != 'COMPLETED' else (), created_at=None)
    service = SimpleNamespace(db=db, snapshot=AsyncMock(return_value=snapshot), checkpoint_id=lambda *_: None)
    monkeypatch.setattr(task_api, 'client', lambda: service)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
        path = f'/api/document-tasks/{thread_id}'
        assert (await http.get(path)).status_code == 401
        response = await http.get(path, headers={'Authorization': 'Bearer test-token'})
    assert response.status_code == 200, response.text
    wire = response.json()
    assert DocumentTaskDetail.model_validate(wire).model_dump(mode='json') == wire
    assert set(wire) == set(DocumentTaskDetail.model_fields)
    assert wire['state'] == state and wire['phase'] == phase and wire['allowedActions'] == actions
    assert wire['runId'] == run_id and wire['fileName'] == 'fixture.txt'
    assert wire['modelConfigured'] and wire['resumeCompatible']
    assert wire['status'] == ('SUCCEEDED' if state == 'COMPLETED' else None)
    assert all(wire[field] is None for field in ('parentThreadId', 'checkpointId', 'result', 'processing'))
    assert wire['blocking'] == (['STAGE_ERROR'] if state == 'FAILED' else blocking)
    assert wire['progress'] == {kind: {'total': 0, 'succeeded': 0, 'failed': 0, 'remaining': 0} for kind in ('visuals', 'chunks')}
    assert wire['usage'] == wire['unknownUsageCalls'] == wire['failures'] == []


@pytest.mark.usefixtures('disposable_databases')
async def test_completed_task_http_preserves_result_processing_usage_and_expiry(monkeypatch):
    service, reference, model = await setup_api(monkeypatch)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'test-token')
    path = f'/api/document-tasks/{created["threadId"]}'
    headers = {'Authorization': 'Bearer test-token'}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
        response = await http.get(path, headers=headers)
        assert response.status_code == 200, response.text
        wire = response.json()
        detail = DocumentTaskDetail.model_validate(wire)
        assert detail.model_dump(mode='json') == wire
        assert detail.state == 'COMPLETED' and detail.phase == 'completed'
        assert detail.result is not None and detail.processing is not None
        assert detail.result.questions[0].stem == 'First'
        assert detail.progress.chunks.succeeded == detail.progress.chunks.total == 1
        assert detail.progress.chunks.remaining == detail.progress.chunks.failed == 0
        assert len(detail.usage) == len(model.calls) == 1
        assert detail.modelBudget.reserved > 0
        for field, value in [('state', 'NEW_STATE'), ('phase', 'NEW_PHASE'), ('allowedActions', ['new_action']),
                             ('failures', [{'stage': 'NEW_STAGE', 'index': 0, 'code': 'ERROR', 'retryable': False}])]:
            with pytest.raises(ValidationError) as error:
                DocumentTaskDetail.model_validate({**wire, field: value})
            assert error.value.errors()[0]['loc'][0] == field
        monkeypatch.setenv('AI_DESKTOP_MODE', '1')
        monkeypatch.setenv('AI_READ_ONLY', '1')
        readonly = (await http.get(path, headers=headers)).json()
        assert not readonly['modelConfigured'] and not readonly['resumeCompatible']
        assert readonly['result'] == wire['result'] and readonly['usage'] == wire['usage']
        async with service.db.connection() as conn:
            await conn.execute('UPDATE document_tasks SET expires_at=? WHERE thread_id=?',
                               (utcnow() - timedelta(seconds=1), created['threadId']))
        expired = await http.get(path, headers=headers)
        assert expired.status_code == 410 and expired.json()['detail']['code'] == 'TASK_EXPIRED'
        listing = await http.get('/api/document-tasks?state_filter=expired', headers=headers)
        assert listing.status_code == 200 and listing.json()['items'][0]['state'] == 'EXPIRED'
    assert len(model.calls) == 1


@pytest.mark.parametrize('change', ['field', 'state'])
def test_task_detail_changes_invalidate_generated_contract_check(monkeypatch, change):
    schema = DocumentTaskDetail.model_json_schema()
    if change == 'field':
        schema['properties']['newDetailField'] = {'type': 'string'}
    else:
        schema['properties']['state']['enum'].append('NEW_STATE')
    monkeypatch.setattr(DocumentTaskDetail, 'model_json_schema', classmethod(lambda *_: schema))
    monkeypatch.setattr('sys.argv', ['export-contracts.py', '--check'])
    with pytest.raises(SystemExit, match='AI contract changed'):
        runpy.run_path(str(APP_ROOT / 'scripts/export-contracts.py'), run_name='__main__')
