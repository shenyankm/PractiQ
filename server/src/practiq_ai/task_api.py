"""Thin document-task controls over public Agent Server APIs (no private DB access)."""

import asyncio
from datetime import datetime, timedelta
from typing import Any, cast
from uuid import NAMESPACE_URL, uuid5

import httpx
from langgraph_sdk import get_client

from .config import load
from .contracts import (
    ArtifactReference,
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
    RetryUnits,
)
from .errors import DocumentProcessingError
from .execution import (
    RECURSION_LIMIT,
    TTL_MINUTES,
    fingerprint,
    namespace,
    remaining_ttl,
    validate_execution,
)
from .graphs.document import _retry_update, unit_failures
from .storage import get_object_store


def client() -> Any:
    # This SDK's in-process transport bypasses HTTP authentication. Only call it
    # from already authenticated routes; never accept a caller-provided URL.
    return get_client(url=None, api_key=None)


def conflict(message: str, code: str = "INVALID_CONTROL") -> DocumentProcessingError:
    return DocumentProcessingError(409, message, code)


async def _item(api: Any, thread_id: str, kind: str, key: str) -> dict[str, Any] | None:
    try:
        item = await api.store.get_item(namespace(thread_id, kind), key, refresh_ttl=False)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return None
        raise
    return item["value"] if item else None


async def _find_run(api: Any, thread_id: str, request_id: str) -> dict[str, Any] | None:
    offset = 0
    while True:
        runs = await api.runs.list(thread_id, limit=100, offset=offset)
        for run in runs:
            if run.get("metadata", {}).get("documentRequestId") == request_id:
                return run
        if len(runs) < 100:
            return None
        offset += len(runs)


def _receipt(thread_id: str, request_id: str, run: dict[str, Any] | None) -> dict[str, Any]:
    return {"threadId": thread_id, "requestId": request_id,
            "runId": run["run_id"] if run else None, "accepted": True}


async def _start_run(api: Any, thread_id: str, graph_id: str, request_id: str,
                     request_hash: str, *, graph_input: Any = None, command: Any = None,
                     expires_at: str | None = None, generation: int = 0) -> dict[str, Any]:
    previous = await _find_run(api, thread_id, request_id)
    if previous:
        return _receipt(thread_id, request_id, previous)
    operation = {"requestId": request_id, "fingerprint": request_hash,
                 "generation": generation,
                 "expiresAt": expires_at}
    try:
        run = await api.runs.create(
            thread_id, graph_id, input=graph_input, command=command,
            durability="sync", multitask_strategy="reject",
            config={"recursion_limit": RECURSION_LIMIT, "max_concurrency": 2 * load().graph_max_concurrency},
            context={"documentControl": operation},
            metadata={"documentRequestId": request_id},
        )
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code != 409:
            raise
        run = await _find_run(api, thread_id, request_id)
        if not run:
            raise conflict("Another run is active", "TASK_BUSY") from exc
    return _receipt(thread_id, request_id, run)


async def create_task(request: DocumentTaskCreate) -> dict[str, Any]:
    api = client()
    request_id = str(request.requestId)
    thread_id = str(uuid5(NAMESPACE_URL, f"practiq/document/{request_id}"))
    request_hash = fingerprint(request.model_dump(mode="json"))
    if request.parentThreadId:
        await api.threads.get(str(request.parentThreadId))
    thread = await api.threads.create(
        thread_id=thread_id, if_exists="do_nothing", ttl={"strategy": "delete", "ttl": TTL_MINUTES},
        metadata={"kind": "document_task", "requestFingerprint": request_hash,
                  "graphId": request.graphId, "parentThreadId": str(request.parentThreadId) if request.parentThreadId else None},
    )
    if thread.get("metadata", {}).get("requestFingerprint") != request_hash:
        raise conflict("requestId was already used for different input", "REQUEST_CONFLICT")
    created_at = datetime.fromisoformat(thread["created_at"])
    expires_at = (created_at + timedelta(minutes=TTL_MINUTES)).isoformat()
    remaining_ttl({"expiresAt": expires_at})
    return await _start_run(api, thread_id, request.graphId, request_id, request_hash,
                            graph_input=request.model_dump(mode="json", include={"document", "failurePolicy"}),
                            expires_at=expires_at)


