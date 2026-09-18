import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, cast
from uuid import uuid4

import httpx
import pytest
from langgraph.types import Command

from practiq_ai import task_api
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
    FailedUnit,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.webapp import app
from tests.test_task_execution import parsed, setup_graph


def http_error(code):
    return httpx.HTTPStatusError("fake server error", request=httpx.Request("GET", "http://test"), response=httpx.Response(code))


class NativeAPI:
    """Public SDK-shaped test adapter; actual parsing runs on the real graph."""

    def __init__(self, graph, store):
        self.graph, self.data = graph, store
        self.records, self.jobs = {}, {}
        self.threads = SimpleNamespace(count=self.count_threads, create=self.create_thread, get=self.get_thread, get_state=self.get_state, update=self.update_thread)
        self.runs = SimpleNamespace(create=self.create_run, list=self.list_runs, cancel=self.cancel)
        self.store = SimpleNamespace(get_item=self.get_item, put_item=self.put_item, search_items=self.search_items)
        self.pending = []

    async def count_threads(self, *, status):
        assert status == "busy"
        return sum(any(run["status"] == "running" for run in jobs) for jobs in self.jobs.values())

    async def create_thread(self, *, thread_id, metadata, **kwargs):
        # No await before setdefault: model atomic native insert-if-absent.
        return self.records.setdefault(thread_id, {"thread_id": thread_id, "metadata": metadata, "created_at": datetime.now(UTC).isoformat()})

    async def get_thread(self, thread_id):
        if thread_id not in self.records:
            raise http_error(404)
        return self.records[thread_id]

    async def update_thread(self, thread_id, *, metadata):
        self.records[thread_id]["metadata"].update(metadata)

    async def get_state(self, thread_id, **kwargs):
        state = await self.graph.aget_state({"configurable": {"thread_id": thread_id}})
        return {"values": state.values, "next": state.next, "checkpoint": state.config.get("configurable", {}),
                "created_at": state.created_at, "tasks": [{"error": item.error, "interrupts": [{"id": i.id, "value": i.value} for i in item.interrupts]} for item in state.tasks]}

    async def list_runs(self, thread_id, limit=10, offset=0):
        return list(reversed(self.jobs.get(thread_id, [])))[offset:offset + limit]

    async def create_run(self, thread_id, graph_id, *, input, command, context, metadata, **kwargs):
        if any(item["status"] == "running" for item in self.jobs.get(thread_id, [])):
            raise http_error(409)
        assert kwargs["durability"] == "sync"
        assert kwargs["multitask_strategy"] == "reject"
        run = {"run_id": str(uuid4()), "status": "running", "metadata": metadata}
        self.jobs.setdefault(thread_id, []).append(run)

        async def execute():
            try:
                result = await self.graph.ainvoke(Command(**command) if command else input,
                    {"configurable": {"thread_id": thread_id}, "run_id": run["run_id"]}, context=context, durability="sync")
                run["status"] = "interrupted" if result.get("__interrupt__") else "success"
            except asyncio.CancelledError:
                run["status"] = "interrupted"
            except (DocumentProcessingError, ValueError, RuntimeError) as exc:
                run["status"] = "error"
                run["error"] = str(exc)

        run["task"] = asyncio.create_task(execute())
        self.pending.append(run["task"])
        return run

    async def cancel(self, thread_id, run_id, **kwargs):
        assert kwargs == {"action": "interrupt", "wait": True}
        run = next(item for item in self.jobs[thread_id] if item["run_id"] == run_id)
        run["task"].cancel()
        await asyncio.gather(run["task"], return_exceptions=True)
        run["status"] = "interrupted"

    async def get_item(self, namespace, key, **kwargs):
        item = await self.data.aget(tuple(namespace), key)
        return {"value": item.value} if item else None

    async def put_item(self, namespace, key, value, **kwargs):
        await self.data.aput(tuple(namespace), key, value)

    async def search_items(self, namespace, **kwargs):
        values = await self.data.asearch(tuple(namespace), limit=kwargs["limit"], offset=kwargs["offset"])
        return {"items": [{"value": value.value} for value in values]}

    async def finish(self):
        await asyncio.wait_for(asyncio.gather(*self.pending), timeout=10)


def setup_api(monkeypatch, responses=None, parts=None):
    graph, store, files, reference, model = setup_graph(monkeypatch, responses or [parsed()], parts=parts)
    api = NativeAPI(graph, store)
    monkeypatch.setattr(task_api, "client", lambda: api)
    monkeypatch.setattr(task_api, "get_object_store", lambda: files)
    return api, reference, model


