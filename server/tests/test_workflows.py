import asyncio
import hashlib
from collections import Counter
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock

import httpx2
import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver
from openai import APIConnectionError, APIStatusError, APITimeoutError, RateLimitError
from pydantic import ValidationError

from practiq_ai import llm
from practiq_ai.contracts import (
    ArtifactReference,
    VisualElement,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document, vision
from tests.support import (
    FakeModel,
    local_graph,
    make_image,
    question,
    run_config,
    source,
)


def assert_json_value(value: Any) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            assert isinstance(key, str)
            assert_json_value(item)
    elif isinstance(value, list):
        for item in value:
            assert_json_value(item)
    else:
        assert value is None or type(value) in {bool, int, float, str}


@pytest.mark.parametrize(("provider", "base_url"), llm.BASE_URLS.items())
def test_builds_supported_provider(provider: str, base_url: str) -> None:
    text = llm.build_model(provider, "test-key", "text-model")
    assert isinstance(text, ChatOpenAI)
    assert text.openai_api_base == base_url


def test_builds_deepseek_vision_model() -> None:
    image = llm.build_model("deepseek", "test-key", "vision-model")
    assert isinstance(image, ChatOpenAI)


def test_document_graph_merges_parallel_chunks_and_keeps_checkpoint_small(monkeypatch):
    fake_store, reference = source("1. First\n2. Second\n3. Third")
    def response(messages, _schema):
        if "1. First" in messages[-1].content:
            return (0.02, {"questions": [question("1. First"), question("2. Second")], "groups": []})
        return {"questions": [question("2. Second"), question("3. Third")], "groups": []}

    model = FakeModel(responses=[response, response])
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(
        document, "split_chunk_spans", lambda text: [
            {"start": 0, "end": text.index("2. Second") + len("2. Second"), "overlapStart": 0, "overlapEnd": 0},
            {"start": text.index("2. Second"), "end": len(text), "overlapStart": text.index("2. Second"), "overlapEnd": text.index("2. Second") + len("2. Second")}
        ]
    )
    saver = InMemorySaver()
    graph = local_graph(saver)
    config = run_config()

    output = asyncio.run(
        graph.ainvoke({"document": reference}, config)
    )
    snapshot = asyncio.run(graph.aget_state(config))

    assert output["status"] == "SUCCEEDED"
    assert [item["stem"] for item in output["result"]["questions"]] == [
        "1. First",
        "2. Second",
        "3. Third",
    ]
    assert output["processing"]["chunks"] == {
        "total": 2,
        "succeeded": 2,
        "skipped": 0,
    }
    assert len(output["usage"]) == 2
    assert "memory" not in snapshot.values
    assert "FakeModel" not in repr(snapshot.values)
    assert_json_value(snapshot.values)


def test_document_graph_repairs_invalid_chunk_with_shared_budget(monkeypatch):
    fake_store, reference = source("1. Fixed")
    model = FakeModel(
        responses=[
            {"questions": [{"stem": ""}], "groups": []},
            {"questions": [question("1. Fixed")], "groups": []},
        ]
    )
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    graph = local_graph(InMemorySaver())

    output = asyncio.run(
        graph.ainvoke(
            {"document": reference}, run_config()
        )
    )

    assert output["result"]["questions"][0]["stem"] == "1. Fixed"
    assert len(output["usage"]) == 2
    assert "failed validation" in model.calls[1][-1].text


def test_document_graph_returns_partial_for_one_failed_chunk(monkeypatch):
    fake_store, reference = source("1. First\n2. Second")
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(
        document, "get_model", lambda *args: FakeModel(responses=[])
    )
    monkeypatch.setattr(
        document, "split_chunk_spans", lambda text: [
            {"start": 0, "end": text.index("2. Second") + len("2. Second"), "overlapStart": 0, "overlapEnd": 0},
            {"start": text.index("2. Second"), "end": len(text), "overlapStart": text.index("2. Second"), "overlapEnd": text.index("2. Second") + len("2. Second")}
        ]
    )

    async def partial_chunk(task, runtime):
        parsed = (
            {"questions": [question("1. First")], "groups": []}
            if task["index"] == 0
            else None
        )
        return {
            "chunkResults": [
                {
                    "index": task["index"],
                    "parsed": parsed,
                    "failureCode": None if parsed else "OUTPUT_INVALID",
                }
            ],
            "usage": [],
        }

    monkeypatch.setattr(document, "_chunk", partial_chunk)
    graph = local_graph(InMemorySaver())
    output = asyncio.run(
        graph.ainvoke(
            {"document": reference}, run_config()
        )
    )

    assert output["status"] == "PARTIAL"
    assert output["processing"]["chunks"]["succeeded"] == 1
    assert output["processing"]["failures"] == [
        {
            "stage": "document_parse",
            "index": 1,
            "code": "OUTPUT_INVALID",
            "retryable": True,
            "retriesRemaining": 2,
        }
    ]


def test_document_graph_raises_when_all_chunks_fail(monkeypatch):
    fake_store, reference = source("1. First")
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(
        document, "get_model", lambda *args: FakeModel(responses=[])
    )

    async def failed_chunk(task, runtime):
        return {
            "chunkResults": [
                {
                    "index": task["index"],
                    "parsed": None,
                    "failureCode": "OUTPUT_INVALID",
                }
            ],
            "usage": [],
        }

    monkeypatch.setattr(document, "_chunk", failed_chunk)
    graph = local_graph(InMemorySaver())

    with pytest.raises(DocumentProcessingError) as exc:
        asyncio.run(
            graph.ainvoke(
                {"document": reference}, run_config()
            )
        )
    assert exc.value.code == "DOCUMENT_PARSE_FAILED"


def test_document_graph_resumes_without_repeating_completed_chunk(monkeypatch):
    fake_store, reference = source("1. First\n2. Second")
    model = FakeModel(
        responses=[
            {"questions": [question("1. First")], "groups": []},
            {"questions": [question("2. Second")], "groups": []},
        ]
    )
    calls: Counter[int] = Counter()
    interrupted = True
    original_chunk = document._chunk

    async def unstable_chunk(task, runtime):
        nonlocal interrupted
        calls[task["index"]] += 1
        if task["index"] == 1 and interrupted:
            await asyncio.sleep(0.02)
            raise RuntimeError("worker interrupted")
        return await original_chunk(task, runtime)

    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(
        document, "split_chunk_spans", lambda text: [
            {"start": 0, "end": text.index("2. Second") + len("2. Second"), "overlapStart": 0, "overlapEnd": 0},
            {"start": text.index("2. Second"), "end": len(text), "overlapStart": text.index("2. Second"), "overlapEnd": text.index("2. Second") + len("2. Second")}
        ]
    )
    monkeypatch.setattr(document, "_chunk", unstable_chunk)
    graph = local_graph(InMemorySaver())
    config = run_config()

    with pytest.raises(RuntimeError, match="worker interrupted"):
        asyncio.run(
            graph.ainvoke(
                {"document": reference}, config
            )
        )
    interrupted = False
    output = asyncio.run(graph.ainvoke(None, config))

    assert calls == Counter({1: 2, 0: 1})
    assert [item["stem"] for item in output["result"]["questions"]] == [
        "1. First",
        "2. Second",
    ]


@pytest.mark.parametrize(
    ("field", "value", "code"),
    (
        ("sha256", "0" * 64, "DOCUMENT_CHECKSUM_MISMATCH"),
        ("sizeBytes", 1, "DOCUMENT_SIZE_MISMATCH"),
    ),
)
def test_document_integrity_fails_before_model_call(
    monkeypatch, field: str, value: Any, code: str
):
    fake_store, reference = source("question")
    reference[field] = value
    if field == "sha256":
        key = f"practiq-agent/sources/{value}/source.txt"
        fake_store.blobs[key] = fake_store.blobs[reference["objectKey"]]
        reference["objectKey"] = key
    model = FakeModel(responses=[])
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    graph = local_graph(InMemorySaver())

    with pytest.raises(DocumentProcessingError) as exc:
        asyncio.run(
            graph.ainvoke(
                {"document": reference}, run_config()
            )
        )
    assert exc.value.code == code
    assert model.calls == []


def test_checkpoint_update_cannot_bypass_document_reference_validation(monkeypatch):
    _, reference = source("question")
    reference["objectKey"] = "https://example.com/question.txt"

    class UnreachedStore:
        async def get_verified(self, _reference):
            raise AssertionError("unmanaged reference reached storage")

    monkeypatch.setattr(document, "get_object_store", lambda: UnreachedStore())
    graph = local_graph(InMemorySaver())
    config = run_config("checkpoint-input-boundary")

    async def resume_from_forged_state():
        await graph.aupdate_state(
            config, {"document": reference}, as_node="load_context"
        )
        await graph.ainvoke(None, config)

    with pytest.raises(ValidationError, match="managed storage source object"):
        asyncio.run(resume_from_forged_state())


def test_structured_call_uses_at_most_four_total_attempts(monkeypatch):
    model = FakeModel(responses=[RuntimeError("retry")] * 5)
    monkeypatch.setattr(llm, "_retryable_openai_error", lambda _exc: True)
    monkeypatch.setattr(llm, "_retry_delay", lambda _attempt: 0)

    parsed, usage, failure = asyncio.run(
        llm.structured_call(
            model,
            [HumanMessage(content="test")],
            document.ChunkParseResult,
            "document_chunk",
        )
    )

    assert parsed is None
    assert usage == []
    assert failure == "AI_PROVIDER_UNAVAILABLE"
    assert len(model.calls) == 4


def test_structured_call_does_not_retry_permanent_errors(monkeypatch):
    model = FakeModel(responses=[RuntimeError("permanent")])
    monkeypatch.setattr(llm, "_retryable_openai_error", lambda _exc: False)

    with pytest.raises(DocumentProcessingError) as exc:
        asyncio.run(
            llm.structured_call(
                model,
                [HumanMessage(content="test")],
                document.ChunkParseResult,
                "document_chunk",
            )
        )

    assert exc.value.code == "AI_PROVIDER_ERROR"
    assert len(model.calls) == 1


def test_usage_rejects_non_integral_provider_tokens() -> None:
    raw = AIMessage(
        content="",
        response_metadata={
            "token_usage": {"prompt_tokens": 1.5, "completion_tokens": True}
        },
    )
    with pytest.raises(DocumentProcessingError) as exc:
        llm.usage_from_response(
            FakeModel(responses=[]), raw, "document_chunk", None, 1
        )
    assert exc.value.code == "AI_USAGE_INVALID"


def test_page_result_retains_structured_questions_and_figures():
    parsed = document.PageParseResult.model_validate({
        "questions": [question("Visible question")],
        "figures": [{"kind": "chart", "description": "A chart", "bbox": [0.1, 0.1, 0.6, 0.6]}],
    })
    assert parsed.questions[0].stem == "Visible question"
    assert parsed.figures[0].bbox == [0.1, 0.1, 0.6, 0.6]
    with pytest.raises(ValueError):
        document.PageParseResult.model_validate({"figures": [{"description": "bad", "bbox": [0, 0, 2, 1]}]})


def test_crop_uploads_never_exceed_global_limit(monkeypatch):
    image = make_image()
    digest = hashlib.sha256(image).hexdigest()
    page_ref = ArtifactReference(
        objectKey="page-0.png",
        sha256=digest,
        mediaType="image/png",
        sizeBytes=len(image),
    )
    fake_store, reference = source("1. Question")
    page_ref_2 = page_ref.model_copy(update={"objectKey": "page-1.png"})
    fake_store.blobs["page-0.png"] = image
    fake_store.blobs["page-1.png"] = image
    visuals = [
        VisualElement(
            kind="chart",
            description=f"Chart {index}",
            page=index // 30,
            bbox=[0.1, 0.1, 0.6, 0.6],
        )
        for index in range(60)
    ]
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)

    cropped, failures, truncated = asyncio.run(
        document._crop_visuals(
            {
                "document": reference,
                "visionResults": [
                    {
                        "kind": "page",
                        "index": 0,
                        "artifact": page_ref.model_dump(mode="json"),
                        "visuals": [],
                    },
                    {
                        "kind": "page",
                        "index": 1,
                        "artifact": page_ref_2.model_dump(mode="json"),
                        "visuals": [],
                    },
                ],
            },
            visuals,
        )
    )

    assert sum(item.imageRef is not None for item in cropped) == 50
    assert sum(kind.startswith("crop-") for kind in fake_store.put_kinds) == 50
    assert failures == []
    assert truncated


