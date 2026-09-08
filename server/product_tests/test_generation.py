import asyncio
import json
from typing import Any, cast
from uuid import uuid4

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableLambda
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field, ValidationError

import practiq_ai.product.agents.model as model_factory
from practiq_ai.product.agents import generator
from practiq_ai.product.ai_schemas import (
    AnswerGenerationResult,
    LearningReportResult,
)
from practiq_ai.product.support import DocumentProcessingError


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
    with model_factory.collect_usage(), pytest.raises(DocumentProcessingError) as exc_info:
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
