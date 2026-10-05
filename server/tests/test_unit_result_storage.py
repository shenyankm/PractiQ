"""Durable unit references keep pause/restart/retry and integrity boundaries."""
import json
from uuid import uuid4

import pytest
from langgraph.types import interrupt

from practiq_ai import execution, runtime, task_api
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from tests.db_support import SERVICES, setup_api
from tests.support import object_store, parsed, upload

pytestmark = pytest.mark.usefixtures('disposable_databases')


@pytest.mark.parametrize('damage', [None, 'missing', 'checksum'])
async def test_paused_unit_references_survive_restart_without_replaying_successes(monkeypatch, tmp_path, damage):
    service, reference, model = await setup_api(monkeypatch, [parsed('First'), parsed('Second'), parsed('Third')], parts=['first', 'second', 'third'])
    files = object_store(tmp_path / 'objects')
    original_store = document.get_object_store()
    payload = await original_store.get_verified(DocumentReference.model_validate(reference))
    await files.put_document(payload, upload(payload))
    for module in (document, execution, task_api):
        monkeypatch.setattr(module, 'get_object_store', lambda: files)
    original = document._chunk
    async def pause_last(state, graph_runtime):
        if state['index'] == 2:
            interrupt({'kind': 'pause'})
        return await original(state, graph_runtime)
    monkeypatch.setattr(document, '_chunk', pause_last)
    service.graph = service.graphs['document_parser'] = document.build_document_graph(service.db.checkpointer, store=service.db.store)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    thread = created['threadId']
    before = await task_api.get_task(thread)
    assert before['state'] == 'PAUSED' and len(model.calls) == 2
    state = await service.graph.aget_state({'configurable': {'thread_id': thread}})
    units = state.values['chunkResults']
    assert len(units) == 2
    assert all(unit['parsed'] == {'questionCount': 1} for unit in units)
    review = await task_api.review_task(thread)
    assert len(review['units']) == 2 and len(model.calls) == 2
    assert all(unit['questions'] for unit in review['units'])
    artifact = tmp_path / 'objects' / units[0]['resultRef']['objectKey']
    stored = artifact.read_bytes()
    assert json.loads(stored)['parsed']['questions'][0]['stem'] in {'First', 'Second'}
    await service.stop(timeout=0)
    restarted = runtime.Service(service.db)
    await restarted.start()
    SERVICES.append(restarted)
    monkeypatch.setattr(runtime, 'current', restarted)
    if damage == 'missing':
        artifact.unlink()
    elif damage == 'checksum':
        artifact.write_bytes(bytes([stored[0] ^ 1]) + stored[1:])
    request = DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=before['checkpointId'])
    if damage:
        with pytest.raises(DocumentProcessingError) as failure:
            await task_api.control_task(thread, request)
        assert failure.value.code == ('OBJECT_NOT_FOUND' if damage == 'missing' else 'DOCUMENT_CHECKSUM_MISMATCH')
        assert len(model.calls) == 2
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_bytes(stored)
    await task_api.control_task(thread, request)
    await service.wait_idle()
    result = await task_api.get_task(thread)
    assert result['state'] == 'COMPLETED' and len(result['result']['questions']) == 3
    assert len(model.calls) == 3



async def test_unit_storage_failure_before_checkpoint_reuses_the_durable_model_receipt(monkeypatch,tmp_path):
    service, reference, model = await setup_api(monkeypatch,[parsed('Saved')])
    files = object_store(tmp_path/'objects')
    payload = await document.get_object_store().get_verified(DocumentReference.model_validate(reference))
    await files.put_document(payload,upload(payload))
    for module in (document,execution,task_api):
        monkeypatch.setattr(module,'get_object_store',lambda:files)
    original = files.put_artifact
    fail = True
    async def put(payload,**kwargs):
        if fail and kwargs['kind']=='unit-result':
            raise OSError('Synthetic unit result write failure')
        return await original(payload,**kwargs)
    monkeypatch.setattr(files,'put_artifact',put)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(),document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    before = await task_api.get_task(created['threadId'])
    assert before['state']=='FAILED' and len(model.calls)==1
    fail = False
    await task_api.control_task(created['threadId'],DocumentTaskControl(requestId=uuid4(),action='resume',checkpointId=before['checkpointId']))
    await service.wait_idle()
    completed = await task_api.get_task(created['threadId'])
    assert completed['state']=='COMPLETED' and len(model.calls)==1
    assert completed['result']['questions'][0]['stem']=='Saved'
    assert len(completed['usage'])==1 and completed['unknownUsageCalls']==[]