def test_storage_work_is_bounded_by_configuration(monkeypatch):
    monkeypatch.setenv("AI_STORAGE_CONCURRENCY", "2")
    active = 0
    peak = 0

    async def work(item: int) -> int:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0)
        active -= 1
        return item

    assert asyncio.run(document._bounded_map(list(range(10)), work)) == list(
        range(10)
    )
    assert peak == 2


def test_missing_model_fails_before_processing(monkeypatch):
    _, reference = source("Question")
    monkeypatch.setattr(document, "get_model", lambda *args: None)
    with pytest.raises(DocumentProcessingError) as error:
        asyncio.run(local_graph().ainvoke({"document": reference}))
    assert error.value.code == "VISION_MODEL_REQUIRED"


def test_extractor_truncation_makes_result_partial(monkeypatch):
    fake_store, reference = source("1. Question")
    model = FakeModel(
        responses=[{"questions": [question("1. Question")], "groups": []}]
    )
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(
        document,
        "extract",
        AsyncMock(side_effect=lambda *_args: ExtractedDocument(text="1. Question", truncated=True)),
    )
    graph = local_graph(InMemorySaver())
    output = asyncio.run(
        graph.ainvoke(
            {"document": reference}, run_config()
        )
    )

    assert output["status"] == "PARTIAL"
    assert output["processing"]["truncated"] is True


