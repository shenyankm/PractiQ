import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from scripts import load_test, storage_gc
from tests.support import object_store, upload


def test_dev_launcher_uses_single_process(tmp_path):
    (tmp_path / 'server').mkdir()
    python = tmp_path / 'python'
    python.write_text(f"#!{sys.executable}\nimport sys,json\nprint(json.dumps(sys.argv[1:]))\n")
    python.chmod(0o755)
    result = subprocess.run(['make', '-s', '-f', str(Path(__file__).parents[2] / 'Makefile'), 'server-dev', f'AI_PYTHON={python}'], cwd=tmp_path, check=True, capture_output=True, text=True)
    args = json.loads(result.stdout)
    assert args[:3] == ['-m', 'uvicorn', 'practiq_ai.webapp:app']
    assert args[args.index('--workers') + 1] == '1'
    assert args[args.index('--host') + 1] == '127.0.0.1'
    assert args[args.index('--env-file') + 1] == '../.env'


@pytest.mark.usefixtures("disposable_databases")
async def test_cleanup_keeps_historical_references_and_quarantines_only_old_orphans(tmp_path):
    store = object_store(tmp_path)
    referenced = await store.put_document(b"referenced", upload(b"referenced"))
    orphan = await store.put_document(b"orphan", upload(b"orphan"))
    recent = await store.put_document(b"recent", upload(b"recent"))
    for ref in (referenced, orphan):
        os.utime(tmp_path / ref.objectKey, (1, 1))
    from tests.db_support import new_database
    db = await new_database()
    from typing import TypedDict

    from langchain_core.runnables import RunnableConfig
    from langgraph.graph import END, START, StateGraph
    class State(TypedDict, total=False):
        document: dict
    graph = StateGraph(State).add_node('copy', lambda state: state).add_edge(START, 'copy').add_edge('copy', END).compile(checkpointer=db.checkpointer)
    config: RunnableConfig = {'configurable': {'thread_id': 'history'}}
    await graph.ainvoke({'document': referenced.model_dump()}, config)
    await graph.ainvoke({}, config)
    sources = await storage_gc.live_sources(db)
    assert sources == {referenced.sha256}
    await db.close()
    selected = storage_gc.candidates(storage_gc.inventory(store), sources, time.time() - 187 * 86400)
    assert [item["key"] for item in selected] == [orphan.objectKey]
    storage_gc.quarantine(store, selected, "drill")
    assert await store.get_verified(referenced) == b"referenced"
    assert await store.get_verified(recent) == b"recent"
    assert (tmp_path / ".quarantine/drill" / orphan.objectKey).read_bytes() == b"orphan"
    assert not (tmp_path / orphan.objectKey).exists()


@pytest.mark.usefixtures("disposable_databases")
async def test_cleanup_fails_closed_and_preserves_inventory_before_mutation(tmp_path, monkeypatch):
    store = object_store(tmp_path)
    orphan = await store.put_document(b"orphan", upload(b"orphan"))
    path = tmp_path / orphan.objectKey
    os.utime(path, (1, 1))
    selected = storage_gc.inventory(store)
    path.write_bytes(b"changed")
    with pytest.raises(RuntimeError, match="changed"):
        storage_gc.quarantine(store, selected, "drill")
    os.utime(path, (1, 1))
    from tests.db_support import new_database
    db = await new_database()
    monkeypatch.setattr(storage_gc, 'Database', lambda: db)
    monkeypatch.setattr(storage_gc, 'live_sources', lambda _: asyncio.sleep(0, result=set()))
    monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')
    monkeypatch.setattr(storage_gc, "get_object_store", lambda: store)
    args = argparse.Namespace(base_url="http://test", token="secret", quarantine=False, retention_days=187, output=tmp_path / "dry.json")
    report = await storage_gc.run(args)
    assert report["completed"] and report["objects"] == 1 and path.exists()
    from practiq_ai.database import Database
    db = Database(db.directory)
    monkeypatch.setattr(storage_gc, 'Database', lambda: db)
    args.quarantine = True
    args.output = tmp_path / "quarantine.json"

    def unavailable(*args):
        manifest = json.loads((tmp_path / "quarantine.json").read_text())
        assert manifest["candidates"] and manifest["completed"] is False
        raise OSError("storage unavailable")

    monkeypatch.setattr(storage_gc, "quarantine", unavailable)
    with pytest.raises(OSError):
        await storage_gc.run(args)
    assert path.exists()
    (tmp_path / "practiq-agent/link").symlink_to(tmp_path)
    with pytest.raises(ValueError, match="symlink"):
        storage_gc.inventory(store)