async def test_create_idempotency_concurrent_reuse_and_progress(monkeypatch):
    api, reference, model = setup_api(monkeypatch)
    request = DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference))
    first, second = await asyncio.gather(task_api.create_task(request), task_api.create_task(request))
    assert first == second
    await api.finish()
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
    api, reference, model = setup_api(monkeypatch, [(0.05, parsed()), parsed("second")], parts=["a", "b"])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    thread_id = created["threadId"]
    pause = DocumentTaskControl(requestId=uuid4(), action="pause", runId=created["runId"])
    await task_api.control_task(thread_id, pause)
    await api.finish()
    state = await task_api.get_task(thread_id)
    assert state["state"] == "PAUSED", api.jobs
    assert state["allowedActions"] == ["resume"]
    resume = DocumentTaskControl(requestId=uuid4(), action="resume", checkpointId=state["checkpointId"])
    first = await task_api.control_task(thread_id, resume)
    assert await task_api.control_task(thread_id, resume) == first
    await api.finish()
    assert (await task_api.get_task(thread_id))["state"] == "COMPLETED", api.jobs
    assert len(model.calls) == 2
    with pytest.raises(DocumentProcessingError, match="different input"):
        await task_api.control_task(thread_id, resume.model_copy(update={"action": "accept_partial"}))
    with pytest.raises(DocumentProcessingError, match="no longer current"):
        await task_api.control_task(thread_id, pause.model_copy(update={"requestId": uuid4()}))
    with pytest.raises(DocumentProcessingError, match="checkpoint"):
        await task_api.control_task(thread_id, resume.model_copy(update={"requestId": uuid4()}))


async def test_retry_through_api_and_review_accept(monkeypatch):
    api, reference, model = setup_api(monkeypatch, [parsed(), *([{"questions": [{"stem": ""}]}] * 2), parsed("fixed")], parts=["a", "b"])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), failurePolicy="review"))
    await api.finish()
    thread_id = created["threadId"]
    state = await task_api.get_task(thread_id)
    assert state["state"] == "WAITING_REVIEW", api.jobs
    assert set(state["allowedActions"]) == {"retry_failed", "accept_partial"}
    with pytest.raises(DocumentProcessingError, match="review"):
        await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action="resume", checkpointId=state["checkpointId"]))
    await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action="accept_partial", checkpointId=state["checkpointId"]))
    await api.finish()
    state = await task_api.get_task(thread_id)
    assert state["status"] == "PARTIAL", api.jobs
    retry = DocumentTaskControl(requestId=uuid4(), action="retry_failed", checkpointId=state["checkpointId"])
    await task_api.control_task(thread_id, retry)
    await api.finish()
    state = await task_api.get_task(thread_id)
    assert state["status"] == "SUCCEEDED", api.jobs
    assert state["failures"] == []
    assert state["state"] == "WAITING_REVIEW" and state["allowedActions"] == ["accept_partial"]
    await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action="accept_partial", checkpointId=state["checkpointId"]))
    await api.finish()
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
            raise http_error(404)
        monkeypatch.setattr(task_api, "get_task", failure)
        assert (await http.get(path, headers=headers)).status_code == 404


async def test_missing_artifact_prevents_resume(monkeypatch):
    api, reference, model = setup_api(monkeypatch)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await task_api.control_task(created["threadId"], DocumentTaskControl(requestId=uuid4(), action="pause", runId=created["runId"]))
    await api.finish()
    state = await task_api.get_task(created["threadId"])
    async def missing(_reference):
        raise DocumentProcessingError(404, "missing", "OBJECT_NOT_FOUND")
    monkeypatch.setattr(task_api.get_object_store(), "get_verified", missing)
    with pytest.raises(DocumentProcessingError, match="missing"):
        await task_api.control_task(created["threadId"], DocumentTaskControl(requestId=uuid4(), action="resume", checkpointId=state["checkpointId"]))
    assert not model.calls


async def test_execution_rejects_stale_admission_before_any_model_work(monkeypatch):
    from practiq_ai.execution import namespace

    api, reference, model = setup_api(monkeypatch)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await api.finish()
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
    api, reference, model = setup_api(monkeypatch, [(60, parsed()), parsed()])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    thread_id = created["threadId"]
    async with asyncio.timeout(5):
        while not model.calls:
            await asyncio.sleep(0.01)
    await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action="interrupt", runId=created["runId"]))
    await api.finish()
    state = await task_api.get_task(thread_id)
    assert state["state"] == "INTERRUPTED"
    assert len(state["unknownUsageCalls"]) == 1
    await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action="resume", checkpointId=state["checkpointId"]))
    await api.finish()
    state = await task_api.get_task(thread_id)
    assert state["status"] == "SUCCEEDED"
    assert len(model.calls) == 2
    assert len(state["unknownUsageCalls"]) == len(state["usage"]) == 1


