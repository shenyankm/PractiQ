"""Durable execution boundaries shared by graph nodes and model attempts."""

import asyncio
import hashlib
import json
import math
import sys
from contextvars import ContextVar
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from langgraph.runtime import Runtime
from langgraph.types import interrupt

from .config import load
from .errors import DocumentProcessingError

STATE_VERSION = 5
TTL_MINUTES = 259_200
RECURSION_LIMIT = 10_000
CURRENT_EXECUTION: ContextVar[dict[str, Any] | None] = ContextVar("execution", default=None)
CURRENT_ARTIFACT: ContextVar[dict[str, Any] | None] = ContextVar("artifact", default=None)
CURRENT_UNIT: ContextVar[str | None] = ContextVar("unit", default=None)
CURRENT_ALLOWANCE: ContextVar[int] = ContextVar("allowance", default=0)


def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str, separators=(",", ":")).encode()).hexdigest()


@lru_cache(maxsize=1)
def code_version() -> str:
    root = Path(__file__).parent
    paths = [root / name for name in ("contracts.py", "grading.py", "llm.py", "execution.py", "config.py", "storage.py", "json_repair.py", "capacity.py", "telemetry.py", "runtime.py", "database.py", "task_api.py")]
    paths.extend(sorted((root / "graphs").glob("*.py")))
    paths.extend(sorted((root / "extractors").glob("*.py")))
    bundled_lock = root / "uv.lock"
    paths.append(bundled_lock if bundled_lock.exists() else root.parents[1] / "uv.lock")
    return hashlib.sha256(b"".join(path.read_bytes() for path in paths)).hexdigest()


@lru_cache(maxsize=1)
def runtime_version() -> dict[str, Any]:
    packages = {}
    for name in ("langgraph", "langgraph-checkpoint-sqlite", "aiosqlite", "langchain-core", "langchain-openai", "pydantic", "pypdfium2", "pillow", "alibabacloud-oss-v2"):
        try:
            packages[name] = version(name)
        except PackageNotFoundError:
            packages[name] = None
    return {"python": list(sys.version_info[:3]), "packages": packages}


def signature() -> dict[str, Any]:
    settings = asdict(load())
    for key in ("api_key", "oss_access_key_id", "oss_access_key_secret", "oss_security_token"):
        settings.pop(key)
    # Concurrency and timeouts can change without changing document semantics.
    for key in ("jobs_per_worker", "graph_max_concurrency", "storage_concurrency", "storage_timeout_seconds", "model_timeout_seconds", "deployment_workers", "provider_concurrency", "provider_rpm", "upload_concurrency", "upload_timeout_seconds", "max_busy_threads", "maintenance"):
        settings.pop(key)
    settings["storage_dir"] = str(settings["storage_dir"])
    return {"version": STATE_VERSION, "code": code_version(), "runtime": runtime_version(), "settings": settings}


def new_execution() -> dict[str, Any]:
    return {"signature": signature(), "expiresAt": (datetime.now(UTC) + timedelta(minutes=TTL_MINUTES)).isoformat()}


def validate_execution(execution: dict[str, Any] | None) -> None:
    if not execution or execution.get("signature") != signature():
        raise DocumentProcessingError(409, "Resume with the original deployment or create a new task", "EXECUTION_VERSION_MISMATCH")
    remaining_ttl(execution)


def remaining_ttl(execution: dict[str, Any]) -> int:
    minutes = (datetime.fromisoformat(execution["expiresAt"]) - datetime.now(UTC)).total_seconds() / 60
    if minutes <= 0:
        raise DocumentProcessingError(410, "Document task expired", "TASK_EXPIRED")
    return max(1, math.ceil(minutes))


def namespace(thread_id: str, kind: str) -> tuple[str, ...]:
    return ("document_tasks", thread_id, kind)


async def store_put(runtime: Runtime[Any], kind: str, key: str, value: dict[str, Any]) -> None:
    info = runtime.execution_info
    if runtime.store is None or info is None or info.thread_id is None:
        return
    execution = CURRENT_EXECUTION.get()
    try:
        await runtime.store.aput(namespace(info.thread_id, kind), key, dict(value), index=False,
                                 ttl=(remaining_ttl(execution) if execution else TTL_MINUTES) if runtime.store.supports_ttl else None)
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(503, "Execution store is unavailable", "EXECUTION_STORE_UNAVAILABLE") from exc


