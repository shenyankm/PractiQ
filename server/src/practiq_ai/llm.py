"""Model construction, bounded calls, structured output, and usage accounting."""

import asyncio
import json
import logging
import random
import time
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, cast
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import httpx2
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    ToolMessage,
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
from .config import is_loopback_host, load
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


@lru_cache(maxsize=1)
def get_model() -> ChatOpenAI:
    config = load()
    return build_model(
        config.provider, config.api_key, config.model_id,
        max_tokens=config.model_max_tokens, timeout=config.model_timeout_seconds, base_url=config.base_url,
    )


def build_model(
    provider: str,
    api_key: str,
    model_name: str,
    max_tokens: int = 16_384,
    timeout: float = 180,
    base_url: str | None = None,
) -> ChatOpenAI:
    if provider not in BASE_URLS and not (provider == "openai" and base_url):
        raise ValueError(f"Unsupported LLM provider: {provider}")
    endpoint = (base_url or BASE_URLS[provider]).rstrip("/")
    local_clients: dict[str, Any] = {}
    if is_loopback_host(urlsplit(endpoint).hostname):
        # macOS system proxies can capture loopback requests even without proxy env vars.
        local_clients = {
            "http_client": httpx2.Client(timeout=timeout, trust_env=False),
            "http_async_client": httpx2.AsyncClient(timeout=timeout, trust_env=False),
        }
    return ChatOpenAI(
        model=model_name,
        api_key=cast(Any, api_key),
        base_url=endpoint,
        **cast(dict[str, Any], {"max_tokens": max_tokens}),
        timeout=timeout,
        max_retries=0,
        extra_body={"enable_thinking": False}
        if endpoint == BASE_URLS["dashscope"] and model_name.startswith("qwen3.7-")
        else None,
        **local_clients,
    )


def _model_schema(schema: type[BaseModel]) -> dict[str, Any]:
    value = schema.model_json_schema()

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            # Fractional multipleOf is rejected by the model endpoint. Keep the
            # precision rule in local Pydantic / exported importer validation.
            node.pop("multipleOf", None)
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
        raise ValueError("Output was truncated; return a complete result without repetition. Do not omit questions or invent source content")
    raw = response["raw"]
    # The wire arguments are authoritative, even if the SDK already parsed them.
    wire_calls = raw.additional_kwargs.get("tool_calls", [])
    if wire_calls is not None and wire_calls != []:
        if not isinstance(wire_calls, list) or len(wire_calls) != 1 or not isinstance(wire_calls[0], dict):
            raise ValueError("Expected one tool call matching the response schema")
        function = wire_calls[0].get("function")
        if not isinstance(function, dict) or function.get("name") != schema.__name__ or "arguments" not in function:
            raise ValueError("Expected tool name and arguments matching the response schema")
        source = function["arguments"]
    else:
        calls = [*getattr(raw, "tool_calls", []), *getattr(raw, "invalid_tool_calls", [])]
        if calls:
            if len(calls) != 1 or not isinstance(calls[0], dict) or calls[0].get("name") != schema.__name__ or "args" not in calls[0]:
                raise ValueError("Expected one tool call matching the response schema")
            source = calls[0]["args"]
        else:
            parsed = response["parsed"]
            if isinstance(parsed, BaseModel):
                return schema.model_validate(parsed.model_dump(), context=context)
            source = raw.content
    if isinstance(source, dict):
        return schema.model_validate(source, context=context)
    if not isinstance(source, str):
        raise ValueError("Expected a JSON object or tool arguments")  # noqa: TRY004
    try:
        return schema.model_validate_json(source, context=context)
    except ValidationError as exc:
        if not any(item["type"] == "json_invalid" for item in exc.errors()):
            raise
        return schema.model_validate_json(repair_json(source), context=context)


