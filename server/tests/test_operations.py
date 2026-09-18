import argparse
import asyncio
import json
import os
import time
from types import SimpleNamespace

import httpx
import pytest

from practiq_ai.auth import auth, authenticate
from scripts import load_test, storage_gc
from tests.test_storage import object_store, upload


async def test_cleanup_keeps_historical_references_and_quarantines_only_old_orphans(tmp_path):
    store = object_store(tmp_path)
    referenced = await store.put_document(b"referenced", upload(b"referenced"))
    orphan = await store.put_document(b"orphan", upload(b"orphan"))
    recent = await store.put_document(b"recent", upload(b"recent"))
    for ref in (referenced, orphan):
        os.utime(tmp_path / ref.objectKey, (1, 1))
    calls = []

    async def search(**kwargs):
        return [{"thread_id": "old-task"}]

    async def history(path, *, params):
        calls.append(params.get("before"))
        return ([{"checkpoint": {"checkpoint_id": str(i)}, "values": {}} for i in range(10)]
                if params.get("before") is None else [{"values": {"document": referenced.model_dump()}}])

    async def items(*args, **kwargs):
        assert kwargs["refresh_ttl"] is False
        return {"items": []}

    api = SimpleNamespace(threads=SimpleNamespace(search=search), http=SimpleNamespace(get=history), store=SimpleNamespace(search_items=items))
    sources = await storage_gc.live_sources(api)
    assert sources == {referenced.sha256} and calls == [None, "9"]
    selected = storage_gc.candidates(storage_gc.inventory(store), sources, time.time() - 187 * 86400)
    assert [item["key"] for item in selected] == [orphan.objectKey]
    storage_gc.quarantine(store, selected, "drill")
    assert await store.get_verified(referenced) == b"referenced"
    assert await store.get_verified(recent) == b"recent"
    assert (tmp_path / ".quarantine/drill" / orphan.objectKey).read_bytes() == b"orphan"
    assert not (tmp_path / orphan.objectKey).exists()


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
    api = SimpleNamespace(threads=SimpleNamespace(count=lambda **_: asyncio.sleep(0, result=0)))
    monkeypatch.setattr(storage_gc, "get_client", lambda **_: api)
    monkeypatch.setattr(storage_gc, "live_sources", lambda _: asyncio.sleep(0, result=set()))
    monkeypatch.setattr(storage_gc, "get_object_store", lambda: store)
    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"enabled": True}))
    monkeypatch.setattr(storage_gc.httpx, "AsyncClient", lambda **kwargs: real_client(transport=transport, **kwargs))
    args = argparse.Namespace(base_url="http://test", token="secret", quarantine=False, retention_days=187, output=tmp_path / "dry.json")
    report = await storage_gc.run(args)
    assert report["completed"] and report["objects"] == 1 and path.exists()
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


async def test_maintenance_blocks_native_writes_but_keeps_reference_reads(monkeypatch):
    monkeypatch.setenv("AI_MAINTENANCE_MODE", "true")
    for path, method in [("/threads", "POST"), ("/threads/id/state", "POST"), ("/store/items", "PUT"), ("/threads/id", "DELETE")]:
        with pytest.raises(auth.exceptions.HTTPException) as error:
            await authenticate("Bearer test-token", path, method)
        assert error.value.status_code == 503
    for path in ("/threads/search", "/threads/count", "/threads/id/history", "/store/items/search"):
        assert await authenticate("Bearer test-token", path, "POST")
    for path in ("/runs/batch", "/crons", "/threads/id/crons"):
        with pytest.raises(auth.exceptions.HTTPException) as error:
            await authenticate("Bearer test-token", path, "POST")
        assert error.value.status_code == 422


async def test_load_driver_upload_auth_partial_and_overload(monkeypatch):
    requests = []

    def handle(request):
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer test-token"
        if request.url.path == "/api/uploads":
            return httpx.Response(200, json={"upload": {"url": "/api/uploads/content", "headers": {"Content-Type": "text/plain"}}, "document": {}})
        if request.method == "PUT":
            assert request.content == b"synthetic"
            return httpx.Response(200)
        if request.method == "POST":
            return httpx.Response(202, json={"threadId": "t", "runId": "r"})
        if request.url.path.startswith("/api/document-tasks/"):
            return httpx.Response(200, json={"phase": "completed", "state": "COMPLETED", "status": "PARTIAL"})
        if request.url.path == "/api/metrics":
            return httpx.Response(200, text="practiq_provider_inflight 1\n")
        if request.url.path == "/metrics":
            return httpx.Response(200, text="lg_api_workers_active 1\n")
        return httpx.Response(200)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(load_test.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs))
    args = argparse.Namespace(token="test-token", base_url="http://test", input=None, text="synthetic", total=1,
                             submit_concurrency=1, request_timeout=3, completion_timeout=3, pid=None, api="document-tasks",
                             max_running=2, graph_concurrency=2, allow_rejections=False, environment="local-langgraph-dev", image_digest=None)
    result = await load_test.run(args)
    assert result["status"] == "FAILED" and result["results"]["runs"] == {"partial": 1}
    assert result["results"]["sampledProviderConcurrencyPeak"] == 1
    assert any(request.method == "PUT" for request in requests)
    async with real_client(base_url="http://test", transport=httpx.MockTransport(lambda _: httpx.Response(503))) as client:
        task = await load_test.submit(client, asyncio.Semaphore(1), {}, 0, [])
        assert await load_test.wait_for_run(client, asyncio.Semaphore(1), *task[:2], time.monotonic()+1, task[2]) == ("rejected_503", 0, None)


def test_oss_cleanup_requires_versioning_and_never_deletes_versions():
    from datetime import UTC, datetime
    from pathlib import Path
    from typing import Any, cast

    from practiq_ai.storage import OSSObjectStore

    store = object.__new__(OSSObjectStore)
    store._config = object_store(Path('/unused'))._config
    deleted = []
    enabled = False
    item = SimpleNamespace(key='practiq-agent/sources/' + 'a' * 64 + '/source.txt', last_modified=datetime(2020, 1, 1, tzinfo=UTC), size=4, etag='etag')
    store.client = cast(Any, SimpleNamespace(
        list_objects_v2=lambda _: SimpleNamespace(contents=[item], is_truncated=False),
        get_bucket_versioning=lambda _: SimpleNamespace(version_status='Enabled' if enabled else 'Suspended'),
        delete_object=lambda request: deleted.append(request),
    ))
    selected = storage_gc.inventory(store)
    with pytest.raises(ValueError, match='versioning'):
        storage_gc.quarantine(store, selected, 'drill')
    assert not deleted
    enabled = True
    storage_gc.quarantine(store, selected, 'drill')
    assert len(deleted) == 1 and deleted[0].version_id is None
