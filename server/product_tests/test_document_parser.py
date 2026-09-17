"""Product HTTP contract -> local directory -> document graph regressions.

Only the model provider is fake; storage uses a temporary directory. Extraction, graph, storage validation,
HTTP envelopes, usage collection and Java answer-key mapping are real.
"""

import asyncio
import base64
import hashlib
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from langchain_openai import ChatOpenAI

from practiq_ai import llm, webapp
from practiq_ai.contracts import DocumentUploadRequest
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from practiq_ai.product import document_parser
from practiq_ai.product.app import create_app
from practiq_ai.product.config import load
from practiq_ai.product.services import ai
from tests.test_storage import object_store
from tests.test_workflows import FakeModel, question

HEADERS = {"Authorization": "Bearer test-token"}


@pytest.fixture
def setup(monkeypatch, tmp_path):
    store = object_store(tmp_path)
    model = FakeModel(responses=[])
    monkeypatch.setattr(document_parser, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(webapp, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_models", lambda: (model, None))
    return store, model


async def post(payload):
    async with AsyncClient(transport=ASGITransport(app=create_app(load())), base_url="http://test") as client:
        return await client.post("/api/v1/ai/parse-document", json=payload, headers=HEADERS)


@pytest.mark.parametrize(("mode", "native", "expected"), [
    ("choice", {"correctOption": "a"}, {"correctOption": "A"}),
    ("true_false", {"value": False}, {"answer": False}),
    ("fill_blank", {"answers": ["four"]}, {"answers": ["four"]}),
    ("short_answer", {"text": "four"}, {"answer": "four"}),
])
async def test_java_answer_keys_and_usage(setup, mode, native, expected):
    store, model = setup
    item = {**question("What is 2+2?"), "answerMode": mode, "answerPayload": native}
    if mode == "choice":
        item["options"] = [{"label": "A", "content": "four"}]
    model.responses = [{"questions": [item], "groups": []}]
    response = await post({"sourceType": "text", "text": "What is 2+2?"})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["questions"][0]["answerPayload"] == expected
    assert data["qualityScore"] == 80
    assert data["status"] == "SUCCEEDED"
    assert data["processing"]["chunks"] == {"total": 1, "succeeded": 1, "skipped": 0}
    usage = response.json()["meta"]["usage"]
    assert len(usage) == 1 and usage[0]["inputTokens"] == 10
    assert list((store.root / "practiq-agent/sources").rglob("source.*"))


@pytest.mark.parametrize(("kind", "fixture"), [
    ("docx", "docx/table.docx"), ("xlsx", "xlsx/single-sheet.xlsx"),
    ("pdf", "pdf/text-layer.pdf"), ("csv", "csv/basic.csv"),
])
async def test_worker_binary_payload_uses_new_extractors(setup, kind, fixture):
    _, model = setup
    model.responses = [{"questions": [question("Imported")], "groups": []}]
    payload = (Path(__file__).parents[1] / "evals/fixtures" / fixture).read_bytes()
    response = await post({"sourceType": kind, "fileName": Path(fixture).name,
                           "mimeType": "application/octet-stream",
                           "fileBase64": base64.b64encode(payload).decode()})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["questions"][0]["stem"] == "Imported"


async def test_partial_fragments_remain_drafts_with_failure_metadata_and_all_usage(setup, monkeypatch):
    _, model = setup
    monkeypatch.setattr(document, "split_into_chunks", lambda _: ["good", "bad"])
    model.responses = [{"questions": [question("Retained")], "groups": []}] + [{"bad": True}] * 4
    response = await post({"sourceType": "text", "text": "text"})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["status"] == "PARTIAL"
    assert data["questions"][0]["needsReview"] is True
    assert data["processing"]["failures"][0]["code"] == "OUTPUT_INVALID"
    assert len(response.json()["meta"]["usage"]) == 5


@pytest.mark.parametrize("responses,code,count", [
    ([{"bad": True}] * 4, "DOCUMENT_PARSE_FAILED", 4),
    ([{"bad": True}, RuntimeError("provider broke")], "AI_PROVIDER_ERROR", 1),
])
async def test_terminal_graph_failure_preserves_usage(setup, responses, code, count):
    _, model = setup
    model.responses = responses
    response = await post({"sourceType": "text", "text": "text"})
    assert response.status_code == 502, response.text
    assert response.json()["error"]["code"] == code
    assert len(response.json()["meta"]["usage"]) == count


async def test_timeout_keeps_completed_calls(setup, monkeypatch):
    _, model = setup
    model.responses = [{"bad": True}, (1, {"bad": True})]
    timeout = asyncio.timeout
    monkeypatch.setattr(ai.asyncio, "timeout", lambda _: timeout(0.05))
    response = await post({"sourceType": "text", "text": "text"})
    assert response.status_code == 504
    assert response.json()["error"]["code"] == "AI_TIMEOUT"
    assert len(response.json()["meta"]["usage"]) == 1


async def test_visual_ref_has_inline_preview_and_private_verified_download(setup, monkeypatch):
    _, model = setup
    vision = FakeModel(responses=[{"text": "Question", "figures": [
        {"kind": "chart", "description": "A chart", "bbox": [0.1, 0.1, 0.8, 0.8]}
    ]}])
    monkeypatch.setattr(document, "get_models", lambda: (model, vision))
    model.responses = [{"questions": [question("Question")], "groups": []}]
    image = (Path(__file__).parents[1] / "evals/fixtures/image/clean.png").read_bytes()
    response = await post({"sourceType": "image", "fileBase64": base64.b64encode(image).decode()})
    assert response.status_code == 200, response.text
    visual = response.json()["data"]["visualElements"][0]
    assert len(response.json()["meta"]["usage"]) == 2
    async with AsyncClient(transport=ASGITransport(app=webapp.app), base_url="http://test") as client:
        assert (await client.post("/api/artifacts/read", json=visual["imageRef"])).status_code == 401
        read = await client.post("/api/artifacts/read", json=visual["imageRef"], headers=HEADERS)
        assert read.status_code == 200
        assert read.content == base64.b64decode(visual["imageBase64"])
        forged = {**visual["imageRef"], "objectKey": "private/secret"}
        assert (await client.post("/api/artifacts/read", json=forged, headers=HEADERS)).status_code == 422


@pytest.mark.parametrize("payload,status", [
    ({"sourceType": "pdf", "fileBase64": "!bad"}, 400),
    ({"sourceType": "pdf", "fileBase64": ""}, 422),
    ({"sourceType": "text", "text": "large"}, 413),
])
async def test_invalid_sources_fail_before_models(setup, monkeypatch, payload, status):
    _, model = setup
    monkeypatch.setenv("AI_SOURCE_MAX_BYTES", "4")
    response = await post(payload)
    assert response.status_code == status
    assert not model.calls


async def test_inline_ingestion_verifies_existing_source_and_upload_metadata(setup):
    store, _ = setup
    request = DocumentUploadRequest(sourceType="text", fileName="q.txt", mediaType="text/plain",
                                    sizeBytes=4, sha256=hashlib.sha256(b"quiz").hexdigest())
    with pytest.raises(DocumentProcessingError, match="metadata"):
        await store.put_document(b"oops", request)
    reference = await store.put_document(b"quiz", request)
    assert await store.get_verified(reference) == b"quiz"
    (store.root / reference.objectKey).write_bytes(b"oops")
    with pytest.raises(DocumentProcessingError, match="checksum"):
        await store.put_document(b"quiz", request)
    with pytest.raises(DocumentProcessingError, match="checksum"):
        await store.get_verified(reference)


async def test_concurrent_requests_do_not_share_usage(setup):
    _, model = setup
    model.responses = [{"questions": [question("Q")], "groups": []}] * 2
    responses = await asyncio.gather(*(post({"sourceType": "text", "text": text}) for text in ["one", "two"]))
    usages = [response.json()["meta"]["usage"] for response in responses]
    assert all(len(usage) == 1 for usage in usages)
    assert usages[0][0]["callKey"] != usages[1][0]["callKey"]


def test_existing_moonshot_provider_remains_available(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "moonshot")
    from practiq_ai.config import load as graph_config
    assert graph_config().provider == "moonshot"
    model, _ = llm.build_models("moonshot", "fake-key", "fake-model")
    assert isinstance(model, ChatOpenAI)
    assert str(model.openai_api_base) == "https://api.moonshot.cn/v1"


async def test_embedded_docx_image_keeps_original_reference(setup, monkeypatch):
    _, model = setup
    vision = FakeModel(responses=[{"description": "Embedded figure", "extractedText": "caption"}])
    monkeypatch.setattr(document, "get_models", lambda: (model, vision))
    model.responses = [{"questions": [question("With image")], "groups": []}]
    payload = (Path(__file__).parents[1] / "evals/fixtures/docx/formula-image.docx").read_bytes()
    response = await post({"sourceType": "docx", "fileBase64": base64.b64encode(payload).decode()})
    assert response.status_code == 200, response.text
    visual = response.json()["data"]["visualElements"][0]
    assert "/embedded/" in visual["imageRef"]["objectKey"]
    assert visual["imageBase64"]


async def test_real_generation_service_and_http_routes_remain_available(setup, monkeypatch):
    _, model = setup
    monkeypatch.setattr(ai.agents, "build_models", lambda *_: (model, None))
    answer = {"answerPayload": {"correctOption": "A"}, "canonicalAnswer": "A",
              "explanation": "Because", "steps": ["Solve"], "confidence": 1}
    report = {"summary": "Limited evidence", "mastery": [], "weakPoints": [],
              "recommendations": ["Practice"], "riskLevel": "low"}
    model.responses = [answer, report]
    stats = {"attemptCount": 1, "correctCount": 1, "accuracy": 1,
             "startedAt": "2026-01-01T00:00:00Z", "endedAt": "2026-01-01T01:00:00Z",
             "mastery": [{"label": "Math", "attempts": 1, "correct": 1}],
             "accuracyTrend": [{"label": "Today", "accuracy": 1}],
             "weakKnowledgePoints": ["Math"]}
    async with AsyncClient(transport=ASGITransport(app=create_app(load())), base_url="http://test") as client:
        first = await client.post("/api/v1/ai/generate-answer", headers=HEADERS,
                                  json={"stem": "Question", "answerMode": "choice"})
        second = await client.post("/api/v1/ai/learning-report", headers=HEADERS,
                                   json={"scope": "individual", "stats": stats})
    assert first.status_code == second.status_code == 200
    assert first.json()["data"]["answerPayload"] == answer["answerPayload"]
    assert second.json()["data"]["summary"] == report["summary"]
    assert first.json()["meta"]["usage"][0]["callKind"] == "answer_generation"
    assert second.json()["meta"]["usage"][0]["callKind"] == "learning_report"
