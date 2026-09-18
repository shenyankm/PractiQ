"""Low-cardinality operational metrics and logs without document content."""

import json
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram

registry = CollectorRegistry()
inflight = Gauge("practiq_provider_inflight", "Provider slots currently occupied", registry=registry)
calls = Counter("practiq_model_calls", "Provider attempts", ["kind", "outcome"], registry=registry)
duration = Histogram("practiq_stage_seconds", "Execution duration", ["stage", "outcome"],
                     buckets=(0.1, 1, 5, 15, 30, 60, 180, 600, 1800), registry=registry)
results = Counter("practiq_document_results", "Merged results", ["status", "review"], registry=registry)
failures = Counter("practiq_failures", "Processing failures", ["code"], registry=registry)
logger = logging.getLogger("practiq.events")
_EVENTS: ContextVar[list[dict[str, Any]] | None] = ContextVar("evaluation_events", default=None)
EVENT_FIELDS = {
    "stage", "outcome", "unitIndex", "unitKey", "callKey", "kind", "schema",
    "threadId", "runId", "durationMs", "errorCode", "attempt", "validation",
    "decision", "sourceType", "status", "reviewRequired", "primaryPage", "contextPages",
}


@contextmanager
def capture_events() -> Iterator[list[dict[str, Any]]]:
    """Collect the same content-free events locally, including concurrent child tasks."""
    events: list[dict[str, Any]] = []
    token = _EVENTS.set(events)
    try:
        yield events
    finally:
        _EVENTS.reset(token)


def event(name: str, **fields: Any) -> None:
    # Explicit fields only; no messages, artifacts, provider IDs or exception bodies.
    value = {"event": name, "timestamp": datetime.now(UTC).isoformat(),
             **{key: item for key, item in fields.items() if key in EVENT_FIELDS}}
    if (events := _EVENTS.get()) is not None:
        events.append(value)
    logger.info(json.dumps(value, default=str, separators=(",", ":")))
