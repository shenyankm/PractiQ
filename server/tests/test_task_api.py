import asyncio
from datetime import timedelta
from typing import Any, cast
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest

from practiq_ai import task_api
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
    DocumentTaskReparse,
    FailedUnit,
)
from practiq_ai.database import utcnow
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.webapp import app
from tests.db_support import setup_api
from tests.support import FakeObjectStore, parsed

pytestmark = pytest.mark.usefixtures("disposable_databases")


async def test_task_page_fetches_latest_runs_in_one_query(monkeypatch):
    api, reference, _model = await setup_api(monkeypatch, [parsed("First"), parsed("Second")])
    ids = []
    for _ in range(2):
        created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        ids.append(created['threadId'])
        await api.wait_idle()
    original = api.db.rows
    reads = []

    async def rows(sql, params=()):
        reads.append(sql)
        return await original(sql, params)

    monkeypatch.setattr(api.db, 'rows', rows)
    snapshots = AsyncMock(wraps=api.snapshot)
    monkeypatch.setattr(api, 'snapshot', snapshots)
    api.task_summaries.update((f'old-{i}', ((), {})) for i in range(256))
    page = await task_api.list_tasks(limit=2)
    assert {item['threadId'] for item in page['items']} == set(ids)
    assert all(item['state'] == 'COMPLETED' and item['questionCount'] == 1 for item in page['items'])
    assert sum('FROM document_runs' in sql for sql in reads) == 1
    assert not page['hasMore']
    assert len(api.task_summaries) == 256 and 'old-0' not in api.task_summaries
    assert await task_api.list_tasks(limit=2) == page
    assert snapshots.await_count == 2
    await api.graph.aupdate_state({'configurable': {'thread_id': ids[0]}}, {'result': parsed('Changed')}, as_node='finish')
    refreshed = await task_api.list_tasks(limit=2)
    assert snapshots.await_count == 3
    assert next(item for item in refreshed['items'] if item['threadId'] == ids[0])['checkpointId'] != next(item for item in page['items'] if item['threadId'] == ids[0])['checkpointId']
    async with api.db.connection() as conn:
        await conn.execute('UPDATE document_tasks SET expires_at=%s WHERE thread_id=%s', (utcnow() - timedelta(seconds=1), ids[0]))
        await conn.execute("UPDATE document_runs SET status='interrupted' WHERE thread_id=%s", (ids[1],))
    changed = {item['threadId']: item for item in (await task_api.list_tasks(limit=2))['items']}
    assert changed[ids[0]]['state'] == 'EXPIRED'
    assert changed[ids[1]]['state'] == 'INTERRUPTED'
    assert snapshots.await_count == 4


async def test_reparse_preserves_original_result_and_links_source_with_new_signature(monkeypatch):
    api, reference, model = await setup_api(monkeypatch, [parsed('First'), parsed('Second')])
    original = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await api.wait_idle()
    old = await task_api.get_task(original['threadId'])
    monkeypatch.setenv('LLM_MODEL', 'changed-model')
    assert not (await task_api.get_task(original['threadId']))['resumeCompatible']
    request = DocumentTaskReparse(requestId=uuid4())
    child = await task_api.reparse_task(original['threadId'], request)
    assert child == await task_api.reparse_task(original['threadId'], request)
    await api.wait_idle()
    new = await task_api.get_task(child['threadId'])
    assert new['parentThreadId'] == original['threadId'] and new['resumeCompatible']
    assert new['result']['questions'][0]['stem'] == 'Second'
    assert (await task_api.get_task(original['threadId']))['result'] == old['result']
    assert len(model.calls) == 2
    assert len((await task_api.list_tasks(sha256=reference['sha256']))['items']) == 2
    assert not (await task_api.list_tasks(sha256='0' * 64))['items']
    review = await task_api.review_task(child['threadId'])
    sources = [unit for unit in review['units'] if unit['sourceRef']]
    assert sources and all(not unit['questions'] and not unit['groups'] for unit in sources)


async def test_reparse_rejects_damaged_source_before_queueing(monkeypatch):
    api, reference, _ = await setup_api(monkeypatch)
    original = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await api.wait_idle()
    files = cast(FakeObjectStore, task_api.get_object_store())
    files.blobs[reference['objectKey']] = b'corrupt'
    with pytest.raises(DocumentProcessingError):
        await task_api.reparse_task(original['threadId'], DocumentTaskReparse(requestId=uuid4()))
    assert len((await task_api.list_tasks())['items']) == 1