def test_visual_unit_failure_returns_partial(monkeypatch):
    fake_store, reference = source("1. Question")
    image = make_image()
    model = FakeModel(
        responses=[
            {"invalid": 1},
            {"invalid": 2},
            {"invalid": 3},
            {"invalid": 4},
            {"questions": [question("1. Question")], "groups": []},
        ]
    )
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(
        document,
        "extract",
        AsyncMock(side_effect=lambda *_args: ExtractedDocument(
            text="1. Question", embedded_images=[image]
        )),
    )
    graph = local_graph(InMemorySaver())
    output = asyncio.run(
        graph.ainvoke(
            {"document": reference}, run_config()
        )
    )

    assert output["status"] == "PARTIAL"
    assert output["processing"]["visuals"] == {
        "total": 1,
        "succeeded": 0,
        "skipped": 0,
    }
    assert output["processing"]["failures"][0]["stage"] == "vision_describe"


def test_document_graph_extracts_directly_from_image_and_crops(monkeypatch):
    fake_store, reference = source("")
    image = make_image()
    model = FakeModel(
        responses=[
            {
                "questions": [question("Visible question")],
                "figures": [
                    {
                        "kind": "chart",
                        "description": "A chart",
                        "bbox": [0.1, 0.1, 0.6, 0.6],
                    }
                ],
            },
        ]
    )
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(
        document,
        "extract",
        AsyncMock(side_effect=lambda *_args: ExtractedDocument(text="", page_images=[image])),
    )

    output = asyncio.run(
        local_graph(InMemorySaver()).ainvoke(
            {"document": reference}, run_config()
        )
    )

    assert output["status"] == "SUCCEEDED"
    assert output["result"]["visualElements"][0]["imageRef"] is not None
    assert output["processing"]["visuals"]["succeeded"] == 1
    assert len(model.calls) == 1
    assert "ocr" not in fake_store.put_kinds
    assert "chunk" not in fake_store.put_kinds


