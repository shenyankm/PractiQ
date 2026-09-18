"""Model construction, bounded calls, structured output, and usage accounting."""

import asyncio
import json
import logging
import random
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, cast
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    BaseMessage,
    HumanMessage,
    messages_from_dict,
    messages_to_dict,
)
from langchain_core.runnables import RunnableLambda
from langchain_core.utils.function_calling import convert_to_openai_tool
from langchain_openai import ChatOpenAI
from langgraph.func import task
from langgraph.runtime import Runtime
from openai import APIConnectionError, APIStatusError, APITimeoutError, RateLimitError
from pydantic import BaseModel, ValidationError

from . import telemetry
from .capacity import provider_slot
from .config import load
from .contracts import ModelCallUsage
from .errors import DocumentProcessingError
from .execution import (
    CURRENT_ARTIFACT,
    CURRENT_UNIT,
    fingerprint,
    guard,
    reserve_model_call,
    store_put,
)
from .json_repair import repair_json

BASE_URLS = {
    "dashscope": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "deepseek": "https://api.deepseek.com",
    "moonshot": "https://api.moonshot.cn/v1",
}
MAX_MODEL_CALLS = 4
logger = logging.getLogger(__name__)


_USAGE: ContextVar[list[ModelCallUsage] | None] = ContextVar(
    "document_usage", default=None
)


@contextmanager
def collect_usage() -> Iterator[list[ModelCallUsage]]:
    calls: list[ModelCallUsage] = []
    token = _USAGE.set(calls)
    try:
        yield calls
    finally:
        _USAGE.reset(token)


@lru_cache(maxsize=1)
def get_model() -> BaseChatModel:
    config = load()
    return build_model(
        config.provider, config.api_key, config.vision_model,
        max_tokens=config.model_max_tokens, timeout=config.model_timeout_seconds,
    )


def build_model(
    provider: str,
    api_key: str,
    model_name: str,
    max_tokens: int = 16_384,
    timeout: float = 180,
) -> ChatOpenAI:
    if provider not in BASE_URLS:
        raise ValueError(f"Unsupported LLM provider: {provider}")
    return ChatOpenAI(
        model=model_name,
        api_key=cast(Any, api_key),
        base_url=BASE_URLS[provider],
        **cast(dict[str, Any], {"max_tokens": max_tokens}),
        timeout=timeout,
        max_retries=0,
        extra_body={"enable_thinking": False}
        if provider == "dashscope" and model_name.startswith("qwen3.7-")
        else None,
    )


def _model_schema(schema: type[BaseModel]) -> dict[str, Any]:
    value = schema.model_json_schema()

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            properties = node.get("properties", {})
            if ({"answerMode", "sourceText"} <= properties.keys()
                    or {"questions", "groups"} <= properties.keys()
                    or {"bbox", "description", "kind"} <= properties.keys()):
                # Require field presence on the wire; values remain nullable and
                # local validation still accepts incomplete drafts without retries.
                node["required"] = list(properties)
            for child in node.values():
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(value)
    return value


def structured_output(model: BaseChatModel, schema: type[BaseModel]):
    # Only documented model families use the provider's constrained JSON decoder.
    families = (
        "qwen3.7-plus",
        "qwen3.7-flash",
        "qwen3.7-max",
        "qwen3.8-flash",
        "qwen3.8-max",
    )
    method = load().structured_output_method
    supported = (
        isinstance(model, ChatOpenAI)
        and model.openai_api_base == BASE_URLS["dashscope"]
        and any(
            model.model_name == name or model.model_name.startswith(name + "-")
            for name in families
        )
    )
    if method == "json_schema" and not supported:
        raise ValueError("Native JSON Schema is not enabled for this provider/model")
    if isinstance(model, ChatOpenAI) and supported and method != "function_calling":
        # Keep the raw response (including usage on truncation) instead of letting
        # the SDK parse and raise before our accounting/validation boundary.
        response_format = {
            "type": "json_schema",
            "json_schema": {
                "name": schema.__name__,
                "strict": True,
                "schema": _model_schema(schema),
            },
        }
        return model.bind(
            extra_body={
                **(model.extra_body or {}),
                "response_format": response_format,
            }
        ) | RunnableLambda(
            lambda raw: {
                "raw": raw,
                "parsed": cast(BaseMessage, raw).content,
                "parsing_error": None,
            }
        )
    return model.with_structured_output(
        convert_to_openai_tool(_model_schema(schema)) if isinstance(model, ChatOpenAI) else schema,
        method="function_calling", include_raw=True
    )


