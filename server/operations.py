"""In-flight AI operation admission, cancellation, and usage metering."""

from __future__ import annotations

import asyncio
import contextvars
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

from . import envelope
from .extractors import DocumentProcessingError


CallStatus = Literal['succeeded', 'provider_error', 'cancelled', 'timeout']


@dataclass
class UsageCollector:
    calls: list[dict[str, Any]] = field(default_factory=list)
    complete: bool = True
    _attempts: dict[str, int] = field(default_factory=dict)

    def record(
        self,
        *,
        stage: str,
        provider: str,
        model: str,
        status: CallStatus,
        raw: Any = None,
    ) -> None:
        attempt = self._attempts.get(stage, 0) + 1
        self._attempts[stage] = attempt
        input_tokens, output_tokens, known = _token_usage(raw)
        if not known:
            self.complete = False
        call: dict[str, Any] = {
            'callId': str(uuid.uuid4()),
            'stage': stage,
            'attempt': attempt,
            'provider': provider,
            'model': model,
            'status': status,
            'usageKnown': known,
        }
        if known:
            call['inputTokens'] = input_tokens
            call['outputTokens'] = output_tokens
        self.calls.append(call)

    def report(self) -> dict[str, Any]:
        return {'calls': list(self.calls), 'complete': self.complete}


@dataclass
class OperationState:
    operation_id: str
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)
    termination: Literal['cancelled', 'timeout'] | None = None


_collector: contextvars.ContextVar[UsageCollector | None] = contextvars.ContextVar(
    'practiq_usage_collector', default=None
)
_operation: contextvars.ContextVar[OperationState | None] = contextvars.ContextVar(
    'practiq_operation', default=None
)


def operation_id(value: str | None) -> str:
    try:
        parsed = uuid.UUID((value or '').strip())
    except ValueError as exc:
        raise envelope.new_error(
            422, 'AI_OPERATION_ID_INVALID', 'X-AI-Operation-ID must be a UUID'
        ) from exc
    if parsed.version != 4:
        raise envelope.new_error(
            422, 'AI_OPERATION_ID_INVALID', 'X-AI-Operation-ID must be a UUIDv4'
        )
    return str(parsed)


def record_model_call(
    model: Any, stage: str, status: CallStatus, raw: Any = None
) -> None:
    collector = _collector.get()
    if collector is None:
        return
    provider, model_name = _model_identity(model)
    collector.record(
        stage=stage,
        provider=provider,
        model=model_name,
        status=status,
        raw=raw,
    )


def termination_status() -> Literal['cancelled', 'timeout']:
    state = _operation.get()
    return state.termination if state and state.termination else 'cancelled'


def ensure_active() -> None:
    state = _operation.get()
    if state and state.cancelled.is_set():
        raise asyncio.CancelledError