async def test_reparse_receipt_replay_uses_child_expiry_not_expired_parent(monkeypatch):
    api, reference, model = await setup_api(monkeypatch, [parsed(), parsed()])
    original = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await api.wait_idle()
    request = DocumentTaskReparse(requestId=uuid4())
    child = await task_api.reparse_task(original['threadId'], request)
    await api.wait_idle()
    async with api.db.connection() as conn:
        await conn.execute('UPDATE document_tasks SET expires_at=%s WHERE thread_id=%s',
                           (utcnow() - timedelta(seconds=1), original['threadId']))
    # An accepted operation is still replayable without another source/model call.
    cast(FakeObjectStore, task_api.get_object_store()).blobs[reference['objectKey']] = b'corrupt'
    monkeypatch.setenv('AI_READ_ONLY', '1')
    assert await task_api.reparse_task(original['threadId'], request) == child
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.reparse_task(original['threadId'], DocumentTaskReparse(requestId=uuid4()))
    assert error.value.code == 'TASK_EXPIRED'
    async with api.db.connection() as conn:
        await conn.execute('UPDATE document_tasks SET expires_at=%s WHERE thread_id=%s',
                           (utcnow() - timedelta(seconds=1), child['threadId']))
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.reparse_task(original['threadId'], request)
    assert error.value.code == 'TASK_EXPIRED'
    assert len(model.calls) == 2
    assert len((await task_api.list_tasks())['items']) == 2


async def test_auth_failure_can_be_explicitly_retried_without_replaying_successes(monkeypatch):
    import httpx2
    from openai import AuthenticationError

    failure = AuthenticationError('bad fake key', response=httpx2.Response(401, request=httpx2.Request('POST', 'http://test')), body={})
    failed = False

    def respond(messages, _schema):
        nonlocal failed
        if messages[-1].content.endswith('First'):
            return parsed('First')
        if not failed:
            failed = True
            return failure
        return parsed('Second')

    api, reference, model = await setup_api(monkeypatch, [respond] * 3, parts=['First', 'Second'])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), failurePolicy='review'))
    await api.wait_idle()
    state = await task_api.get_task(created['threadId'])
    assert state['state'] == 'WAITING_REVIEW'
    assert state['failures'][0]['code'] == 'AI_PROVIDER_AUTH_ERROR'
    assert 'retry_failed' in state['allowedActions'] and len(model.calls) == 2
    before = await task_api.review_task(created['threadId'])
    assert before['units'][0]['questions'][0]['stem'] == 'First'
    assert before['failures'][0]['index'] == 1 and len(model.calls) == 2
    monkeypatch.setenv('LLM_API_KEY', 'repaired-fake-key')
    await task_api.control_task(created['threadId'], DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=state['checkpointId']))
    await api.wait_idle()
    state = await task_api.get_task(created['threadId'])
    assert state['state'] == 'COMPLETED' and len(model.calls) == 3
    assert [q['stem'] for q in state['result']['questions']] == ['First', 'Second']
    assert len(state['unknownUsageCalls']) == 1
    listing = await task_api.list_tasks()
    assert listing['items'][0]['questionCount'] == 2
    review = await task_api.review_task(created['threadId'])
    assert review['units'][0]['stage'] == 'result'
    assert len(review['units'][0]['questions']) == 2 and len(model.calls) == 3


