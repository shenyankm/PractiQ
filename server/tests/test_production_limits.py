import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import httpx
import pytest

from practiq_ai import capacity, execution, task_api, webapp
from practiq_ai.auth import auth, authenticate
from practiq_ai.config import load
from practiq_ai.contracts import DocumentTaskCreate
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import pdf
from practiq_ai.graphs.chunking import split_chunk_spans
from tests.test_task_api import setup_api
from tests.test_task_execution import parsed, setup_graph
from tests.test_workflows import run_config


def test_pdf_entry_points_share_lock_and_release_after_failure(monkeypatch):
    active = peak = 0

    def work(*args):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        try:
            time.sleep(0.01)
            if args[0] == b"bad":
                raise ValueError("bad document")
            return []
        finally:
            active -= 1

    monkeypatch.setattr(pdf, "_extract", work)
    monkeypatch.setattr(pdf, "_render_pages", work)
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = [pool.submit(pdf.extract, "", b"bad"), pool.submit(pdf.render_pages, b"good", [0]),
                pool.submit(pdf.extract, "", b"good"), pool.submit(pdf.render_pages, b"good", [0])]
        with pytest.raises(ValueError):
            jobs[0].result()
        assert all(job.result() == [] for job in jobs[1:])
    assert peak == 1 and active == 0


def test_long_numbered_question_is_rejected_without_truncation():
    with pytest.raises(DocumentProcessingError) as error:
        split_chunk_spans("1. " + "文" * 90_000)
    assert error.value.code == "DOCUMENT_CHUNK_TOO_LARGE"
    for target in (0, 40_001):
        with pytest.raises(ValueError):
            split_chunk_spans("small", target)
    text = "1. " + "文" * 25_000 + "\n2. " + "字" * 25_000
    spans = split_chunk_spans(text)
    assert all(span["end"] - span["start"] <= 40_000 for span in spans)
    assert "".join(text[span["start"]:span["end"]] for span in spans) == text


async def test_parallel_budget_is_reserved_before_calls_and_never_refunded(monkeypatch):
    monkeypatch.setenv("AI_TASK_MAX_MODEL_CALLS", "4")
    graph, store, _, reference, model = setup_graph(monkeypatch, [parsed()], parts=["a", "b"])
    config = run_config()
    result = await graph.ainvoke({"document": reference}, config)
    assert result["status"] == "PARTIAL" and len(model.calls) == 1
    failure = result["processing"]["failures"][0]
    assert failure["code"] == "MODEL_BUDGET_EXCEEDED" and not failure["retryable"]
    state = (await graph.aget_state(config)).values
    assert state["reservedCalls"] == 4 and sorted(state["callAllowances"].values()) == [0, 4]
    await graph.ainvoke(None, {**config, "run_id": uuid4()})
    assert len(model.calls) == 1
    budget = await store.aget(execution.namespace("thread-1", "budget"), "document_parse:0:0")
    assert budget is not None and budget.value == {"spent": 1}


async def test_unknown_call_consumes_budget_after_interruption(monkeypatch):
    monkeypatch.setenv("AI_TASK_MAX_MODEL_CALLS", "2")
    graph, store, _, reference, model = setup_graph(monkeypatch, [(30, parsed()), parsed()])
    config = run_config()
    running = asyncio.create_task(graph.ainvoke({"document": reference}, config))
    async with asyncio.timeout(5):
        while not model.calls:
            await asyncio.sleep(0.001)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    result = await graph.ainvoke(None, {**config, "run_id": uuid4()})
    assert result["status"] == "SUCCEEDED" and len(model.calls) == 2
    budget = await store.aget(execution.namespace("thread-1", "budget"), "document_parse:0:0")
    assert budget is not None and budget.value["spent"] == 2
    records = await store.asearch(execution.namespace("thread-1", "calls"))
    assert sorted(item.value["usageStatus"] for item in records) == ["known", "unknown"]


async def test_run_deadline_is_enforced_without_resetting_task_budget(monkeypatch):
    monkeypatch.setenv("AI_RUN_TIMEOUT_SECONDS", "0.05")
    graph, _, _, reference, model = setup_graph(monkeypatch, [(10, parsed()), parsed()])
    config = run_config()
    with pytest.raises(DocumentProcessingError) as error:
        await graph.ainvoke({"document": reference}, config)
    assert error.value.code == "RUN_DEADLINE_EXCEEDED"
    with pytest.raises(DocumentProcessingError, match="deadline"):
        await graph.ainvoke(None, config)
    assert len(model.calls) == 1
    output = await graph.ainvoke(None, {**config, "run_id": uuid4()})
    assert output["status"] == "SUCCEEDED" and len(model.calls) == 2


async def test_model_text_limit_is_applied_before_provider(monkeypatch):
    monkeypatch.setenv("AI_MODEL_MAX_INPUT_CHARS", "1")
    graph, _, _, reference, model = setup_graph(monkeypatch, [parsed()])
    config = run_config()
    with pytest.raises(DocumentProcessingError):
        await graph.ainvoke({"document": reference}, config)
    state = (await graph.aget_state(config)).values
    assert state["chunkResults"][0]["failureCode"] == "MODEL_INPUT_TOO_LARGE"
    assert not model.calls


async def test_provider_rate_and_concurrency_gate(monkeypatch):
    gate = capacity.ProviderGate(1, 1)
    now = 100.0
    monkeypatch.setattr(capacity.time, "monotonic", lambda: now)

    async def advance(delay):
        nonlocal now
        now += delay

    monkeypatch.setattr(capacity.asyncio, "sleep", advance)
    await gate.wait_rate()
    await gate.wait_rate()
    assert now == 160 and len(gate.starts) == 1