def validate_response[ResultT: BaseModel](
    response: dict[str, Any],
    schema: type[ResultT],
    *,
    context: dict[str, Any] | None = None,
) -> ResultT:
    if response["raw"].response_metadata.get("finish_reason") == "length":
        raise ValueError("Output was truncated; return a complete, more concise result")
    parsed = response["parsed"]
    if isinstance(parsed, BaseModel):
        return schema.model_validate(parsed.model_dump(), context=context)
    raw = response["raw"]
    # Inspect original tool arguments even when LangChain's parser failed.
    wire_calls = raw.additional_kwargs.get("tool_calls", [])
    if wire_calls:
        if len(wire_calls) != 1 or wire_calls[0]["function"]["name"] != schema.__name__:
            raise ValueError("Expected one tool call matching the response schema")
        source = wire_calls[0]["function"]["arguments"]
    else:
        calls = [*getattr(raw, "tool_calls", []), *getattr(raw, "invalid_tool_calls", [])]
        if calls:
            if len(calls) != 1 or calls[0]["name"] != schema.__name__:
                raise ValueError("Expected one tool call matching the response schema")
            source = calls[0]["args"]
        else:
            source = raw.content
    if isinstance(source, dict):
        return schema.model_validate(source, context=context)
    if not isinstance(source, str):
        raise ValueError("Expected JSON text or tool arguments")  # noqa: TRY004 - shared validation/repair boundary
    try:
        return schema.model_validate_json(source, context=context)
    except ValidationError as exc:
        if not any(error["type"] == "json_invalid" for error in exc.errors()):
            raise
    return schema.model_validate_json(repair_json(source), context=context)


def _retryable_openai_error(exc: Exception) -> bool:
    if isinstance(exc, (APIConnectionError, APITimeoutError, RateLimitError)):
        return True
    return isinstance(exc, APIStatusError) and (
        exc.status_code in {408, 409, 429} or exc.status_code >= 500
    )


def _retry_delay(attempt: int) -> float:
    base = min(2 ** (attempt - 1), 8)
    return base + random.uniform(0, base / 2)


def _failure_fingerprint(raw: BaseMessage, error: BaseMessage) -> str:
    return fingerprint({
        "content": raw.content,
        "tools": [(call.get("name"), call.get("args")) for call in [
            *getattr(raw, "tool_calls", []), *getattr(raw, "invalid_tool_calls", []),
        ]],
        "rawTools": [call.get("function") for call in raw.additional_kwargs.get("tool_calls", [])],
        "function": raw.additional_kwargs.get("function_call"),
        "error": error.content,
    })


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
    call_key: UUID | None = None,
    call_record: dict[str, Any] | None = None,
) -> tuple[ResultT | None, list[BaseMessage], ModelCallUsage]:
    response = cast(
        dict[str, Any],
        await structured_output(model, schema).ainvoke(messages, config={"metadata": {
            "practiqCallKey": str(call_key) if call_key else None,
            "practiqUnitKey": CURRENT_UNIT.get(), "practiqAttempt": logical_attempt,
            "practiqSchema": schema.__name__, "practiqCallKind": call_kind,
        }}),
    )
    if call_record is not None:
        metadata = response["raw"].response_metadata
        call_record["providerRequestId"] = metadata.get("request_id") or metadata.get("id")
    usage = usage_from_response(
        model, response["raw"], call_kind, runtime, logical_attempt
    )
    if call_key is not None:
        usage = usage.model_copy(update={"callKey": call_key})
    if (calls := _USAGE.get()) is not None:
        calls.append(usage)
    error = response["parsing_error"]
    try:
        parsed = validate_response(response, schema)
        if call_record is not None:
            call_record["validation"] = "passed"
        return parsed, messages, usage
    except ValueError as exc:
        error = exc
        if call_record is not None:
            call_record["validation"] = "failed"
            call_record["validationCode"] = "OUTPUT_TRUNCATED" if response["raw"].response_metadata.get("finish_reason") == "length" else "OUTPUT_INVALID"
    if isinstance(error, ValidationError):
        error = "; ".join(
            f"{'.'.join(map(str, item['loc'])) or 'result'}: {item['msg']}"
            for item in error.errors(include_input=False, include_url=False)
        )
    return (
        None,
        [
            *messages,
            response["raw"],
            HumanMessage(
                content=(
                    "Your previous output failed validation with these errors:\n"
                    f"{error}\nReturn a complete corrected result. "
                    "Follow the original task rules; never invent source content to pass validation."
                )
            ),
        ],
        usage,
    )