async def test_permanent_provider_error_does_not_offer_useless_resume(monkeypatch):
    api, reference, model = await setup_api(monkeypatch, [ValueError('invalid provider configuration')])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await api.wait_idle()
    state = await task_api.get_task(created['threadId'])
    assert state['state'] == 'COMPLETED' and state['status'] == 'PARTIAL' and state['allowedActions'] == []
    assert state['result']['missingFields'] == ['questions']
    assert state['failures'][0]['code'] == 'AI_PROVIDER_ERROR'
    with pytest.raises(DocumentProcessingError, match='new document'):
        await task_api.control_task(created['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=state['checkpointId']))
    assert len(model.calls) == 1


async def test_create_idempotency_concurrent_reuse_and_progress(monkeypatch):
    api, reference, model = await setup_api(monkeypatch)
    request = DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference))
    first, second = await asyncio.gather(task_api.create_task(request), task_api.create_task(request))
    assert first == second
    await api.wait_idle()
    assert await task_api.create_task(request) == first
    output = await task_api.get_task(first["threadId"])
    assert output["state"] == "COMPLETED", api.jobs
    assert output["status"] == "SUCCEEDED"
    assert not output["allowedActions"]
    assert len(model.calls) == len(output["usage"]) == 1
    assert output["unknownUsageCalls"] == []
    assert output["progress"]["chunks"]["succeeded"] == 1
    with pytest.raises(DocumentProcessingError, match="different input"):
        await task_api.create_task(request.model_copy(update={"failurePolicy": "review"}))


async def test_pause_resume_receipts_and_stale_controls(monkeypatch):
    api, reference, model = await setup_api(monkeypatch, [(0.05, parsed()), parsed("second")], parts=["a", "b"])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    thread_id = created["threadId"]
    pause = DocumentTaskControl(requestId=uuid4(), action="pause", runId=created["runId"])
    await task_api.control_task(thread_id, pause)
    await api.wait_idle()
    state = await task_api.get_task(thread_id)
    assert state["state"] == "PAUSED", api.jobs
    assert state["allowedActions"] == ["resume"]
    resume = DocumentTaskControl(requestId=uuid4(), action="resume", checkpointId=state["checkpointId"])
    first = await task_api.control_task(thread_id, resume)
    assert await task_api.control_task(thread_id, resume) == first
    await api.wait_idle()
    assert (await task_api.get_task(thread_id))["state"] == "COMPLETED", api.jobs
    assert len(model.calls) == 2
    with pytest.raises(DocumentProcessingError, match="different input"):
        await task_api.control_task(thread_id, resume.model_copy(update={"action": "accept_partial"}))
    with pytest.raises(DocumentProcessingError, match="no longer current"):
        await task_api.control_task(thread_id, pause.model_copy(update={"requestId": uuid4()}))
    with pytest.raises(DocumentProcessingError, match="checkpoint"):
        await task_api.control_task(thread_id, resume.model_copy(update={"requestId": uuid4()}))


async def test_retry_through_api_and_review_accept(monkeypatch):
    api, reference, model = await setup_api(monkeypatch, [parsed(), *([{"questions": [{"stem": ""}]}] * 2), parsed("fixed")], parts=["a", "b"])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), failurePolicy="review"))
    await api.wait_idle()
    thread_id = created["threadId"]
    state = await task_api.get_task(thread_id)
    assert state["state"] == "WAITING_REVIEW", api.jobs
    assert set(state["allowedActions"]) == {"retry_failed", "accept_partial"}
    with pytest.raises(DocumentProcessingError, match="review"):
        await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action="resume", checkpointId=state["checkpointId"]))
    await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action="accept_partial", checkpointId=state["checkpointId"]))
    await api.wait_idle()
    state = await task_api.get_task(thread_id)
    assert state["status"] == "PARTIAL", api.jobs
    retry = DocumentTaskControl(requestId=uuid4(), action="retry_failed", checkpointId=state["checkpointId"])
    await task_api.control_task(thread_id, retry)
    await api.wait_idle()
    state = await task_api.get_task(thread_id)
    assert state["status"] == "SUCCEEDED", api.jobs
    assert state["failures"] == []
    assert state["state"] == "WAITING_REVIEW" and state["allowedActions"] == ["accept_partial"]
    await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action="accept_partial", checkpointId=state["checkpointId"]))
    await api.wait_idle()
    assert (await task_api.get_task(thread_id))["state"] == "COMPLETED"
    assert len(model.calls) == len(state["usage"]) == 4


