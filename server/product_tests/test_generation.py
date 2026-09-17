import asyncio
import json
from typing import Any, cast
from uuid import uuid4

import practiq_ai.product.agents.model as model_factory
import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableLambda
from langchain_openai import ChatOpenAI
from practiq_ai.product.agents import generator
from practiq_ai.product.ai_schemas import (
    ANSWER_PAYLOAD_TYPES,
    AnswerGenerationResult,
    LearningReportResult,
)
from practiq_ai.product.support import DocumentProcessingError
from pydantic import BaseModel, Field, ValidationError


class FakeModel(BaseChatModel):
    responses: list[Any]
    schemas: list[Any] = Field(default_factory=list)
    calls: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "fake"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=""))])

    def with_structured_output(
        self, schema: Any, *, include_raw=False, **kwargs
    ) -> RunnableLambda:
        self.schemas.append(schema)

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
        asyncio.run(
            generator.generate_answer(
                fake,
                {
                    "stem": "What is 2+2?",
                    "answerMode": "choice", "choiceVariant": "single",
                    "options": [{"label": "A", "content": "4"}, {"label": "B", "content": "5"}],
                },
            )
        )
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
    with (
        model_factory.collect_usage(),
        pytest.raises(DocumentProcessingError) as exc_info,
    ):
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
    answer = asyncio.run(
        generator.generate_answer(
            fake,
            {
                "stem": "What is 2+2?",
                "answerMode": "choice", "choiceVariant": "single",
                "options": [{"label": "A", "content": "4"}, {"label": "B", "content": "5"}],
            },
        )
    )
    report = asyncio.run(generator.learning_report(fake, {"stats": {"mastery": []}}))

    assert isinstance(answer, AnswerGenerationResult)
    assert answer.canonicalAnswer == "4"
    assert isinstance(report, LearningReportResult)
    assert report.riskLevel == "low"
    assert "failed validation" in fake.calls[1][-1].text


@pytest.mark.parametrize(
    ("mode", "valid", "invalid"),
    [
        ("choice", {"correctOption": " a "}, {"correctOption": "Z"}),
        ("true_false", {"value": True}, {"value": "true"}),
        ("fill_blank", {"answers": ["4"]}, {"text": "4"}),
        ("short_answer", {"text": "4"}, {"answers": ["4"]}),
        ("short_answer", {"text": "4"}, '{"text":"4"}'),
    ],
)
def test_answer_semantic_repair_preserves_usage(mode, valid, invalid):
    base = {
        "canonicalAnswer": "4",
        "explanation": "Explanation",
        "steps": ["Solve"],
        "confidence": 0.9,
    }
    fake = FakeModel(
        responses=[{**base, "answerPayload": invalid}, {**base, "answerPayload": valid}]
    )
    with model_factory.collect_usage() as usage:
        result = asyncio.run(
            generator.generate_answer(
                fake,
                {
                    "stem": "Question",
                    "answerMode": mode, "choiceVariant": "single" if mode == "choice" else None,
                    "options": [{"label": "A", "content": "4"}, {"label": "B", "content": "5"}],
                },
            )
        )
    expected = {"correctOption": "A"} if mode == "choice" else valid
    assert result.model_dump()["answerPayload"] == expected
    assert ANSWER_PAYLOAD_TYPES[mode] in fake.schemas[0].model_fields["answerPayload"].annotation.__args__
    assert len(usage) == 2
    assert "failed validation" in fake.calls[1][-1].text
    assert "never invent" in fake.calls[1][-1].text


def test_missing_answer_returns_structured_result_without_retry():
    invalid = {
        "answerPayload": {},
        "canonicalAnswer": "Unknown",
        "explanation": "Missing image",
        "steps": [],
        "confidence": 0,
    }
    fake = FakeModel(responses=[invalid, invalid])
    with model_factory.collect_usage() as usage:
        result = asyncio.run(
            generator.generate_answer(
                fake, {"stem": "See image", "answerMode": "short_answer"}
            )
        )
    assert result.answerPayload is None
    assert "answerPayload" in result.missingFields
    assert len(usage) == len(fake.calls) == 1


@pytest.mark.parametrize(
    "bad_mastery",
    [
        [],
        [{"label": "Invented", "score": 1, "evidence": "invented"}],
        [{"label": "Math", "score": 1, "evidence": "invented"}] * 2,
    ],
)
def test_report_repairs_labels_and_computes_score_from_counts(bad_mastery):
    base = {
        "summary": "Practice",
        "weakPoints": [],
        "recommendations": [],
        "riskLevel": "medium",
    }
    valid = {
        **base,
        "mastery": [{"label": "Math", "score": 1, "evidence": "100% correct"}],
    }
    fake = FakeModel(responses=[{**base, "mastery": bad_mastery}, valid])
    result = asyncio.run(
        generator.learning_report(
            fake,
            {
                "stats": {
                    "mastery": [{"label": "Math", "attempts": 4, "correct": 1}],
                }
            },
        )
    )
    assert result.mastery[0].score == 0.25
    assert "1/4" in result.mastery[0].evidence
    assert len(fake.calls) == 2


def test_report_rejects_invented_weak_point():
    valid = {
        "summary": "Practice",
        "mastery": [],
        "weakPoints": [],
        "recommendations": [],
        "riskLevel": "low",
    }
    invalid = {
        **valid,
        "weakPoints": [
            {"label": "Invented", "reason": "None", "suggestedAction": "Practice"}
        ],
    }
    fake = FakeModel(responses=[invalid, valid])
    result = asyncio.run(generator.learning_report(fake, {"stats": {"mastery": []}}))
    assert not result.weakPoints
    assert len(fake.calls) == 2
