"""Production admission, durable monitoring and real-route load regressions."""

import argparse
import json
from io import BytesIO
from unittest.mock import AsyncMock
from uuid import uuid4
from zipfile import ZipFile

import httpx
import pytest

from practiq_ai import execution, runtime, saas, storage, task_api, webapp
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
    DocumentTaskReparse,
)
from practiq_ai.database import Database
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from practiq_ai.storage import StorageHealth
from scripts import load_test
from tests.db_support import SERVICES, new_database, seed_account, setup_api
from tests.support import object_store, parsed, upload

pytestmark = pytest.mark.usefixtures('disposable_databases')


async def test_storage_failure_blocks_admission_but_preserves_reads_and_receipt_replay(monkeypatch):
    service, reference, model = await setup_api(monkeypatch)
    request = DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference))
    receipt = await task_api.create_task(request)
    await service.wait_idle()
    files = runtime.get_object_store()
    monkeypatch.setattr(files, 'health', AsyncMock(return_value=StorageHealth(False)))
    monkeypatch.setattr(webapp, 'get_object_store', lambda: files)
    assert not await service.ready()
    for operation in (
        task_api.create_task(request.model_copy(update={'requestId': uuid4()})),
        task_api.reparse_task(receipt['threadId'], DocumentTaskReparse(requestId=uuid4())),
    ):
        with pytest.raises(DocumentProcessingError) as error:
            await operation
        assert error.value.code == 'OBJECT_STORE_UNAVAILABLE' and error.value.status_code == 503
    assert await task_api.create_task(request) == receipt
    assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
    assert len(await service.db.rows('SELECT * FROM document_tasks')) == 1
    assert len(model.calls) == 1
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test', headers={'Authorization': 'Bearer test-token'}) as client:
        assert (await client.get('/ready')).status_code == 503
        response = await client.post('/api/uploads', json=upload().model_dump())
        assert response.status_code == 503
        assert response.json()['detail']['code'] == 'OBJECT_STORE_UNAVAILABLE'
        assert (await client.get('/api/document-tasks')).status_code == 200
        metrics = await client.get('/api/metrics')
        assert 'practiq_storage_healthy 0\n' in metrics.text
    monkeypatch.setattr(files, 'health', AsyncMock(return_value=StorageHealth(True)))
    assert await service.ready()


async def test_storage_outage_preserves_pause_and_blocks_resume_until_explicit_recovery(monkeypatch):
    service, reference, model = await setup_api(monkeypatch)
    files = runtime.get_object_store()
    async with service.delivery_lock:
        receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        monkeypatch.setattr(files, 'health', AsyncMock(return_value=StorageHealth(False)))
        await task_api.control_task(receipt['threadId'], DocumentTaskControl(requestId=uuid4(), action='pause', runId=receipt['runId']))
    await service.wait_idle()
    paused = await task_api.get_task(receipt['threadId'])
    assert paused['state'] == 'PAUSED' and not model.calls
    resume = DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=paused['checkpointId'])
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.control_task(receipt['threadId'], resume)
    assert error.value.code == 'OBJECT_STORE_UNAVAILABLE'
    assert len(await service.db.rows('SELECT * FROM document_runs')) == 1
    monkeypatch.setattr(files, 'health', AsyncMock(return_value=StorageHealth(True)))
    assert not model.calls
    await task_api.control_task(receipt['threadId'], resume)
    await service.wait_idle()
    assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
    assert len(model.calls) == 1


async def test_failed_storage_start_releases_database_ownership(tmp_path, monkeypatch):
    db = await new_database()
    root = tmp_path / 'not-a-directory'
    root.write_text('preserve')
    files = object_store(root)
    monkeypatch.setattr(runtime, 'get_object_store', lambda: files)
    with pytest.raises(DocumentProcessingError, match='File storage'):
        await runtime.Service(db).start()
    assert not db.connections
    contender = Database(db.uri)
    owner = await contender.acquire()
    await owner.close()
    assert root.read_text() == 'preserve'