def test_document_graph_describes_embedded_images(monkeypatch):
    fake_store, reference = source("1. Question")
    model = FakeModel(
        responses=[
            {"description": "An embedded diagram", "extractedText": "x = 1"},
            {"questions": [question("1. Question")], "groups": []},
        ]
    )
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(
        document,
        "extract",
        AsyncMock(side_effect=lambda *_args: ExtractedDocument(
            text="1. Question", embedded_images=[make_image()]
        )),
    )

    output = asyncio.run(
        local_graph(InMemorySaver()).ainvoke(
            {"document": reference}, run_config()
        )
    )

    visual = output["result"]["visualElements"][0]
    assert visual["description"] == "[embedded original] An embedded diagram"
    assert visual["extractedText"] == "x = 1"


@pytest.mark.parametrize(
    ("with_visual", "with_model", "code"),
    (
        (True, False, "VISION_MODEL_REQUIRED"),
        (False, True, "DOCUMENT_PROCESSING_FAILED"),
    ),
)
def test_document_graph_rejects_documents_without_text(
    monkeypatch, with_visual: bool, with_model: bool, code: str
):
    fake_store, reference = source("")
    model = FakeModel(responses=[])
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(document, "get_model", lambda *args: model if with_model else None)
    monkeypatch.setattr(
        document,
        "extract",
        AsyncMock(side_effect=lambda *_args: ExtractedDocument(
            text="", page_images=[make_image()] if with_visual else []
        )),
    )

    with pytest.raises(DocumentProcessingError) as exc:
        asyncio.run(
            local_graph(InMemorySaver()).ainvoke(
                {"document": reference}, run_config()
            )
        )
    assert exc.value.code == code
    assert exc.value.status_code in {409, 422}