async def test_admission_for_native_and_wrapper_routes(monkeypatch):
    monkeypatch.setenv("AI_MAX_BUSY_THREADS", "1")
    api, reference, model = setup_api(monkeypatch)

    async def full(**kwargs):
        return 1

    api.threads.count = full
    monkeypatch.setattr(capacity, "get_client", lambda **_: api)
    for path in ("/runs", "/runs/stream", "/threads/id/runs", "/threads/id/runs/wait"):
        with pytest.raises(auth.exceptions.HTTPException) as error:
            await authenticate("Bearer test-token", path, "POST")
        assert error.value.status_code == 503
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.create_task(DocumentTaskCreate.model_validate({"requestId": str(uuid4()), "document": reference}))
    assert error.value.code == "QUEUE_FULL" and not model.calls
    assert not api.records  # Overload must not leave an idle thread per rejected request.
    monkeypatch.setenv("AI_MAINTENANCE_MODE", "true")
    with pytest.raises(DocumentProcessingError, match="maintenance"):
        await capacity.admit_run(api)


async def test_upload_backpressure_releases_slot_on_cancellation(monkeypatch):
    monkeypatch.setenv("AI_UPLOAD_CONCURRENCY", "1")
    first = webapp.upload_slot()
    await anext(first)
    with pytest.raises(webapp.HTTPException) as error:
        await anext(webapp.upload_slot())
    assert error.value.status_code == 429
    await first.aclose()
    second = webapp.upload_slot()
    await anext(second)
    await second.aclose()
    monkeypatch.setenv("AI_MAINTENANCE_MODE", "true")
    with pytest.raises(webapp.HTTPException) as error:
        await anext(webapp.upload_slot())
    assert error.value.status_code == 503


async def test_metrics_and_logs_do_not_contain_document_content(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="practiq.events")
    graph, store, _, reference, _ = setup_graph(monkeypatch, [parsed("private document phrase")])
    await graph.ainvoke({"document": reference}, run_config())
    events = [r.message for r in caplog.records if r.name == "practiq.events"]
    assert any('"event":"model_call"' in e for e in events)
    assert all("private document phrase" not in e and "test-key" not in e for e in events)
    record = (await store.asearch(execution.namespace("thread-1", "calls")))[0].value
    assert record["startedAt"] <= record["finishedAt"] and record["durationMs"] >= 0
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url="http://test") as client:
        assert (await client.get("/api/metrics")).status_code == 401
        response = await client.get("/api/metrics", headers={"Authorization": "Bearer test-token"})
        assert response.status_code == 200 and "practiq_stage_seconds_bucket" in response.text
        response = await client.get("/api/maintenance", headers={"Authorization": "Bearer test-token"})
        assert response.json() == {"enabled": False}


def test_deployment_limits_and_runtime_fingerprint(monkeypatch):
    monkeypatch.setenv("AI_DEPLOYMENT_WORKERS", "2")
    with pytest.raises(ValueError, match="Total deployment"):
        load()
    monkeypatch.setenv("N_JOBS_PER_WORKER", "4")
    assert load().deployment_workers == 2
    monkeypatch.setenv("AI_PROVIDER_RPM", "1")
    with pytest.raises(ValueError, match="per worker"):
        load()
    monkeypatch.setenv("AI_PROVIDER_RPM", "120")
    saved = execution.new_execution()
    monkeypatch.setattr(execution, "runtime_version", lambda: {"python": [0]})
    with pytest.raises(DocumentProcessingError, match="original deployment"):
        execution.validate_execution(saved)
    for name, value in [("AI_RUN_TIMEOUT_SECONDS", "nan"), ("AI_MAINTENANCE_MODE", "invalid")]:
        monkeypatch.setenv(name, value)
        with pytest.raises(ValueError):
            load()
        monkeypatch.delenv(name)


async def test_provider_slots_bound_parallel_calls_and_release_after_failure(monkeypatch):
    monkeypatch.setenv("N_JOBS_PER_WORKER", "1")
    monkeypatch.setenv("AI_PROVIDER_CONCURRENCY", "2")
    active = peak = 0

    async def call(index):
        nonlocal active, peak
        async with capacity.provider_slot():
            active += 1
            peak = max(peak, active)
            try:
                await asyncio.sleep(0.01)
                if index == 0:
                    raise ValueError("synthetic failure")
            finally:
                active -= 1

    results = await asyncio.gather(*(call(i) for i in range(8)), return_exceptions=True)
    assert isinstance(results[0], ValueError)
    assert peak == 2 and active == 0
    async with capacity.provider_slot():
        pass


async def test_pdf_timeout_keeps_lock_until_background_work_finishes(monkeypatch):
    import threading

    entered, release, second_entered = threading.Event(), threading.Event(), threading.Event()

    def work(data, *args):
        if data == b"first":
            entered.set()
            assert release.wait(5)
        else:
            second_entered.set()
        return []

    monkeypatch.setattr(pdf, "_render_pages", work)
    first = asyncio.create_task(asyncio.to_thread(pdf.render_pages, b"first", [0]))
    await asyncio.to_thread(entered.wait, 5)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(first, 0.01)
    second = asyncio.create_task(asyncio.to_thread(pdf.render_pages, b"second", [0]))
    try:
        await asyncio.sleep(0.02)
        assert not second_entered.is_set()
    finally:
        release.set()
    assert await asyncio.wait_for(second, 5) == [] and second_entered.is_set()
