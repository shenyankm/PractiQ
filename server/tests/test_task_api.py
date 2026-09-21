import asyncio
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
    FailedUnit,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.webapp import app
from tests.db_support import setup_api
from tests.support import parsed

pytestmark = pytest.mark.usefixtures("disposable_databases")


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
    assert state['state'] == 'FAILED' and state['allowedActions'] == []
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
    assert state["state"] == "INTERRUPTED"
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
    runs_before = len(await api.db.rows("SELECT run_id FROM document_runs WHERE thread_id=?", (thread_id,)))
    request = DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=state['checkpointId'], units=[FailedUnit(stage='document_parse', index=state['failures'][0]['index'])])
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.control_task(thread_id, request)
    assert error.value.status_code == 409 and error.value.code == 'RETRY_LIMIT_EXCEEDED'
    assert len(await api.db.rows("SELECT run_id FROM document_runs WHERE thread_id=?", (thread_id,))) == runs_before
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
    runs = await api.db.rows('SELECT run_id FROM document_runs WHERE thread_id=? AND request_id=?',
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
    assert state['state'] == 'FAILED'
    assert state['failures'] == [{'stage': 'vision_parse' if pages else 'document_parse', 'index': 0,
                                  'code': 'OUTPUT_TRUNCATED', 'retryable': False, 'retriesRemaining': 0}]
    assert len(state['usage']) == 2 and state['unknownUsageCalls'] == []
    assert 'retry_failed' not in state['allowedActions']
    with pytest.raises(DocumentProcessingError, match='retryable'):
        await task_api.control_task(created['threadId'], DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=state['checkpointId']))