def test_document_graph_rejects_empty_vision_output(monkeypatch):
    fake_store, reference = source("")
    model = FakeModel(responses=[{"invalid": True}] * 4)
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(
        document,
        "extract",
        AsyncMock(side_effect=lambda *_args: ExtractedDocument(text="", page_images=[make_image()])),
    )

    with pytest.raises(DocumentProcessingError) as exc:
        asyncio.run(
            local_graph(InMemorySaver()).ainvoke(
                {"document": reference}, run_config()
            )
        )
    assert exc.value.code == "DOCUMENT_PARSE_FAILED"


def test_document_graph_marks_text_truncation_and_rejects_no_questions(monkeypatch):
    fake_store, reference = source("1. A long question")
    model = FakeModel(
        responses=[
            {"questions": [question("1. A")], "groups": []},
            {"questions": [], "groups": []},
        ]
    )
    monkeypatch.setenv("AI_MAX_TOTAL_INPUT_CHARS", "6")
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    graph = local_graph(InMemorySaver())

    output = asyncio.run(
        graph.ainvoke(
            {"document": reference}, run_config("truncate")
        )
    )
    assert output["status"] == "PARTIAL"
    assert output["processing"]["truncated"] is True
    assert any("truncated" in warning for warning in output["result"]["warnings"])

    with pytest.raises(DocumentProcessingError) as exc:
        asyncio.run(
            graph.ainvoke(
                {"document": reference},
                run_config("no-questions"),
            )
        )
    assert exc.value.code == "NO_QUESTIONS_FOUND"


def test_crop_failures_are_reported(monkeypatch):
    image = make_image()
    digest = hashlib.sha256(image).hexdigest()
    page_ref = ArtifactReference(
        objectKey="page.png",
        sha256=digest,
        mediaType="image/png",
        sizeBytes=len(image),
    )
    fake_store, reference = source("1. Question")
    fake_store.blobs[page_ref.objectKey] = image
    monkeypatch.setattr(document, "get_object_store", lambda: fake_store)
    monkeypatch.setattr(vision, "crop_figure", lambda *_args: None)

    visuals, failures, _ = asyncio.run(
        document._crop_visuals(
            {
                "document": reference,
                "visionResults": [
                    {
                        "kind": "page",
                        "index": 0,
                        "artifact": page_ref.model_dump(mode="json"),
                        "visuals": [],
                    }
                ],
            },
            [
                VisualElement(
                    kind="chart",
                    description="Chart",
                    page=0,
                    bbox=[0.1, 0.1, 0.6, 0.6],
                )
            ],
        )
    )
    assert visuals[0].imageRef is None
    assert failures[0].code == "CROP_FAILED"


