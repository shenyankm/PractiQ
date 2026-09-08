"""Model construction, bounded calls, structured output, and usage accounting."""

import asyncio
import logging
import random
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
from typing import Any, cast
from uuid import NAMESPACE_URL, uuid4, uuid5

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage
from langchain_openai import ChatOpenAI
from langgraph.runtime import Runtime
from openai import APIConnectionError, APIStatusError, APITimeoutError, RateLimitError
from pydantic import BaseModel

from .config import load
from .contracts import ModelCallUsage
from .errors import DocumentProcessingError

BASE_URLS = {
    "dashscope": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "deepseek": "https://api.deepseek.com",
    "moonshot": "https://api.moonshot.cn/v1",
}
MAX_MODEL_CALLS = 4
logger = logging.getLogger(__name__)


_USAGE: ContextVar[list[ModelCallUsage] | None] = ContextVar("document_usage", default=None)


@contextmanager
def collect_usage() -> Iterator[list[ModelCallUsage]]:
    calls: list[ModelCallUsage] = []
    token = _USAGE.set(calls)
    try:
        yield calls
    finally:
        _USAGE.reset(token)


def build_models(
    provider: str,
    api_key: str,
    text_model: str,
    vision_model: str | None = None,
    *,
    max_tokens: int = 16_384,
    timeout: float = 180,
) -> tuple[BaseChatModel, BaseChatModel | None]:
    if provider not in BASE_URLS:
        raise ValueError(f"Unsupported LLM provider: {provider}")
    return _build_model(provider, api_key, text_model, max_tokens, timeout), (
        _build_model(provider, api_key, vision_model, max_tokens, timeout)
        if vision_model
        else None
    )


@lru_cache(maxsize=1)
def get_models() -> tuple[BaseChatModel, BaseChatModel | None]:
    config = load()
    return build_models(
        config.provider,
        config.api_key,
        config.text_model,
        config.vision_model,
        max_tokens=config.model_max_tokens,
        timeout=config.model_timeout_seconds,
    )


def _build_model(
    provider: str,
    api_key: str,
    model_name: str,
    max_tokens: int,
    timeout: float,
) -> ChatOpenAI:
    return ChatOpenAI(
        model=model_name,
        api_key=cast(Any, api_key),
        base_url=BASE_URLS[provider],
        **cast(dict[str, Any], {"max_tokens": max_tokens}),
        timeout=timeout,
        max_retries=0,
    )


def _retryable_openai_error(exc: Exception) -> bool:
    if isinstance(exc, (APIConnectionError, APITimeoutError, RateLimitError)):
        return True
    return isinstance(exc, APIStatusError) and (
        exc.status_code in {408, 409, 429} or exc.status_code >= 500
    )


def _retry_delay(attempt: int) -> float:
    base = min(2 ** (attempt - 1), 8)
    return base + random.uniform(0, base / 2)


def usage_from_response(
    model: BaseChatModel,
    raw: BaseMessage,
    call_kind: str,
    runtime: Runtime[Any] | None,
    logical_attempt: int,
) -> ModelCallUsage:
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
    info = runtime.execution_info if runtime else None
    call_key = (
        uuid5(
            NAMESPACE_URL,
            f"{info.run_id}:{info.task_id}:{info.node_attempt}:{logical_attempt}:{call_kind}",
        )
        if info and info.run_id
        else uuid4()
    )
    model_id = (
        getattr(model, "model_name", None)
        or getattr(model, "model", None)
        or model._llm_type
    )
    return ModelCallUsage(
        callKey=call_key,
        modelId=str(model_id),
        inputTokens=input_tokens,
        outputTokens=output_tokens,
        callKind=call_kind,
    )


async def structured_attempt[ResultT: BaseModel](
    model: BaseChatModel,
    messages: list[BaseMessage],
    schema: type[ResultT],
    call_kind: str,
    *,
    runtime: Runtime[Any] | None = None,
    logical_attempt: int = 1,
) -> tuple[ResultT | None, list[BaseMessage], ModelCallUsage]:
    response = cast(
        dict[str, Any],
        await model.with_structured_output(
            schema, method="function_calling", include_raw=True
        ).ainvoke(messages),
    )
    usage = usage_from_response(
        model, response["raw"], call_kind, runtime, logical_attempt
    )
    if (calls := _USAGE.get()) is not None:
        calls.append(usage)
    if parsed := response["parsed"]:
        return parsed, messages, usage
    return None, [
        *messages,
        response["raw"],
        HumanMessage(
            content=(
                "Your previous output failed validation with these errors:\n"
                f"{response['parsing_error']}\nReturn a corrected result."
            )
        ),
    ], usage


async def structured_call[ResultT: BaseModel](
    model: BaseChatModel,
    messages: list[BaseMessage],
    schema: type[ResultT],
    call_kind: str,
    *,
    runtime: Runtime[Any] | None = None,
) -> tuple[ResultT | None, list[ModelCallUsage], str | None]:
    """Use one four-call budget for transport retries and output repair."""
    usage: list[ModelCallUsage] = []
    failure_code = "OUTPUT_INVALID"
    for attempt in range(1, MAX_MODEL_CALLS + 1):
        try:
            parsed, messages, call_usage = await structured_attempt(
                model,
                messages,
                schema,
                call_kind,
                runtime=runtime,
                logical_attempt=attempt,
            )
        except Exception as exc:
            if isinstance(exc, DocumentProcessingError):
                raise
            if not _retryable_openai_error(exc):
                raise DocumentProcessingError(
                    502, "AI provider request failed", "AI_PROVIDER_ERROR"
                ) from exc
            failure_code = "AI_PROVIDER_UNAVAILABLE"
            if attempt < MAX_MODEL_CALLS:
                logger.warning(
                    "Retrying transient model failure",
                    extra={"call_kind": call_kind, "attempt": attempt},
                )
                await asyncio.sleep(_retry_delay(attempt))
            continue
        usage.append(call_usage)
        if parsed is None:
            failure_code = "OUTPUT_INVALID"
            continue
        return parsed, usage, None
    return None, usage, failure_code