async def reserve_model_call(runtime: Runtime[Any] | None) -> None:
    """Spend a preallocated unit slot before I/O, including unknown/replayed calls.

    A unit has exactly one sequential writer under native per-thread run exclusion;
    concurrent units have different keys. No Store read/modify/write global counter.
    """
    unit = CURRENT_UNIT.get()
    if unit is None:
        return  # Standalone model helper, outside a document task.
    if runtime is None or runtime.store is None or runtime.execution_info is None or runtime.execution_info.thread_id is None:
        raise DocumentProcessingError(503, "Document budgets require a Store", "EXECUTION_STORE_REQUIRED")
    try:
        previous = await runtime.store.aget(namespace(runtime.execution_info.thread_id, "budget"), unit, refresh_ttl=False)
        spent = previous.value["spent"] if previous else 0
        if spent >= CURRENT_ALLOWANCE.get():
            raise DocumentProcessingError(429, "Document model-call budget exhausted", "MODEL_BUDGET_EXCEEDED")
        await store_put(runtime, "budget", unit, {"spent": spent + 1})
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(503, "Execution store is unavailable", "EXECUTION_STORE_UNAVAILABLE") from exc


async def run_remaining(runtime: Runtime[Any]) -> float:
    """A resumed run gets a new deadline; the task's call budget never resets."""
    info = runtime.execution_info
    if runtime.store is None or info is None or info.thread_id is None or info.run_id is None:
        raise DocumentProcessingError(503, "Document deadlines require a Store and run ID", "EXECUTION_STORE_REQUIRED")
    try:
        item = await runtime.store.aget(namespace(info.thread_id, "deadlines"), str(info.run_id), refresh_ttl=False)
        deadline = item.value["at"] if item else (datetime.now(UTC) + timedelta(seconds=load().run_timeout_seconds)).isoformat()
        if item is None:
            await store_put(runtime, "deadlines", str(info.run_id), {"at": deadline})
        remaining = (datetime.fromisoformat(deadline) - datetime.now(UTC)).total_seconds()
        if remaining <= 0:
            raise DocumentProcessingError(504, "Run execution deadline exceeded", "RUN_DEADLINE_EXCEEDED")
        return remaining
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(503, "Execution store is unavailable", "EXECUTION_STORE_UNAVAILABLE") from exc


async def guard(runtime: Runtime[Any] | None, execution: dict[str, Any] | None = None, *, check_pause: bool = True) -> None:
    execution = execution or CURRENT_EXECUTION.get()
    if execution is not None:
        await asyncio.to_thread(validate_execution, execution)
    if runtime is None or runtime.execution_info is None:
        return
    info = runtime.execution_info
    context = runtime.context if isinstance(runtime.context, dict) else {}
    operation = context.get("documentControl")
    if operation and runtime.store is None:
        raise DocumentProcessingError(503, "Task controls require a persistent Store", "EXECUTION_STORE_REQUIRED")
    if runtime.store is None or info.thread_id is None:
        return
    try:
        if operation:
            key = operation["requestId"]
            previous = await runtime.store.aget(namespace(info.thread_id, "requests"), key, refresh_ttl=False)
            if previous and previous.value.get("fingerprint") != operation["fingerprint"]:
                raise DocumentProcessingError(409, "Request content changed", "REQUEST_CONFLICT")
            if previous and previous.value.get("runId") != info.run_id:
                raise DocumentProcessingError(409, "Control request already executed", "CONTROL_ALREADY_EXECUTED")
            if not previous:
                admission = await runtime.store.aget(namespace(info.thread_id, "control"), "admission", refresh_ttl=False)
                generation = admission.value["generation"] if admission else 0
                if admission and admission.value.get("runId") == info.run_id:
                    generation -= 1  # Another parallel node admitted this same run.
                if generation != operation.get("generation", 0):
                    raise DocumentProcessingError(409, "Task changed since control was requested", "STALE_CHECKPOINT")
                await store_put(runtime, "control", "admission", {"generation": generation + 1, "runId": info.run_id})
                await store_put(runtime, "requests", key, {"runId": info.run_id, "fingerprint": operation["fingerprint"]})
        paused = await runtime.store.aget(namespace(info.thread_id, "pause"), str(info.run_id), refresh_ttl=False)
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(503, "Execution store is unavailable", "EXECUTION_STORE_UNAVAILABLE") from exc
    if paused and check_pause:
        answer = interrupt({"kind": "pause", "runId": info.run_id})
        if not isinstance(answer, dict) or answer.get("action") != "resume":
            raise DocumentProcessingError(422, "A paused task requires resume", "INVALID_CONTROL")


def merge_records(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Replace a unit/call once; late results cannot overwrite a newer retry round."""
    records = {_record_key(item): item for item in left}
    for item in right:
        key = _record_key(item)
        if key not in records or item.get("round", 0) >= records[key].get("round", 0):
            records[key] = item
    return list(records.values())


def _record_key(item: dict[str, Any]) -> tuple[Any, ...]:
    if "callKey" in item:
        return (str(item["callKey"]),)
    return (item.get("stage", item.get("kind", "chunk")), item["index"])
