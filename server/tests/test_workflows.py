import asyncio
import json
from io import BytesIO
from typing import Any, cast
from uuid import uuid4

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableConfig, RunnableLambda
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver
from PIL import Image
from pydantic import BaseModel, Field, ValidationError

import server.agents.generator as generator
import server.agents.model as model_factory
import server.agents.parser as parser
import server.agents.vision as vision
from server.ai_schemas import (
    AnswerGenerationResult,
    DocumentParseRequest,
    DocumentParseResult,
    LearningReportResult,
)
from server.extractors import DocumentProcessingError, ExtractedDocument


class FakeModel(BaseChatModel):
    responses: list[Any]
    calls: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "fake"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=""))])

    def with_structured_output(
        self, schema: Any, *, include_raw=False, **kwargs
    ) -> RunnableLambda:
        async def invoke(messages):
            self.calls.append(list(messages))
            item = self.responses.pop(0)
            delay = 0
            if isinstance(item, tuple):
                delay, item = item
            if delay:
                await asyncio.sleep(delay)
            if isinstance(item, Exception):
                raise item
            raw = AIMessage(
                content=json.dumps(item),
                usage_metadata={
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "total_tokens": 15,
                },
            )
            try:
                parsed = cast(type[BaseModel], schema).model_validate(item)
                error = None
            except ValidationError as exc:
                parsed, error = None, exc
            if include_raw:
                return {"raw": raw, "parsed": parsed, "parsing_error": error}
            if error:
                raise error
            return parsed

        return RunnableLambda(invoke)


@pytest.mark.parametrize(
    ("provider", "base_url"),
    model_factory.BASE_URLS.items(),
)
def test_builds_supported_provider(provider: str, base_url: str) -> None:
    text, vision_model = model_factory.build_models(provider, "test-key", "text-model")
    assert isinstance(text, ChatOpenAI)
    assert text.openai_api_base == base_url
    assert cast(Any, text.openai_api_key).get_secret_value() == "test-key"
    assert text.max_retries == 0
    assert vision_model is None


def test_factory_rejects_unsupported_provider_and_deepseek_vision() -> None:
    with pytest.raises(ValueError, match="Unsupported"):
        model_factory.build_models("openai", "key", "text")
    with pytest.raises(ValueError, match="does not support vision"):
        model_factory.build_models("deepseek", "key", "text", "vision")


def test_graph_config_uses_environment_concurrency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_AGENT_MAX_CONCURRENCY", "7")
    assert model_factory.graph_config().get("max_concurrency") == 7


def question_dict(stem: str) -> dict[str, Any]:
    return {
        "stem": stem,
        "answerMode": "short_answer",
        "questionTypeId": "imported-short",
        "options": [],
        "contentBlocks": [{"partType": "text", "textValue": stem}],
        "confidence": 0.8,
        "needsReview": False,
    }


def parse_request(text: str = "1. What is 2+2?") -> DocumentParseRequest:
    return DocumentParseRequest(sourceType="text", text=text)


def test_extract_node_enforces_combined_visual_byte_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_MAX_VISION_BYTES", "3")
    monkeypatch.setattr(
        parser,
        "extract",
        lambda _request: ExtractedDocument(
            text="question", page_images=[b"12"], embedded_images=[b"34"]
        ),
    )

    with pytest.raises(DocumentProcessingError) as exc_info:
        parser._extract(parser.parse_graph_input(parse_request()))

    assert exc_info.value.status_code == 413
    assert (
        exc_info.value.detail == "Document visual content exceeds the configured limit"
    )


def test_parse_concurrent_results_are_stably_merged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeModel(
        responses=[
            (
                0.03,
                {
                    "questions": [
                        question_dict("1. First"),
                        question_dict("2. Second"),
                    ],
                    "groups": [],
                },
            ),
            (
                0,
                {
                    "questions": [
                        question_dict("2. Second"),
                        question_dict("3. Third"),
                    ],
                    "groups": [],
                },
            ),
        ]
    )
    monkeypatch.setattr(
        parser, "split_into_chunks", lambda _text: ["chunk a", "chunk b"]
    )

    with model_factory.collect_usage() as usage:
        result = asyncio.run(parser.parse_document(fake, None, parse_request()))

    assert len(usage) == 2
    assert len({call.callKey for call in usage}) == 2
    assert isinstance(result, DocumentParseResult)
    assert [q.stem for q in result.questions] == ["1. First", "2. Second", "3. Third"]
    assert result.qualityScore == 80.0
    assert "Fragment 1 of 2" in fake.calls[0][1].text


def test_parse_retries_validation_with_feedback() -> None:
    fake = FakeModel(
        responses=[
            {"questions": [{"stem": ""}], "groups": []},
            {"questions": [question_dict("1. Fixed")], "groups": []},
        ]
    )
    result = asyncio.run(parser.parse_document(fake, None, parse_request()))

    assert result.questions[0].stem == "1. Fixed"
    assert len(fake.calls) == 2
    assert "failed validation" in fake.calls[1][-1].text