async def test_load_driver_upload_auth_partial_and_overload(monkeypatch):
    requests = []

    def handle(request):
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer test-token"
        if request.method == "POST" and request.url.path == "/api/uploads":
            return httpx.Response(200, json={"upload": {"url": "/api/uploads/content", "headers": {"Content-Type": "text/plain"}}, "document": {}})
        if request.method == "PUT" and request.url.path == "/api/uploads/content":
            assert request.content == b"synthetic"
            return httpx.Response(200)
        if request.method == "POST" and request.url.path == "/api/document-tasks":
            return httpx.Response(202, json={"threadId": "t", "runId": "r"})
        if request.method == "GET" and request.url.path == "/api/document-tasks/t":
            return httpx.Response(200, json={"phase": "completed", "state": "COMPLETED", "status": "PARTIAL"})
        if request.method == "GET" and request.url.path == "/api/metrics":
            return httpx.Response(200, text=(
                "practiq_pending_runs 3\npractiq_running_runs 1\n"
                "practiq_workers_max 2\npractiq_workers_available 1\n"
                "practiq_provider_inflight 1\n"
            ))
        if request.method == "GET" and request.url.path == "/ok":
            return httpx.Response(200, json={"ok": True})
        raise AssertionError(f"Unexpected request: {request.method} {request.url.path}")

    real_client = httpx.AsyncClient
    monkeypatch.setattr(load_test.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs))
    args = argparse.Namespace(token="test-token", base_url="http://test", input=None, text="synthetic", total=1,
                             submit_concurrency=1, request_timeout=3, completion_timeout=3, pid=None, api="document-tasks",
                             max_running=2, graph_concurrency=2, allow_rejections=False, environment="local-langgraph-dev", image_digest=None)
    result = await load_test.run(args)
    assert result["status"] == "FAILED" and result["results"]["runs"] == {"partial": 1}
    assert result["results"]["sampledProviderConcurrencyPeak"] == 1
    assert result["results"]["peakPendingRuns"] == 3
    assert result["results"]["peakRunningRuns"] == 1
    assert result["results"]["observedWorkerMaximum"] == 2
    assert result["results"]["minimumAvailableWorkers"] == 1
    assert result["results"]["batchSeconds"] >= 0
    assert result["results"]["successfulDocumentsPerMinute"] == 0
    assert result["runs"] == [{"threadId": "t", "runId": "r", "status": "partial"}]
    assert any(request.method == "PUT" for request in requests)
    async with real_client(base_url="http://test", transport=httpx.MockTransport(lambda _: httpx.Response(503))) as client:
        task = await load_test.submit(client, asyncio.Semaphore(1), {}, 0, [])
        assert await load_test.wait_for_run(client, asyncio.Semaphore(1), *task[:2], time.monotonic()+1, task[2]) == ("rejected_503", 0, None)


async def test_load_driver_polls_before_all_submissions_finish(tmp_path, monkeypatch):
    polled = asyncio.Event()
    source = tmp_path / "input.json"
    source.write_text("{}")

    async def submit(client, semaphore, graph_input, index, latencies, api):
        if index == 1:
            await asyncio.wait_for(polled.wait(), 1)
        return str(index), str(index), time.perf_counter()

    async def wait(client, semaphore, thread_id, run_id, deadline, submitted, api):
        polled.set()
        return "success", 0.1, 0.01

    async def monitor(client, done, *args):
        await done.wait()

    monkeypatch.setattr(load_test, "submit", submit)
    monkeypatch.setattr(load_test, "wait_for_run", wait)
    monkeypatch.setattr(load_test, "monitor", monitor)
    args = argparse.Namespace(token="test-token", base_url="http://test", input=source, total=2,
                             submit_concurrency=2, request_timeout=3, completion_timeout=3, pid=None, api="document-tasks",
                             max_running=2, graph_concurrency=2, allow_rejections=False, environment="local-langgraph-dev", image_digest=None)
    report = await load_test.run(args)
    assert report["results"]["runs"] == {"success": 2}
    assert report["results"]["successfulDocumentsPerMinute"] > 0