def _interrupts(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    found = {item["id"]: item["value"] for item in snapshot.get("interrupts", [])}
    for task in snapshot.get("tasks", []):
        found.update({item["id"]: item["value"] for item in task.get("interrupts", [])})
        if isinstance(task.get("state"), dict):
            found.update(_interrupts(task["state"]))
    return found


async def _read_task(api: Any, thread_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    thread = await api.threads.get(thread_id)
    if thread.get("metadata", {}).get("kind") != "document_task":
        raise conflict("Controls require a versioned document task", "EXECUTION_VERSION_MISMATCH")
    snapshot = await api.threads.get_state(thread_id, subgraphs=True)
    runs = await api.runs.list(thread_id, limit=1)
    return thread, snapshot, runs[0] if runs else None


async def _calls(api: Any, thread_id: str) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    while True:
        page = await api.store.search_items(namespace(thread_id, "calls"), limit=100, offset=len(values), refresh_ttl=False)
        items = page["items"]
        values.extend(item["value"] for item in items)
        if len(items) < 100:
            return values


async def get_task(thread_id: str) -> dict[str, Any]:
    api = client()
    thread, snapshot, run = await _read_task(api, thread_id)
    values = snapshot.get("values") or {}
    interruptions = _interrupts(snapshot)
    failures = unit_failures(values)
    active = bool(run and run["status"] in {"pending", "running"})
    if active:
        assert run is not None
        paused = await _item(api, thread_id, "pause", run["run_id"])
        status = "PAUSING" if paused else "RUNNING"
        actions = ["interrupt"] if paused else ["pause", "interrupt"]
    elif interruptions:
        reviews = [value for value in interruptions.values() if value.get("kind") == "review"]
        status = "WAITING_REVIEW" if reviews else "PAUSED"
        actions = (["retry_failed"] if any(f["retryable"] for f in failures) else []) if reviews else ["resume"]
        if reviews and all(value.get("canAccept") for value in reviews):
            actions.append("accept_partial")
    elif run and run["status"] in {"error", "timeout", "interrupted"}:
        status = "INTERRUPTED" if run["status"] == "interrupted" else "FAILED"
        actions = ["resume"] if snapshot.get("next") else []
        if any(item["retryable"] for item in failures):
            actions.append("retry_failed")
    elif values.get("status") in {"SUCCEEDED", "PARTIAL"}:
        status = "COMPLETED"
        actions = ["retry_failed"] if any(item["retryable"] for item in failures) else []
    else:
        status, actions = "PENDING", []
    calls = await _calls(api, thread_id)
    usage = {item["callKey"]: item for item in values.get("usage", [])}
    usage.update({item["callKey"]: {k: item[k] for k in ("callKey", "modelId", "inputTokens", "outputTokens", "callKind")}
                  for item in calls if item["status"] == "completed"})
    execution = values.get("execution")
    expires_at = execution["expiresAt"] if execution else (datetime.fromisoformat(thread["created_at"]) + timedelta(minutes=TTL_MINUTES)).isoformat()
    return {
        "threadId": thread_id, "runId": run["run_id"] if run else None,
        "state": status, "phase": values.get("phase", "pending"),
        "checkpointId": (snapshot.get("checkpoint") or {}).get("checkpoint_id"),
        "updatedAt": snapshot.get("created_at"), "expiresAt": expires_at,
        "allowedActions": actions, "failures": failures,
        "blocking": list(interruptions.values()) or [task["error"] for task in snapshot.get("tasks", []) if task.get("error")],
        "progress": {
            "visuals": _counts(len(values.get("pageRefs", [])) + len(values.get("embeddedRefs", [])), len(values.get("visionResults", [])), sum(f["stage"].startswith("vision_") for f in failures)),
            "chunks": _counts(len(values.get("chunkRefs", [])), sum(item.get("parsed") is not None for item in values.get("chunkResults", [])), sum(f["stage"] == "document_parse" for f in failures)),
        },
        "status": values.get("status") or None, "result": values.get("result") or None,
        "processing": values.get("processing") or None, "usage": list(usage.values()),
        "unknownUsageCalls": [item["callKey"] for item in calls if item["status"] != "completed"],
    }


def _counts(total: int, succeeded: int, failed: int) -> dict[str, int]:
    return {"total": total, "succeeded": succeeded, "failed": failed, "remaining": max(0, total - succeeded - failed)}


async def _preflight(values: dict[str, Any]) -> None:
    await asyncio.to_thread(validate_execution, values.get("execution"))
    store = await asyncio.to_thread(get_object_store)
    # Check the source and pending inputs, including outputs needed by assemble/merge.
    await store.get_verified(DocumentReference.model_validate(values["document"]))
    references = [item for key in ("pageRefs", "embeddedRefs", "chunkRefs") for item in values.get(key, [])]
    if values.get("textRef"):
        references.append(values["textRef"])
    seen: set[str] = set()
    for reference in references:
        if reference["objectKey"] not in seen:
            seen.add(reference["objectKey"])
            await store.get_verified(ArtifactReference.model_validate(reference))


async def control_task(thread_id: str, request: DocumentTaskControl) -> dict[str, Any]:
    api = client()
    admission = await _item(api, thread_id, "control", "admission")
    generation = admission["generation"] if admission else 0
    thread, snapshot, run = await _read_task(api, thread_id)
    request_id = str(request.requestId)
    request_hash = fingerprint(request.model_dump(mode="json"))
    # Native thread creation supplies atomic insert-if-absent for request receipts.
    # Store.put alone is last-writer-wins and cannot reject concurrent ID reuse.
    receipt_id = str(uuid5(NAMESPACE_URL, f"practiq/control/{thread_id}/{request_id}"))
    expires_at = (datetime.fromisoformat(thread["created_at"]) + timedelta(minutes=TTL_MINUTES)).isoformat()
    receipt = await api.threads.create(
        thread_id=receipt_id, if_exists="do_nothing",
        ttl={"strategy": "delete", "ttl": remaining_ttl({"expiresAt": expires_at})},
        metadata={"kind": "document_control_receipt", "requestFingerprint": request_hash, "threadId": thread_id},
    )
    metadata = receipt.get("metadata", {})
    if metadata.get("requestFingerprint") != request_hash:
        raise conflict("requestId was already used for different input", "REQUEST_CONFLICT")
    if metadata.get("response"):
        return metadata["response"]
    previous = await _find_run(api, thread_id, request_id)
    if previous:
        return _receipt(thread_id, request_id, previous)
    if request.action in {"pause", "interrupt"}:
        if not run or run["run_id"] != str(request.runId):
            raise conflict("The target run is no longer current", "STALE_RUN")
        if run["status"] in {"pending", "running"}:
            if request.action == "pause":
                await api.store.put_item(namespace(thread_id, "pause"), run["run_id"],
                                         {"requestId": request_id}, index=False,
                                         ttl=remaining_ttl({"expiresAt": expires_at}))
            else:
                await api.runs.cancel(thread_id, run["run_id"], action="interrupt", wait=True)
        response = _receipt(thread_id, request_id, run)
    else:
        if run and run["status"] in {"pending", "running"}:
            raise conflict("Wait until the current run stops", "TASK_BUSY")
        if (snapshot.get("checkpoint") or {}).get("checkpoint_id") != request.checkpointId:
            raise conflict("Task changed since the checkpoint was read", "STALE_CHECKPOINT")
        values = snapshot.get("values") or {}
        await _preflight(values)
        interruptions = _interrupts(snapshot)
        reviews = [v for v in interruptions.values() if v.get("kind") == "review"]
        if request.action == "resume" and (reviews or not snapshot.get("next")):
            raise conflict("Task requires a review decision or is already complete")
        if request.action == "accept_partial" and (not reviews or not all(v.get("canAccept") for v in reviews)):
            raise conflict("There is no acceptable partial result")
        graph_input = None
        if request.action == "retry_failed":
            retry = RetryUnits(requestId=request.requestId, units=request.units)
            _retry_update(cast(Any, values), retry)  # Validate before starting a run.
            if not reviews:
                if interruptions:
                    raise conflict("Resume the paused task before retrying failed units")
                graph_input = {"document": values["document"], "failurePolicy": values.get("failurePolicy", "return_partial"), "retry": retry.model_dump(mode="json")}
        command = {"resume": {key: request.model_dump(mode="json") for key in interruptions}} if interruptions else None
        response = await _start_run(api, thread_id, thread["metadata"]["graphId"], request_id, request_hash,
                                    graph_input=graph_input, command=command, expires_at=expires_at, generation=generation)
    await api.threads.update(receipt_id, metadata={**metadata, "response": response})
    return response