def test_parse_skips_exhausted_chunk_but_keeps_others(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bad = {"questions": [{"stem": ""}], "groups": []}
    fake = FakeModel(
        responses=[
            (0.01, bad),
            {"questions": [question_dict("2. Works")], "groups": []},
            bad,
            bad,
        ]
    )
    monkeypatch.setattr(
        parser, "split_into_chunks", lambda _text: ["chunk a", "chunk b"]
    )

    result = asyncio.run(parser.parse_document(fake, None, parse_request()))

    assert [q.stem for q in result.questions] == ["2. Works"]
    assert any("failed validation" in warning for warning in result.warnings)


def test_parse_fails_when_all_chunks_fail() -> None:
    bad = {"questions": [{"stem": ""}], "groups": []}
    with pytest.raises(DocumentProcessingError) as exc_info:
        asyncio.run(
            parser.parse_document(
                FakeModel(responses=[bad, bad, bad]), None, parse_request()
            )
        )
    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == "AI agent returned invalid JSON"


def test_parse_maps_provider_errors_to_502() -> None:
    with pytest.raises(DocumentProcessingError) as exc_info:
        asyncio.run(
            parser.parse_document(
                FakeModel(responses=[RuntimeError("connection reset")]),
                None,
                parse_request(),
            )
        )
    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == "AI agent request failed"


def test_checkpoint_state_excludes_runtime_model() -> None:
    fake = FakeModel(
        responses=[{"questions": [question_dict("1. Stored")], "groups": []}]
    )
    graph = parser.build_parse_graph(InMemorySaver())
    config = cast(RunnableConfig, {"configurable": {"thread_id": "import-1"}})
    asyncio.run(
        parser.run_parse_graph(fake, None, parse_request(), graph=graph, config=config)
    )
    snapshot = asyncio.run(graph.aget_state(config))
    assert "FakeModel" not in repr(snapshot.values)
    assert all(
        not isinstance(value, BaseChatModel) for value in snapshot.values.values()
    )


def test_validation_retries_report_distinct_billable_calls() -> None:
    payload = {
        "answerPayload": {"correctOption": "A"},
        "canonicalAnswer": "4",
        "explanation": "Two plus two equals four.",
        "steps": ["Add the operands"],
        "confidence": 0.95,
    }
    fake = FakeModel(responses=[{"bad": True}, payload])
    with model_factory.collect_usage() as usage:
        asyncio.run(generator.generate_answer(fake, {"stem": "What is 2+2?"}))
    assert len(usage) == 2
    assert len({call.callKey for call in usage}) == 2
    assert {call.callKind for call in usage} == {"answer_generation"}
    assert all(call.inputTokens == 10 and call.outputTokens == 5 for call in usage)


def test_usage_rejects_non_integral_provider_tokens() -> None:
    raw = AIMessage(
        content="",
        response_metadata={
            "token_usage": {"prompt_tokens": 1.5, "completion_tokens": True}
        },
    )
    with model_factory.collect_usage():
        with pytest.raises(DocumentProcessingError) as exc_info:
            model_factory.record_usage(
                FakeModel(responses=[]), raw, "answer_generation", uuid4()
            )
    assert exc_info.value.code == "AI_USAGE_INVALID"


def test_generate_answer_and_report_and_validation_retry() -> None:
    answer_payload = {
        "answerPayload": {"correctOption": "A"},
        "canonicalAnswer": "4",
        "explanation": "Two plus two equals four.",
        "steps": ["Add the operands"],
        "confidence": 0.95,
    }
    report_payload = {
        "summary": "Limited context report.",
        "mastery": [],
        "weakPoints": [],
        "recommendations": ["Practice more"],
        "riskLevel": "low",
    }
    fake = FakeModel(responses=[{"bad": True}, answer_payload, report_payload])
    answer = asyncio.run(generator.generate_answer(fake, {"stem": "What is 2+2?"}))
    report = asyncio.run(generator.learning_report(fake, {"stats": {"answers": 7}}))

    assert isinstance(answer, AnswerGenerationResult)
    assert answer.canonicalAnswer == "4"
    assert isinstance(report, LearningReportResult)
    assert report.riskLevel == "low"
    assert "failed validation" in fake.calls[1][-1].text


def test_vision_ocr_uses_base64_image_url_and_crops() -> None:
    buffer = BytesIO()
    Image.new("RGB", (200, 200), "white").save(buffer, format="PNG")
    fake_vl = FakeModel(
        responses=[
            {
                "text": "OCR text with $x^2$",
                "figures": [
                    {
                        "kind": "chart",
                        "description": "A bar chart",
                        "bbox": [0.1, 0.1, 0.6, 0.6],
                    }
                ],
            }
        ]
    )

    text, visual_elements, warnings = asyncio.run(
        vision.ocr_pages(fake_vl, [buffer.getvalue()])
    )

    assert text == "OCR text with $x^2$"
    assert warnings == []
    assert visual_elements[0].imageBase64
    image_part = fake_vl.calls[0][0].content[1]
    assert image_part["type"] == "image_url"
    assert image_part["image_url"]["url"].startswith("data:image/png;base64,")


def test_crop_limit_removes_excess_payloads() -> None:
    items = [
        vision.VisualElement(
            kind="image", description="x", bbox=[0, 0, 1, 1], imageBase64="eA=="
        )
        for _ in range(vision.MAX_CROPS + 1)
    ]
    warnings = vision._limit_crops(items)
    assert items[-1].imageBase64 is None
    assert warnings
