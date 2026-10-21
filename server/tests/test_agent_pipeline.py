"""Regression boundaries for dispatch, bounded storage and model admission."""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from langgraph.runtime import Runtime
from langgraph.types import Command

from practiq_ai import capacity, execution, llm, messaging, runtime
from practiq_ai.capacity import bounded_map
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from tests.support import parsed, run_config, setup_graph


async def test_delivery_wait_does_not_consume_control_notification():
    service = runtime.Service(cast(Any, None))
    service.wake.set()
    await service.delivery.wait(0)
    assert service.wake.is_set()


async def test_notification_reaches_both_loops_independently():
    service = runtime.Service(cast(Any, None))
    service.notify()
    assert service.wake.is_set() and service.delivery.wake.is_set()
    service.wake.clear()
    await asyncio.wait_for(service.delivery.wait(10), .5)
    assert service.delivery.wake.is_set()


async def test_full_outbox_batch_drains_before_idle_wait(monkeypatch):
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def connection():
        yield SimpleNamespace(execute=AsyncMock())

    batches = [[{"run_id": str(uuid4()), "created_at": "synthetic"} for _ in range(size)] for size in (100, 1)]
    db = SimpleNamespace(rows=AsyncMock(side_effect=batches), connection=connection)
    service = SimpleNamespace(stopping=False, db=db, active={})
    channel = SimpleNamespace(is_closed=False, get_underlay_channel=AsyncMock(
        return_value=SimpleNamespace(on_consumer_cancel_callbacks=set())))
    broker = SimpleNamespace(channel=AsyncMock(return_value=channel), is_closed=False, close=AsyncMock())
    queue = SimpleNamespace(consume=AsyncMock(), cancel=AsyncMock())
    published = AsyncMock()
    delivery = messaging.Delivery(service)

    async def idle(_seconds):
        service.stopping = True

    monkeypatch.setattr(messaging, "load", lambda: SimpleNamespace(read_only=False))
    monkeypatch.setattr(messaging, "rabbitmq_uri", lambda: "amqp://localhost/synthetic")
    monkeypatch.setattr(messaging.aio_pika, "connect", AsyncMock(return_value=broker))
    monkeypatch.setattr(messaging, "topology", AsyncMock(return_value=queue))
    monkeypatch.setattr(messaging, "publish", published)
    monkeypatch.setattr(delivery, "wait", idle)
    await asyncio.wait_for(delivery.run(), .5)
    assert published.await_count == 101 and db.rows.await_count == 2
    queue.cancel.assert_awaited_once()
    broker.close.assert_awaited_once()


@pytest.mark.parametrize("count", [0, 1, 10_000])
async def test_storage_map_bounds_tasks_and_preserves_order(monkeypatch, count):
    monkeypatch.setenv("AI_STORAGE_CONCURRENCY", "3")
    existing = asyncio.all_tasks()
    task_count = 0

    async def work(index):
        nonlocal task_count
        if index == 0:
            task_count = len(asyncio.all_tasks() - existing)
        await asyncio.sleep(0)
        return None if index % 2 else index

    result = await bounded_map(list(range(count)), work)
    assert result == [None if index % 2 else index for index in range(count)]
    assert task_count <= min(count, 3)


async def test_storage_map_cancellation_drains_workers_without_starting_queued_items(monkeypatch):
    monkeypatch.setenv("AI_STORAGE_CONCURRENCY", "2")
    entered = asyncio.Event()
    started, stopped = [], []

    async def work(index):
        started.append(index)
        if len(started) == 2:
            entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.append(index)

    pending = asyncio.create_task(bounded_map(list(range(100)), work))
    await asyncio.wait_for(entered.wait(), .5)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert started == [0, 1] and sorted(stopped) == [0, 1]


async def test_unit_result_persistence_obeys_stage_deadline(monkeypatch):
    entered = asyncio.Event()
    stopped = asyncio.Event()

    async def persist(*args, **kwargs):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setattr(document, "validate_execution", lambda *_: None)
    monkeypatch.setattr(document, "guard", AsyncMock())
    monkeypatch.setattr(document, "run_remaining", AsyncMock(return_value=.02))
    monkeypatch.setattr(document, "get_object_store", lambda: SimpleNamespace(put_artifact=persist))

    async def node(_state):
        return {"chunkResults": [{"index": 0, "parsed": parsed()}]}

    with pytest.raises(DocumentProcessingError) as error:
        await asyncio.wait_for(document._guarded(node)(
            {"execution": {}, "sourceSha256": "a" * 64}, Runtime(context=cast(Any, {})),
        ), timeout=.5)
    assert error.value.code == "RUN_DEADLINE_EXCEEDED"
    assert entered.is_set() and stopped.is_set()
    assert execution.CURRENT_EXECUTION.get() is None