def _validation_issues(error: ValueError, schema: type[BaseModel]) -> list[dict[str, Any]]:
    # Unknown keys, input values, messages and validator context can contain source
    # text or secrets. Only declared field names, indexes and error types leave here.
    fields: set[str] = set()
    def visit(node: Any) -> None:
        if isinstance(node, dict):
            fields.update(node.get("properties", {}))
            for child in node.values():
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)
    visit(schema.model_json_schema())
    if not isinstance(error, ValidationError):
        return [{"path": [], "type": "invalid_response"}]
    return [{"path": [part if isinstance(part, int) or part in fields else "?" for part in item["loc"][:12]],
             "type": item["type"]} for item in error.errors(include_input=False, include_context=False, include_url=False)[:20]]


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
    wire_calls = raw.additional_kwargs.get("tool_calls")
    return fingerprint({
        "content": raw.content,
        "tools": [(call.get("name"), call.get("args")) for call in [
            *getattr(raw, "tool_calls", []), *getattr(raw, "invalid_tool_calls", []),
        ]],
        "rawTools": [call.get("function") if isinstance(call, dict) else call for call in wire_calls]
        if isinstance(wire_calls, list) else wire_calls,
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
    with telemetry.measure("provider_request", call_record if call_record is not None else {}, "providerRequestMs"):
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
            call_record["validationIssues"] = _validation_issues(exc, schema)
            call_record["validationCode"] = "OUTPUT_TRUNCATED" if response["raw"].response_metadata.get("finish_reason") == "length" else "OUTPUT_INVALID"
    array_feedback = ""
    if isinstance(error, ValidationError):
        if any(item["type"] == "list_type" for item in error.errors()):
            array_feedback = (
                "Array fields must be actual JSON arrays, not quoted JSON strings. "
                "Return each field separately in the top-level object; do not pack "
                "the rest of the object into one field. Rebuild the complete object "
                "from the original source, preserving all questions, groups and figures.\n"
            )
        error = "; ".join(
            f"{'.'.join(map(str, item['loc'])) or 'result'}: {item['msg']}"
            for item in error.errors(include_input=False, include_url=False)
        )
    raw = response["raw"]
    wire = raw.additional_kwargs.get("tool_calls")
    calls = wire if wire is not None else [*raw.tool_calls, *raw.invalid_tool_calls]
    replies = []
    if calls:
        if (isinstance(calls, list) and all(isinstance(call, dict) and isinstance(call.get("id"), str)
                and call["id"] for call in calls) and len({call["id"] for call in calls}) == len(calls)):
            replies = [ToolMessage(content="Output failed validation; correct it using the following feedback.",
                                   tool_call_id=call["id"]) for call in calls]
        else:
            # Malformed envelopes cannot be replayed as protocol-level tool calls.
            raw = AIMessage(content=json.dumps(raw.model_dump(), default=str))
    return (
        None,
        [
            *messages,
            raw,
            *replies,
            HumanMessage(
                content=(
                    "Your previous output failed validation with these errors:\n"
                    f"{error}\n{array_feedback}Return a complete corrected result. "
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
    call_records: list[dict[str, Any]] | None = None,
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
            async with provider_slot(record):
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
                error_code = exc.code
                record.update(status="failed", error=exc.code, finishedAt=datetime.now(UTC).isoformat(), durationMs=round((time.monotonic() - started) * 1000, 3))
                if runtime is None:
                    raise
                error = {"status": exc.status_code, "code": exc.code, "detail": exc.detail}
            elif isinstance(exc, APIStatusError) and exc.status_code in {401, 403}:
                error = {"status": exc.status_code, "code": "AI_PROVIDER_AUTH_ERROR", "detail": "Check the model API key and permissions, then retry failed units"}
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
            if not provider_started and record["status"] == "started":
                record.update(status="rejected", error=error_code or "MODEL_CALL_REJECTED", finishedAt=datetime.now(UTC).isoformat(), durationMs=round((time.monotonic() - started) * 1000, 3))
            if call_records is not None:
                call_records.append(record)
            elapsed = time.monotonic() - started
            if not provider_started and outcome == "unknown":
                outcome = "rejected"
            telemetry.calls.labels(call_kind, outcome).inc()
            telemetry.duration.labels("model", outcome).observe(elapsed)
            telemetry.event("model_call", callKey=str(call_key), kind=call_kind, outcome=outcome,
                            runId=record["runId"], errorCode=error_code or record.get("validationCode"),
                            schema=schema.__name__, attempt=attempt, validation=record["validation"],
                            threadId=runtime.execution_info.thread_id if runtime and runtime.execution_info else None,
                            unitKey=CURRENT_UNIT.get(), durationMs=round(elapsed * 1000, 3),
                            concurrencyWaitMs=record.get("concurrencyWaitMs"),
                            rateWaitMs=record.get("rateWaitMs"), providerRequestMs=record.get("providerRequestMs"),
                            **({"validationIssues": record["validationIssues"]} if "validationIssues" in record else {}))
        record.update(call_usage.model_dump(mode="json"), status="completed", usageStatus="known",
                      finishedAt=datetime.now(UTC).isoformat(), durationMs=round((time.monotonic() - started) * 1000, 3))
        if runtime:
            await store_put(runtime, "calls", str(call_key), record)
        return {
            "parsed": parsed.model_dump(mode="json") if parsed is not None else None,
            "correction": messages_to_dict(corrected[len(messages):]),
            # Ignore provider IDs and usage; detect identical content AND error.
            "failureFingerprint": _failure_fingerprint(corrected[len(messages)], corrected[-1]) if parsed is None else None,
            "validationCode": record.get("validationCode"),
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
            if error["code"] in {"MODEL_BUDGET_EXCEEDED", "MODEL_INPUT_TOO_LARGE", "AI_PROVIDER_AUTH_ERROR", "AI_PROVIDER_ERROR"}:
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
            failure_code = saved.get("validationCode") or "OUTPUT_INVALID"
            if saved["failureFingerprint"] == previous_failure:
                failure_code = "OUTPUT_TRUNCATED" if failure_code == "OUTPUT_TRUNCATED" else "OUTPUT_STALLED"
                decision("stop", attempt, failure_code)
                return None, usage, failure_code
            previous_failure = saved["failureFingerprint"]
            messages = [*original_messages, *messages_from_dict(saved["correction"])]
            if attempt < MAX_MODEL_CALLS:
                decision("correct", attempt, failure_code)
            continue
        decision("accept", attempt)
        return schema.model_validate(saved["parsed"]), usage, None
    decision("stop", MAX_MODEL_CALLS, failure_code)
    return None, usage, failure_code