async def test_control_input_auth_and_http_errors(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_TOKEN", "test-token")
    headers = {"Authorization": "Bearer test-token"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
        assert (await http.post("/api/document-tasks", json={})).status_code == 401
        assert (await http.post("/api/document-tasks", json={}, headers=headers)).status_code == 422
        assert (await http.get("/api/document-tasks/not-a-uuid", headers=headers)).status_code == 422
        path = f"/api/document-tasks/{uuid4()}"
        assert (await http.post(path + "/control", json={"requestId": str(uuid4()), "action": "resume", "runId": str(uuid4())}, headers=headers)).status_code == 422
        async def failure(*args):
            raise DocumentProcessingError(404, 'missing task', 'TASK_NOT_FOUND')
        monkeypatch.setattr(task_api, "get_task", failure)
        assert (await http.get(path, headers=headers)).status_code == 404


async def test_missing_artifact_prevents_resume(monkeypatch):
    api, reference, model = await setup_api(monkeypatch)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await task_api.control_task(created["threadId"], DocumentTaskControl(requestId=uuid4(), action="pause", runId=created["runId"]))
    await api.wait_idle()
    state = await task_api.get_task(created["threadId"])
    async def missing(_reference):
        raise DocumentProcessingError(404, "missing", "OBJECT_NOT_FOUND")
    monkeypatch.setattr(task_api.get_object_store(), "get_verified", missing)
    with pytest.raises(DocumentProcessingError, match="missing"):
        await task_api.control_task(created["threadId"], DocumentTaskControl(requestId=uuid4(), action="resume", checkpointId=state["checkpointId"]))
    assert not model.calls


async def test_execution_rejects_stale_admission_before_any_model_work(monkeypatch):
    from practiq_ai.execution import namespace

    api, reference, model = await setup_api(monkeypatch)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await api.wait_idle()
    thread_id = created["threadId"]
    admission = await api.data.aget(namespace(thread_id, "control"), "admission")
    assert admission is not None
    # Model a control that passed HTTP preflight before another operation ran.
    operation = {"requestId": str(uuid4()), "fingerprint": "stale", "generation": admission.value["generation"] - 1}
    with pytest.raises(DocumentProcessingError) as error:
        await cast(Any, api.graph).ainvoke({"document": reference, "retry": {"requestId": str(uuid4())}},
            {"configurable": {"thread_id": thread_id}, "run_id": str(uuid4())}, context={"documentControl": operation})
    assert error.value.code == "STALE_CHECKPOINT"
    assert len(model.calls) == 1


async def test_immediate_interrupt_reports_unknown_and_resumes_saved_work(monkeypatch):
    api, reference, model = await setup_api(monkeypatch, [(60, parsed()), parsed()])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    thread_id = created["threadId"]
    async with asyncio.timeout(5):
        while not model.calls:
            await asyncio.sleep(0.01)
    await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action="interrupt", runId=created["runId"]))
    await api.wait_idle()
    state = await task_api.get_task(thread_id)
    assert state["state"] == "CANCELLED"
    assert (await task_api.list_tasks(state_filter="cancelled"))["items"][0]["threadId"] == thread_id
    assert not (await task_api.list_tasks(state_filter="interrupted"))["items"]
    assert len(state["unknownUsageCalls"]) == 1
    await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action="resume", checkpointId=state["checkpointId"]))
    await api.wait_idle()
    state = await task_api.get_task(thread_id)
    assert state["status"] == "SUCCEEDED"
    assert len(model.calls) == 2
    assert len(state["unknownUsageCalls"]) == len(state["usage"]) == 1


@pytest.mark.parametrize('review', [False, True])
async def test_api_retry_limits_concurrency_and_exhaustion(monkeypatch, review):
    api, reference, model = await setup_api(monkeypatch, [parsed(), *([{'questions': [{'stem': ''}]}] * 6)], parts=['First', 'Second'])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), failurePolicy='review' if review else 'return_partial'))
    await api.wait_idle()
    thread_id = created['threadId']
    for remaining in (1, 0):
        state = await task_api.get_task(thread_id)
        request = DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=state['checkpointId'])
        receipts = await asyncio.gather(task_api.control_task(thread_id, request), task_api.control_task(thread_id, request))
        assert receipts[0] == receipts[1]
        await api.wait_idle()
        assert await task_api.control_task(thread_id, request) == receipts[0]
        state = await task_api.get_task(thread_id)
        assert state['failures'][0]['retriesRemaining'] == remaining
    assert len(model.calls) == len(state['usage']) == 7
    assert state['failures'][0]['code'] == 'OUTPUT_STALLED'
    assert not state['failures'][0]['retryable']
    assert 'retry_failed' not in state['allowedActions']
    runs_before = len(await api.db.rows("SELECT run_id FROM document_runs WHERE thread_id=%s", (thread_id,)))
    request = DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=state['checkpointId'], units=[FailedUnit(stage='document_parse', index=state['failures'][0]['index'])])
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.control_task(thread_id, request)
    assert error.value.status_code == 409 and error.value.code == 'RETRY_LIMIT_EXCEEDED'
    assert len(await api.db.rows("SELECT run_id FROM document_runs WHERE thread_id=%s", (thread_id,))) == runs_before
    if review:
        assert state['allowedActions'] == ['accept_partial']
        await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action='accept_partial', checkpointId=state['checkpointId']))
        await api.wait_idle()
        state = await task_api.get_task(thread_id)
    assert state['status'] == 'PARTIAL'