async def test_pause_while_waiting_for_provider_prevents_dispatch_and_resumes(monkeypatch):
    graph, store, _, reference, model = setup_graph(monkeypatch, [parsed()])
    config = run_config()
    pause = True

    @asynccontextmanager
    async def slot(_record, *, check=None):
        nonlocal pause
        if pause:
            pause = False
            await store.aput(execution.namespace("thread-1", "pause"), str(config.get("run_id")), {"requested": True})
        yield

    monkeypatch.setattr(llm, "provider_slot", slot)
    result = await graph.ainvoke({"document": reference}, config)
    assert result.get("__interrupt__") and not model.calls
    assert not await store.asearch(execution.namespace("thread-1", "calls"))
    assert not await store.asearch(execution.namespace("thread-1", "budget"))
    resumed = await graph.ainvoke(Command(resume={item.id: {"action": "resume"} for item in result["__interrupt__"]}), {**config, "run_id": uuid4()})
    assert resumed["status"] == "SUCCEEDED" and len(model.calls) == 1
    assert len(resumed["usage"]) == 1


@pytest.mark.parametrize("phase", ["concurrency", "rate"])
async def test_paused_provider_wait_does_not_consume_rpm(monkeypatch, phase):
    graph, store, _, reference, model = setup_graph(monkeypatch, [parsed()])
    config = run_config()
    gate = capacity.ProviderGate(1, 1)
    capacity._providers[asyncio.get_running_loop()] = gate
    entered, release = asyncio.Event(), asyncio.Event()
    original = gate.semaphore.acquire if phase == "concurrency" else gate.wait_rate

    async def wait(*args, **kwargs):
        entered.set()
        await release.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(gate.semaphore if phase == "concurrency" else gate,
                        "acquire" if phase == "concurrency" else "wait_rate", wait)
    pending = asyncio.create_task(graph.ainvoke({"document": reference}, config))
    try:
        await asyncio.wait_for(entered.wait(), 3)
        await store.aput(execution.namespace("thread-1", "pause"), str(config.get("run_id")), {"requested": True})
        release.set()
        result = await asyncio.wait_for(pending, 3)
        assert result.get("__interrupt__") and not model.calls
        assert not gate.starts
        assert gate.semaphore._value == 1
        resumed = await asyncio.wait_for(graph.ainvoke(
            Command(resume={item.id: {"action": "resume"} for item in result["__interrupt__"]}),
            {**config, "run_id": uuid4()},
        ), 3)
        assert resumed["status"] == "SUCCEEDED" and len(model.calls) == len(gate.starts) == 1
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)


async def test_exhausted_budget_does_not_enter_provider_queue(monkeypatch):
    monkeypatch.setenv("AI_TASK_MAX_MODEL_CALLS", "1")
    graph, store, _, reference, model = setup_graph(monkeypatch, [parsed()], parts=["First", "Second"])
    admitted = []

    @asynccontextmanager
    async def slot(record, *, check=None):
        admitted.append(record["callKind"])
        yield

    monkeypatch.setattr(llm, "provider_slot", slot)
    output = await graph.ainvoke({"document": reference}, run_config())
    assert len(output["result"]["questions"]) == len(model.calls) == 1
    assert admitted == ["document_parse"]
    budgets = await store.asearch(execution.namespace("thread-1", "budget"))
    assert sum(item.value["spent"] for item in budgets) == 1


@pytest.mark.usefixtures("disposable_databases")
@pytest.mark.parametrize("pause_source", ["store", "api"])
async def test_pause_at_provider_admission_prevents_model_call(monkeypatch, pause_source):
    from practiq_ai import task_api
    from practiq_ai.contracts import (
        DocumentReference,
        DocumentTaskControl,
        DocumentTaskCreate,
    )
    from tests.db_support import setup_api

    # Hold the coordinator so API pause must be observed from its committed run flag.
    monkeypatch.setattr(runtime.Service, "controls", lambda self: self.stop_event.wait())
    service, reference, model = await setup_api(monkeypatch, [parsed()])
    once = True

    @asynccontextmanager
    async def slot(_record, *, check=None):
        nonlocal once
        if once:
            once = False
            run = (await service.db.rows("SELECT run_id,thread_id FROM document_runs WHERE status='running'"))[0]
            if pause_source == "store":
                await service.db.store.aput(execution.namespace(run["thread_id"], "pause"), run["run_id"], {"requested": True})
            else:
                await task_api.control_task(run["thread_id"], DocumentTaskControl(
                    requestId=uuid4(), action="pause", runId=run["run_id"]))
        yield

    monkeypatch.setattr(llm, "provider_slot", slot)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    state = await task_api.get_task(receipt["threadId"])
    assert state["state"] == "PAUSED" and not model.calls, state
    await task_api.control_task(receipt["threadId"], DocumentTaskControl(
        requestId=uuid4(), action="resume", checkpointId=state["checkpointId"]))
    await service.wait_idle()
    assert (await task_api.get_task(receipt["threadId"]))["state"] == "COMPLETED"
    assert len(model.calls) == 1
