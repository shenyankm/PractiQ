"""Upload -> real local storage -> native graph -> verified artifact download.

Models are fake; extraction and graph execution are real.
"""

import asyncio
import hashlib
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from practiq_ai import webapp
from practiq_ai.contracts import DOCUMENT_MEDIA_TYPES
from practiq_ai.graphs import document
from tests.support import FakeModel, local_graph, object_store, question, run_config

HEADERS = {"Authorization": "Bearer test-token"}


@pytest.fixture
def setup(monkeypatch, tmp_path):
    store = object_store(tmp_path)
    def response(_messages, schema):
        return {"questions": [question("Imported")], "groups": [], "figures": [{"kind": "image", "description": "Figure", "bbox": [0.1, 0.1, 0.8, 0.8]}]} if schema is document.PageParseResult else {"questions": [question("Imported")], "groups": []}

    model = FakeModel(responses=[response] * 2)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(webapp, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    return store, model


async def ingest(client, payload, kind, name):
    prepared = await client.post("/api/uploads", json={
        "sourceType": kind, "fileName": name,
        "mediaType": "image/png" if kind == "image" else min(DOCUMENT_MEDIA_TYPES[kind]),
        "sizeBytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
    })
    assert prepared.status_code == 201, prepared.text
    upload = prepared.json()["upload"]
    if upload:
        response = await client.put(upload["url"], content=payload, headers=upload["headers"])
        assert response.status_code == 200, response.text
    return prepared.json()["document"]


@pytest.mark.parametrize("kind,fixture", [
    ("pdf", "pdf/text-layer.pdf"), ("csv", "csv/basic.csv"),
    ("image", "image/clean.png"),
])
async def test_native_binary_import_and_verified_artifacts(setup, kind, fixture):
    store, _ = setup
    payload = (Path(__file__).parents[1] / "evals/fixtures" / fixture).read_bytes()
    async with AsyncClient(transport=ASGITransport(app=webapp.app), base_url="http://test", headers=HEADERS) as client:
        reference = await ingest(client, payload, kind, Path(fixture).name)
        result = await local_graph().ainvoke({"document": reference}, run_config())
        assert result["status"] == "SUCCEEDED"
        assert result["result"]["questions"][0]["stem"] == "Imported"
        assert result["usage"]
        if kind == "pdf":
            visual = result["result"]["visualElements"][0]
            assert "/" in visual["imageRef"]["objectKey"]
            assert "imageBase64" not in visual
            artifact = visual["imageRef"]
            response = await client.post("/api/artifacts/read", json=artifact)
            assert response.status_code == 200
            assert response.content == (store.root / artifact["objectKey"]).read_bytes()
            assert hashlib.sha256(response.content).hexdigest() == artifact["sha256"]
            forged = {**artifact, "objectKey": "private/secret"}
            assert (await client.post("/api/artifacts/read", json=forged)).status_code == 422
            (store.root / artifact["objectKey"]).write_bytes(b"x" * artifact["sizeBytes"])
            assert (await client.post("/api/artifacts/read", json=artifact)).status_code == 409


async def test_concurrent_native_runs_keep_distinct_usage(setup):
    _, model = setup
    model.responses *= 2
    async with AsyncClient(transport=ASGITransport(app=webapp.app), base_url="http://test", headers=HEADERS) as client:
        refs = [await ingest(client, text, "text", "q.txt") for text in (b"one", b"two")]
    results = await asyncio.gather(*(
        local_graph().ainvoke({"document": reference}, run_config()) for reference in refs
    ))
    assert all(len(result["usage"]) == 1 for result in results)
    assert results[0]["usage"][0]["callKey"] != results[1]["usage"][0]["callKey"]