class OperationManager:
    def __init__(self, timeout_seconds: float = 180.0, max_concurrency: int = 4):
        self._timeout = timeout_seconds
        self._semaphore = asyncio.Semaphore(max_concurrency)
        self._states: dict[str, OperationState] = {}
        self._operation_ids: set[str] = set()
        self._lock = asyncio.Lock()

    async def run(
        self, operation_id_value: str, factory: Callable[[], Awaitable[Any]]
    ) -> tuple[Any, dict[str, Any]]:
        async with self._lock:
            if operation_id_value in self._operation_ids:
                raise envelope.new_error(
                    409, 'AI_OPERATION_CONFLICT', 'AI operation is already running'
                )
            self._operation_ids.add(operation_id_value)
        try:
            started_at = asyncio.get_running_loop().time()
            try:
                await asyncio.wait_for(self._semaphore.acquire(), timeout=self._timeout)
            except TimeoutError as exc:
                raise envelope.new_error(
                    504,
                    'AI_OPERATION_TIMEOUT',
                    'AI operation exceeded its deadline while waiting for admission',
                    meta={'usage': {'calls': [], 'complete': True}},
                ) from exc

            remaining = max(
                0.0, self._timeout - (asyncio.get_running_loop().time() - started_at)
            )
            try:
                return await self._run_active(operation_id_value, factory, remaining)
            finally:
                self._semaphore.release()
        finally:
            async with self._lock:
                self._operation_ids.discard(operation_id_value)

    async def _run_active(
        self,
        operation_id_value: str,
        factory: Callable[[], Awaitable[Any]],
        remaining_timeout: float,
    ) -> tuple[Any, dict[str, Any]]:
        state = OperationState(operation_id_value)
        async with self._lock:
            self._states[operation_id_value] = state

        collector = UsageCollector()
        collector_token = _collector.set(collector)
        operation_token = _operation.set(state)

        async def invoke_factory() -> Any:
            return await factory()

        task = asyncio.create_task(invoke_factory())
        cancel_wait = asyncio.create_task(state.cancelled.wait())
        timeout_wait = asyncio.create_task(asyncio.sleep(remaining_timeout))
        try:
            done, _ = await asyncio.wait(
                {task, cancel_wait, timeout_wait},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if task in done:
                return await task, collector.report()
            state.termination = 'cancelled' if cancel_wait in done else 'timeout'
            state.cancelled.set()
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            code = (
                'AI_OPERATION_CANCELLED'
                if state.termination == 'cancelled'
                else 'AI_OPERATION_TIMEOUT'
            )
            status = 409 if state.termination == 'cancelled' else 504
            message = (
                'AI operation was cancelled'
                if state.termination == 'cancelled'
                else 'AI operation exceeded its deadline'
            )
            raise envelope.new_error(
                status, code, message, meta={'usage': collector.report()}
            )
        except envelope.APIError as exc:
            exc.meta.setdefault('usage', collector.report())
            raise
        except DocumentProcessingError as exc:
            raise envelope.new_error(
                exc.status_code,
                exc.code,
                exc.detail,
                meta={'usage': collector.report()},
            ) from exc
        except Exception as exc:
            logging.getLogger('practiq.ai').exception(
                'AI operation failed operation=%s', operation_id_value
            )
            raise envelope.new_error(
                500,
                'INTERNAL_ERROR',
                'Unexpected server error',
                meta={'usage': collector.report()},
            ) from exc
        finally:
            cancel_wait.cancel()
            timeout_wait.cancel()
            async with self._lock:
                self._states.pop(operation_id_value, None)
            _operation.reset(operation_token)
            _collector.reset(collector_token)

    async def cancel(self, operation_id_value: str) -> None:
        async with self._lock:
            state = self._states.get(operation_id_value)
            if state is None:
                raise envelope.new_error(
                    404, 'AI_OPERATION_NOT_FOUND', 'AI operation is not running'
                )
            state.cancelled.set()

def _model_identity(model: Any) -> tuple[str, str]:
    provider = str(getattr(model, 'practiq_provider', '') or '')
    model_name = str(
        getattr(model, 'model_name', '')
        or getattr(model, 'model', '')
        or getattr(model, '_llm_type', 'unknown')
    )
    if not provider:
        base_url = str(getattr(model, 'openai_api_base', '') or '')
        if 'dashscope.aliyuncs.com' in base_url:
            provider = 'dashscope'
        elif 'api.deepseek.com' in base_url:
            provider = 'deepseek'
        elif 'api.moonshot.cn' in base_url:
            provider = 'moonshot'
        else:
            provider = str(getattr(model, '_llm_type', 'unknown'))
    return provider, model_name


def _token_usage(raw: Any) -> tuple[int, int, bool]:
    if raw is None:
        return 0, 0, False
    usage = getattr(raw, 'usage_metadata', None)
    if not usage:
        metadata = getattr(raw, 'response_metadata', None) or {}
        usage = metadata.get('token_usage') or metadata.get('usage')
    if not isinstance(usage, dict):
        return 0, 0, False
    input_value = usage.get('input_tokens', usage.get('prompt_tokens'))
    output_value = usage.get('output_tokens', usage.get('completion_tokens'))
    if not isinstance(input_value, int) or not isinstance(output_value, int):
        return 0, 0, False
    if input_value < 0 or output_value < 0:
        return 0, 0, False
    return input_value, output_value, True