@pytest.mark.parametrize('completed', [False, True])
async def test_control_replays_request_admitted_during_preflight_read(monkeypatch, completed):
    api, reference, _ = await setup_api(monkeypatch, [parsed(), {'bad': 1}, {'bad': 1},
                                                     parsed('Second') if completed else (60, parsed('Second'))],
                                         parts=['First', 'Second'])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await api.wait_idle()
    thread_id = created['threadId']
    state = await task_api.get_task(thread_id)
    request = DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=state['checkpointId'])
    original = task_api._read_task
    receipts = []
    first = True

    async def admit_before_read(*args):
        nonlocal first
        if first:
            first = False
            receipts.append(await task_api.control_task(thread_id, request))
            if completed:
                await api.wait_idle()
        return await original(*args)

    monkeypatch.setattr(task_api, '_read_task', admit_before_read)
    assert await task_api.control_task(thread_id, request) == receipts[0]
    runs = await api.db.rows('SELECT run_id FROM document_runs WHERE thread_id=%s AND request_id=%s',
                             (thread_id, str(request.requestId)))
    assert len(runs) == 1


async def test_quality_only_review_acceptance_is_idempotent_and_not_retryable(monkeypatch):
    api, reference, model = await setup_api(monkeypatch, [parsed('Absent from source')])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), failurePolicy='review'))
    await api.wait_idle()
    thread_id = created['threadId']
    state = await task_api.get_task(thread_id)
    assert state['state'] == 'WAITING_REVIEW'
    assert state['allowedActions'] == ['accept_partial'] and state['failures'] == []
    assert state['blocking'][0]['qualityIssues'][0]['code'] == 'SOURCE_TEXT_NOT_FOUND'
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'test-token')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
        assert (await http.get(f'/api/document-tasks/{thread_id}/preview')).status_code == 401
        response = await http.get(f'/api/document-tasks/{thread_id}/preview', headers={'Authorization': 'Bearer test-token'})
        assert response.status_code == 200
        preview = response.json()
        assert preview['units'][0]['questions'] == state['result']['questions']
        assert preview['quality'] == state['processing']['quality']
        assert preview['checkpointId'] == state['checkpointId']
        assert len(model.calls) == 1
    with pytest.raises(DocumentProcessingError, match='retryable'):
        await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=state['checkpointId']))
    with pytest.raises(DocumentProcessingError, match='checkpoint'):
        await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action='accept_partial', checkpointId='stale'))
    control = DocumentTaskControl(requestId=uuid4(), action='accept_partial', checkpointId=state['checkpointId'])
    receipt = await task_api.control_task(thread_id, control)
    await api.wait_idle()
    assert await task_api.control_task(thread_id, control) == receipt
    output = await task_api.get_task(thread_id)
    assert output['state'] == 'COMPLETED' and output['status'] == state['status'] == 'SUCCEEDED'
    assert output['result'] == state['result'] and output['processing'] == state['processing']
    assert output['processing']['quality']['reviewRequired']
    assert len(model.calls) == 1


