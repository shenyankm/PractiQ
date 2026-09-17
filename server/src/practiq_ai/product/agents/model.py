from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID, uuid4

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.types import RetryPolicy
from openai import APIConnectionError, APIStatusError, APITimeoutError, RateLimitError
from pydantic import BaseModel, ValidationError

from ...llm import BASE_URLS, structured_output, validate_response
from ...llm import build_models as build_shared_models
from ..ai_schemas import ModelCallUsage
from ..support import DocumentProcessingError, positive_env


@dataclass(frozen=True)
class AgentContext:
    text_model: BaseChatModel
    vision_model: BaseChatModel | None = None


def build_models(
    provider: str,
    api_key: str,
    text_model: str,
    vision_model: str | None = None,
) -> tuple[BaseChatModel, BaseChatModel | None]:
    if provider not in BASE_URLS:
        raise ValueError(f"Unsupported LLM provider: {provider}")
    if provider == "deepseek" and vision_model:
        raise ValueError("DeepSeek does not support vision models")
    return build_shared_models(
        provider,
        api_key,
        text_model,
        vision_model,
        max_tokens=positive_env("AI_AGENT_MAX_TOKENS", 16_384),
        timeout=positive_env("AI_AGENT_TIMEOUT_SECONDS", 180, float),
    )


def graph_config(config: RunnableConfig | None = None) -> RunnableConfig:
    return {
        **(config or {}),
        "max_concurrency": positive_env("AI_AGENT_MAX_CONCURRENCY", 4),
    }


def _retryable_openai_error(exc: Exception) -> bool:
    if isinstance(exc, (APIConnectionError, APITimeoutError, RateLimitError)):
        return True
    if not isinstance(exc, APIStatusError):
        return False
    return exc.status_code in {408, 409, 429} or exc.status_code >= 500


# Preserve the previous one initial request plus three transport retries.
TRANSPORT_RETRY_POLICY = RetryPolicy(
    initial_interval=1.0,
    max_attempts=4,
    retry_on=_retryable_openai_error,
)

_USAGE: ContextVar[list[ModelCallUsage] | None] = ContextVar("ai_usage", default=None)


@contextmanager
def collect_usage() -> Iterator[list[ModelCallUsage]]:
    calls: list[ModelCallUsage] = []
    token = _USAGE.set(calls)
    try:
        yield calls
    finally:
        _USAGE.reset(token)


def record_usage(
    model: BaseChatModel, raw: BaseMessage, call_kind: str, call_key: UUID
) -> None:
    calls = _USAGE.get()
    if calls is None:
        return
    usage = getattr(raw, "usage_metadata", None) or getattr(
        raw, "response_metadata", {}
    ).get("token_usage")
    input_tokens = usage and usage.get("input_tokens", usage.get("prompt_tokens"))
    output_tokens = usage and usage.get("output_tokens", usage.get("completion_tokens"))
    if input_tokens is None or output_tokens is None:
        raise DocumentProcessingError(
            502, "AI provider response omitted token usage", "AI_USAGE_MISSING"
        )
    if (
        not isinstance(input_tokens, int)
        or isinstance(input_tokens, bool)
        or not isinstance(output_tokens, int)
        or isinstance(output_tokens, bool)
        or input_tokens < 0
        or output_tokens < 0
    ):
        raise DocumentProcessingError(
            502, "AI provider returned invalid token usage", "AI_USAGE_INVALID"
        )
    input_count, output_count = input_tokens, output_tokens
    model_id = (
        getattr(model, "model_name", None)
        or getattr(model, "model", None)
        or model._llm_type
    )
    calls.append(
        ModelCallUsage(
            callKey=call_key,
            modelId=str(model_id),
            inputTokens=input_count,
            outputTokens=output_count,
            callKind=call_kind,
        )
    )


async def structured_attempt[ResultT: BaseModel](
    model: BaseChatModel,
    messages: list[BaseMessage],
    schema: type[ResultT],
    call_kind: str,
    *,
    context: dict[str, Any] | None = None,
) -> tuple[ResultT | None, list[BaseMessage]]:
    call_key = uuid4()
    response = cast(
        dict[str, Any],
        await structured_output(model, schema).ainvoke(messages),
    )
    record_usage(model, response["raw"], call_kind, call_key)
    error = response["parsing_error"]
    try:
        return validate_response(response, schema, context=context), messages
    except ValueError as exc:
        error = exc
    if isinstance(error, ValidationError):
        error = "; ".join(
            f"{'.'.join(map(str, item['loc'])) or 'result'}: {item['msg']}"
            for item in error.errors(include_input=False, include_url=False)
        )
    return None, [
        *messages,
        response["raw"],
        HumanMessage(
            content=(
                "Your previous output failed validation with these errors:\n"
                f"{error}\nReturn a complete corrected result. Follow the original task rules; never invent facts to pass validation."
            )
        ),
    ]