async def test_queued_storage_failure_before_first_checkpoint_remains_explicitly_resumable(monkeypatch):
    service, reference, model = await setup_api(monkeypatch)
    files = runtime.get_object_store()
    async with service.delivery_lock:
        receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        monkeypatch.setattr(files, 'health', AsyncMock(return_value=StorageHealth(False)))
    await service.wait_idle()
    stopped = await task_api.get_task(receipt['threadId'])
    assert stopped['state'] == 'INTERRUPTED' and stopped['allowedActions'] == ['resume']
    assert stopped['runId'] == receipt['runId'] and not model.calls
    assert (await service.db.rows('SELECT error_code FROM document_runs'))[0]['error_code'] == 'OBJECT_STORE_UNAVAILABLE'
    monkeypatch.setattr(files, 'health', AsyncMock(return_value=StorageHealth(True)))
    assert await service.ready() and not model.calls
    await task_api.control_task(receipt['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=stopped['checkpointId']))
    await service.wait_idle()
    assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
    assert len(model.calls) == 1


async def test_temporary_budget_stop_requires_explicit_resume_without_model_replay(monkeypatch):
    service, reference, model = await setup_api(monkeypatch)
    extract = document.extract
    monkeypatch.setattr(document, 'extract', AsyncMock(side_effect=DocumentProcessingError(503, 'Temporary resources busy', 'TEMPORARY_BUSY')))
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    stopped = await task_api.get_task(receipt['threadId'])
    assert stopped['state'] == 'INTERRUPTED' and stopped['allowedActions'] == ['resume']
    assert not model.calls
    monkeypatch.setattr(document, 'extract', extract)
    assert not model.calls
    await task_api.control_task(receipt['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=stopped['checkpointId']))
    await service.wait_idle()
    assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
    assert len(model.calls) == 1


async def test_durable_unknown_usage_metrics_survive_restart_and_clear_after_settlement(monkeypatch):
    service, _, model = await setup_api(monkeypatch)
    keys = [str(uuid4()), str(uuid4())]
    credentials = []
    for index, status in enumerate(('pending', 'unknown')):
        token = await seed_account(service.db, str(13800138000 + index))
        credentials.append(token)
        account = await saas.identity(str(13800138000 + index), token)
        async with service.db.transaction() as conn:
            await conn.execute("INSERT INTO import_calls(call_key,account_id,thread_id,rates,status,dispatched,created_at) VALUES(%s,%s,'deleted-task',%s,%s,true,now()-interval '15 minutes')",
                               (keys[index], account, '{"inputMicropointsPer1k":1,"outputMicropointsPer1k":1}', status))
    uri = service.db.uri
    await service.stop(timeout=0)
    restarted = runtime.Service(Database(uri))
    await restarted.start()
    SERVICES.append(restarted)
    monkeypatch.setattr(runtime, 'current', restarted)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test', headers={'Authorization': 'Bearer test-token'}) as client:
        response = await client.get('/api/metrics')
        assert response.status_code == 200
        assert 'practiq_import_calls{status="unknown"} 2\n' in response.text
        assert 'practiq_import_calls{status="pending"} 0\n' in response.text
        assert all(key not in response.text for key in keys)
        assert 'deleted-task' not in response.text and all(token not in response.text for token in credentials)
        for key in keys:
            await saas.settle(key, {'inputTokens': 1, 'outputTokens': 1}, database=restarted.db)
        assert 'practiq_import_calls{status="unknown"} 0\n' in (await client.get('/api/metrics')).text
    assert model.calls == []


async def test_account_load_driver_uses_real_auth_upload_queue_and_export(monkeypatch, tmp_path):
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '1')
    service, _, model = await setup_api(monkeypatch, [parsed('First')])
    credential = await seed_account(service.db)
    files = object_store(tmp_path / 'uploaded-files')
    for module in (runtime, task_api, execution, webapp, storage, document):
        monkeypatch.setattr(module, 'get_object_store', lambda: files)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(load_test.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.ASGITransport(app=webapp.app), **kwargs))
    args = argparse.Namespace(token='test-token', phone='13800138000', account_token=credential,
                              base_url='http://test', input=None, text='1. First', total=1,
                              submit_concurrency=1, request_timeout=5, completion_timeout=10,
                              pid=None, api='document-tasks', max_running=8, graph_concurrency=2,
                              allow_rejections=False, environment='local', image_digest=None)
    report = await load_test.run(args)
    assert report['status'] == 'PASSED', report['failures']
    assert report['results']['runs'] == {'success': 1}
    assert credential not in json.dumps(report) and 'test-token' not in json.dumps(report)
    async with real_client(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test', headers={'Authorization': 'Account ' + credential, 'X-Practiq-Phone': args.phone}) as client:
        thread = report['runs'][0]['threadId']
        detail = (await client.get(f'/api/document-tasks/{thread}')).json()
        exported = await client.get(f'/api/document-tasks/{thread}/export', params={'checkpoint_id': detail['checkpointId']})
        assert exported.status_code == 200
        with ZipFile(BytesIO(exported.content)) as archive:
            assert archive.testzip() is None
            assert json.loads(archive.read('questions.json'))['result']['questions'][0]['stem'] == 'First'
    assert len(model.calls) == 1