@pytest.mark.parametrize('pages', [False, True])
async def test_truncation_is_visible_and_not_manually_retryable(monkeypatch, pages):
    from langchain_core.messages import AIMessage

    from practiq_ai import llm
    from practiq_ai.extractors import ExtractedDocument
    from practiq_ai.graphs import document
    from tests.support import make_image

    api, reference, _ = await setup_api(monkeypatch)
    if pages:
        monkeypatch.setattr(document, 'extract', AsyncMock(side_effect=lambda *_: ExtractedDocument(text='', page_images=[make_image()])))
    class Runner:
        async def ainvoke(self, messages, config=None):
            return {'raw': AIMessage(content='{"questions":', response_metadata={'finish_reason': 'length'},
                                    usage_metadata={'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15}),
                    'parsed': None, 'parsing_error': ValueError('truncated')}
    monkeypatch.setattr(llm, 'structured_output', lambda *_: Runner())
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await api.wait_idle()
    state = await task_api.get_task(created['threadId'])
    assert state['state'] == 'COMPLETED' and state['status'] == 'PARTIAL'
    assert state['result']['missingFields'] == ['questions']
    assert state['failures'] == [{'stage': 'vision_parse' if pages else 'document_parse', 'index': 0,
                                  'code': 'OUTPUT_TRUNCATED', 'retryable': False, 'retriesRemaining': 0}]
    assert len(state['usage']) == 2 and state['unknownUsageCalls'] == []
    assert 'retry_failed' not in state['allowedActions']
    with pytest.raises(DocumentProcessingError, match='retryable'):
        await task_api.control_task(created['threadId'], DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=state['checkpointId']))


async def test_delete_record_rejects_active_tasks_and_removes_stopped_history(monkeypatch):
    api, reference, model = await setup_api(monkeypatch, [(0.1, parsed())])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    thread_id = created['threadId']
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.delete_task(thread_id)
    assert error.value.code == 'TASK_BUSY'
    await api.wait_idle()
    calls = len(model.calls)
    assert (await task_api.list_tasks())['items']
    assert await task_api.delete_task(thread_id) == {'deleted': True}
    assert await task_api.delete_task(thread_id) == {'deleted': True}
    assert not (await task_api.list_tasks())['items']
    assert not await api.db.rows('SELECT * FROM document_runs WHERE thread_id=%s', (thread_id,))
    assert not await api.db.rows('SELECT * FROM document_receipts WHERE thread_id=%s', (thread_id,))
    assert await api.db.checkpointer.aget_tuple({'configurable': {'thread_id': thread_id}}) is None
    assert len(model.calls) == calls


async def test_status_filter_paginates_after_scanning_all_records(monkeypatch):
    api, reference, _model = await setup_api(monkeypatch, [parsed("First"), parsed("Second")])
    ids = []
    for _ in range(2):
        created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        ids.append(created['threadId'])
        await api.wait_idle()
    async with api.db.transaction() as conn:
        for _ in range(101):
            await conn.execute('INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) SELECT %s,request_hash,graph_id,document,failure_policy,%s FROM document_tasks WHERE thread_id=%s',
                               (str(uuid4()), utcnow() - timedelta(days=1), ids[0]))
    first = await task_api.list_tasks(1, state_filter='completed')
    second = await task_api.list_tasks(1, 1, state_filter='completed')
    assert first['hasMore'] and not second['hasMore']
    assert {first['items'][0]['threadId'], second['items'][0]['threadId']} == set(ids)
    assert not (await task_api.list_tasks(1, 2, state_filter='completed'))['items']
    assert len((await task_api.list_tasks(100, state_filter='expired'))['items']) == 100
    assert not (await task_api.list_tasks(state_filter='active'))['items']


async def test_head_returns_only_current_read_state_without_building_usage_or_results(monkeypatch):
    service, reference, model = await setup_api(monkeypatch, [parsed()])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(),document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    detail = await task_api.get_task(created['threadId'])
    async def forbidden(*_args):
        raise AssertionError('Head must not read all usage calls')
    monkeypatch.setattr(task_api,'_calls',forbidden)
    head = await task_api.get_task_head(created['threadId'])
    assert head == {key:detail[key] for key in ('threadId','runId','state','checkpointId','updatedAt','modelConfigured','resumeCompatible')}
    assert len(model.calls) == 1
    monkeypatch.setenv('AI_SERVICE_TOKEN','head-test-token')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as http:
        endpoint = f"/api/document-tasks/{created['threadId']}/head"
        assert (await http.get(endpoint)).status_code == 401
        response = await http.get(endpoint,headers={'Authorization':'Bearer head-test-token'})
        assert response.status_code == 200 and response.json() == head