@pytest.mark.parametrize('review', [False, True])
async def test_api_retry_limits_concurrency_and_exhaustion(monkeypatch, review):
    api, reference, model = setup_api(monkeypatch, [parsed(), *([{'questions': [{'stem': ''}]}] * 6)], parts=['First', 'Second'])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), failurePolicy='review' if review else 'return_partial'))
    await api.finish()
    thread_id = created['threadId']
    for remaining in (1, 0):
        state = await task_api.get_task(thread_id)
        request = DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=state['checkpointId'])
        receipts = await asyncio.gather(task_api.control_task(thread_id, request), task_api.control_task(thread_id, request))
        assert receipts[0] == receipts[1]
        await api.finish()
        assert await task_api.control_task(thread_id, request) == receipts[0]
        state = await task_api.get_task(thread_id)
        assert state['failures'][0]['retriesRemaining'] == remaining
    assert len(model.calls) == len(state['usage']) == 7
    assert state['failures'][0]['code'] == 'OUTPUT_STALLED'
    assert not state['failures'][0]['retryable']
    assert 'retry_failed' not in state['allowedActions']
    runs_before = len(api.jobs[thread_id])
    request = DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=state['checkpointId'], units=[FailedUnit(stage='document_parse', index=state['failures'][0]['index'])])
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.control_task(thread_id, request)
    assert error.value.status_code == 409 and error.value.code == 'RETRY_LIMIT_EXCEEDED'
    assert len(api.jobs[thread_id]) == runs_before
    if review:
        assert state['allowedActions'] == ['accept_partial']
        await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action='accept_partial', checkpointId=state['checkpointId']))
        await api.finish()
        state = await task_api.get_task(thread_id)
    assert state['status'] == 'PARTIAL'


async def test_quality_only_review_acceptance_is_idempotent_and_not_retryable(monkeypatch):
    api, reference, model = setup_api(monkeypatch, [parsed('Absent from source')])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference), failurePolicy='review'))
    await api.finish()
    thread_id = created['threadId']
    state = await task_api.get_task(thread_id)
    assert state['state'] == 'WAITING_REVIEW'
    assert state['allowedActions'] == ['accept_partial'] and state['failures'] == []
    assert state['blocking'][0]['qualityIssues'][0]['code'] == 'SOURCE_TEXT_NOT_FOUND'
    with pytest.raises(DocumentProcessingError, match='retryable'):
        await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=state['checkpointId']))
    with pytest.raises(DocumentProcessingError, match='checkpoint'):
        await task_api.control_task(thread_id, DocumentTaskControl(requestId=uuid4(), action='accept_partial', checkpointId='stale'))
    control = DocumentTaskControl(requestId=uuid4(), action='accept_partial', checkpointId=state['checkpointId'])
    receipt = await task_api.control_task(thread_id, control)
    await api.finish()
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
    from tests.test_workflows import make_image

    api, reference, _ = setup_api(monkeypatch)
    if pages:
        monkeypatch.setattr(document, 'extract', lambda *_: ExtractedDocument(text='', page_images=[make_image()]))
    class Runner:
        async def ainvoke(self, messages, config=None):
            return {'raw': AIMessage(content='{"questions":', response_metadata={'finish_reason': 'length'},
                                    usage_metadata={'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15}),
                    'parsed': None, 'parsing_error': ValueError('truncated')}
    monkeypatch.setattr(llm, 'structured_output', lambda *_: Runner())
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await api.finish()
    state = await task_api.get_task(created['threadId'])
    assert state['state'] == 'FAILED'
    assert state['failures'] == [{'stage': 'vision_parse' if pages else 'document_parse', 'index': 0,
                                  'code': 'OUTPUT_TRUNCATED', 'retryable': False, 'retriesRemaining': 0}]
    assert len(state['usage']) == 2 and state['unknownUsageCalls'] == []
    assert 'retry_failed' not in state['allowedActions']
    with pytest.raises(DocumentProcessingError, match='retryable'):
        await task_api.control_task(created['threadId'], DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=state['checkpointId']))