def test_vision_helpers_cover_media_and_crop_failures(monkeypatch):
    assert vision._media_type(b"GIF89a") == "image/gif"
    assert vision._media_type(b"RIFFxxxxWEBP") == "image/webp"
    assert vision._media_type(b"jpeg") == "image/jpeg"
    assert vision.crop_figure(make_image(), [0, 0, float("inf"), 1]) is None

    monkeypatch.setattr(vision, "MAX_CROP_BYTES", 1)
    assert vision.crop_figure(make_image(), [0, 0, 1, 1]) is None


def test_describe_image_returns_failure_after_invalid_outputs() -> None:
    described, usage, failure = asyncio.run(
        vision.describe_image(FakeModel(responses=[{"invalid": True}] * 4), make_image())
    )
    assert described is None
    assert len(usage) == 2
    assert failure == "OUTPUT_STALLED"


def _status_error(status: int) -> APIStatusError:
    response = httpx2.Response(
        status, request=httpx2.Request("POST", "https://example.invalid")
    )
    error_type = RateLimitError if status == 429 else APIStatusError
    return error_type("failed", response=response, body=None)


@pytest.mark.parametrize(
    ("error", "retryable"),
    (
        (
            APIConnectionError(
                request=httpx2.Request("POST", "https://example.invalid")
            ),
            True,
        ),
        (APITimeoutError(httpx2.Request("POST", "https://example.invalid")), True),
        (_status_error(408), True),
        (_status_error(409), True),
        (_status_error(429), True),
        (_status_error(500), True),
        (_status_error(400), False),
    ),
)
def test_openai_retry_classification(error: Exception, retryable: bool) -> None:
    assert llm._retryable_openai_error(error) is retryable


def test_retry_delay_is_bounded(monkeypatch):
    monkeypatch.setattr(llm.random, "uniform", lambda *_args: 0)
    assert llm._retry_delay(1) == 1
    assert llm._retry_delay(10) == 8


def test_usage_requires_metadata_and_uses_stable_runtime_key() -> None:
    model = FakeModel(responses=[])
    with pytest.raises(DocumentProcessingError) as missing:
        llm.usage_from_response(model, AIMessage(content=""), "test", None, 1)
    assert missing.value.code == "AI_USAGE_MISSING"

    raw = AIMessage(
        content="",
        response_metadata={
            "token_usage": {"prompt_tokens": 2, "completion_tokens": 3}
        },
    )
    runtime = SimpleNamespace(
        execution_info=SimpleNamespace(
            run_id="run", task_id="task", node_attempt=1
        )
    )
    first = llm.usage_from_response(model, raw, "test", cast(Any, runtime), 1)
    second = llm.usage_from_response(model, raw, "test", cast(Any, runtime), 1)
    assert first.callKey == second.callKey
    assert (first.inputTokens, first.outputTokens) == (2, 3)


def test_structured_call_preserves_processing_errors(monkeypatch):
    expected = DocumentProcessingError(502, "missing", "AI_USAGE_MISSING")

    async def fail(*_args, **_kwargs):
        raise expected

    monkeypatch.setattr(llm, "structured_attempt", fail)
    with pytest.raises(DocumentProcessingError) as exc:
        asyncio.run(
            llm.structured_call(
                FakeModel(responses=[]),
                [HumanMessage(content="test")],
                document.ChunkParseResult,
                "document_chunk",
            )
        )
    assert exc.value is expected
@pytest.mark.parametrize("provider", ["unknown", "openai"])
def test_model_builder_rejects_invalid_provider(provider: str) -> None:
    with pytest.raises(ValueError, match="Unsupported"):
        llm.build_model(provider, "key", "text")


def test_chunk_result_rejects_invalid_group_indexes() -> None:
    with pytest.raises(ValidationError, match="fragment question"):
        document.ChunkParseResult.model_validate(
            {
                "questions": [question("1. Question")],
                "groups": [{"title": "Bad", "questionIndexes": [1]}],
            }
        )