async def structured_call[ResultT: BaseModel](
    model: BaseChatModel,
    messages: list[BaseMessage],
    schema: type[ResultT],
    call_kind: str,
    *,
    runtime: Runtime[Any] | None = None,
) -> tuple[ResultT | None, list[ModelCallUsage], str | None]:
    """Checkpoint individual attempts; replay never replenishes the four-call budget."""
    usage: list[ModelCallUsage] = []
    failure_code = "OUTPUT_INVALID"
    original_messages = list(messages)
    previous_failure: str | None = None

    async def attempt_call(attempt: int, artifact: dict[str, Any] | None) -> dict[str, Any]:
        # The task receives references only. Image messages live in this closure,
        # never in task arguments or correction messages written to checkpoints.
        call_key = uuid4()
        record: dict[str, Any] = {
            "callKey": str(call_key), "callKind": call_kind,
            "modelId": str(getattr(model, "model_name", None) or model._llm_type),
            "status": "started", "usageStatus": "unknown", "inputTokens": None, "outputTokens": None,
            "attempt": attempt,
            "unitKey": CURRENT_UNIT.get(), "schema": schema.__name__, "validation": "not_run",
            "runId": runtime.execution_info.run_id if runtime and runtime.execution_info else None,
            "artifact": artifact,
            "startedAt": datetime.now(UTC).isoformat(),
        }
        started = time.monotonic()
        outcome = "unknown"
        error_code = None
        provider_started = False
        try:
            chars = sum(len(message.content) if isinstance(message.content, str) else sum(len(str(part.get("text", ""))) if isinstance(part, dict) else len(str(part)) for part in message.content) for message in messages)
            chars += sum(len(json.dumps(message.additional_kwargs, default=str)) for message in messages)
            if chars > load().model_max_input_chars:
                outcome = "rejected"
                error_code = "MODEL_INPUT_TOO_LARGE"
                return {"error": {"status": 413, "code": "MODEL_INPUT_TOO_LARGE", "detail": "Model text input exceeds the configured limit"}}
            await reserve_model_call(runtime)
            async with provider_slot():
                if runtime:
                    await store_put(runtime, "calls", str(call_key), record)
                provider_started = True
                telemetry.event("model_start", callKey=str(call_key), kind=call_kind,
                                schema=schema.__name__, attempt=attempt, unitKey=CURRENT_UNIT.get(),
                                runId=record["runId"],
                                threadId=runtime.execution_info.thread_id if runtime and runtime.execution_info else None)
                parsed, corrected, call_usage = await structured_attempt(
                    model, messages, schema, call_kind, runtime=runtime,
                    logical_attempt=attempt, call_key=call_key, call_record=record,
                )
            outcome = "known"
        except Exception as exc:
            if isinstance(exc, DocumentProcessingError):
                if runtime is None:
                    raise
                error = {"status": exc.status_code, "code": exc.code, "detail": exc.detail}
            elif _retryable_openai_error(exc):
                error = {"status": 502, "code": "AI_PROVIDER_UNAVAILABLE", "detail": "AI provider request failed"}
            else:
                error = {"status": 502, "code": "AI_PROVIDER_ERROR", "detail": "AI provider request failed"}
            error_code = error["code"]
            if not provider_started:
                outcome = "rejected"
            if error["code"] == "MODEL_BUDGET_EXCEEDED":
                outcome = "rejected"
                return {"error": error}
            record.update(status="failed", error=error["code"], finishedAt=datetime.now(UTC).isoformat(), durationMs=round((time.monotonic() - started) * 1000, 3))
            if runtime and error["code"] != "EXECUTION_STORE_UNAVAILABLE":
                await store_put(runtime, "calls", str(call_key), record)
            return {"error": error}
        finally:
            elapsed = time.monotonic() - started
            if not provider_started and outcome == "unknown":
                outcome = "rejected"
            telemetry.calls.labels(call_kind, outcome).inc()
            telemetry.duration.labels("model", outcome).observe(elapsed)
            telemetry.event("model_call", callKey=str(call_key), kind=call_kind, outcome=outcome,
                            runId=record["runId"], errorCode=error_code or record.get("validationCode"),
                            schema=schema.__name__, attempt=attempt, validation=record["validation"],
                            threadId=runtime.execution_info.thread_id if runtime and runtime.execution_info else None,
                            unitKey=CURRENT_UNIT.get(), durationMs=round(elapsed * 1000, 3))
        record.update(call_usage.model_dump(mode="json"), status="completed", usageStatus="known",
                      finishedAt=datetime.now(UTC).isoformat(), durationMs=round((time.monotonic() - started) * 1000, 3))
        if runtime:
            await store_put(runtime, "calls", str(call_key), record)
        return {
            "parsed": parsed.model_dump(mode="json") if parsed is not None else None,
            "correction": messages_to_dict(corrected[len(messages):]),
            # Ignore provider IDs and usage; detect identical content AND error.
            "failureFingerprint": _failure_fingerprint(corrected[-2], corrected[-1]) if parsed is None else None,
            "usage": call_usage.model_dump(mode="json"),
        }

    durable_attempt = task(name=f"{call_kind}_attempt")(attempt_call)
    def decision(action: str, attempt: int, code: str | None = None) -> None:
        telemetry.event("model_decision", kind=call_kind, unitKey=CURRENT_UNIT.get(),
                        attempt=attempt, decision=action, errorCode=code,
                        threadId=runtime.execution_info.thread_id if runtime and runtime.execution_info else None,
                        runId=runtime.execution_info.run_id if runtime and runtime.execution_info else None)

    for attempt in range(1, MAX_MODEL_CALLS + 1):
        await guard(runtime)
        saved = await (durable_attempt(attempt, CURRENT_ARTIFACT.get())
                       if runtime and runtime.execution_info else attempt_call(attempt, None))
        if error := saved.get("error"):
            previous_failure = None
            if error["code"] in {"MODEL_BUDGET_EXCEEDED", "MODEL_INPUT_TOO_LARGE"}:
                decision("stop", attempt, error["code"])
                return None, usage, error["code"]
            if error["code"] != "AI_PROVIDER_UNAVAILABLE":
                decision("stop", attempt, error["code"])
                raise DocumentProcessingError(error["status"], error["detail"], error["code"], usage)
            failure_code = "AI_PROVIDER_UNAVAILABLE"
            if attempt < MAX_MODEL_CALLS:
                decision("retry", attempt, error["code"])
                logger.warning(
                    "Retrying transient model failure",
                    extra={"call_kind": call_kind, "attempt": attempt},
                )
                await asyncio.sleep(_retry_delay(attempt))
            continue
        usage.append(ModelCallUsage.model_validate(saved["usage"]))
        if saved["parsed"] is None:
            if saved["failureFingerprint"] == previous_failure:
                decision("stop", attempt, "OUTPUT_STALLED")
                return None, usage, "OUTPUT_STALLED"
            previous_failure = saved["failureFingerprint"]
            messages = [*original_messages, *messages_from_dict(saved["correction"])]
            failure_code = "OUTPUT_INVALID"
            if attempt < MAX_MODEL_CALLS:
                decision("correct", attempt, failure_code)
            continue
        decision("accept", attempt)
        return schema.model_validate(saved["parsed"]), usage, None
    decision("stop", MAX_MODEL_CALLS, failure_code)
    return None, usage, failure_code
