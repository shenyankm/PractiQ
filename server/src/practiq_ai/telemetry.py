"""Low-cardinality operational metrics and logs without document content."""

import json
import logging
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


def event(name: str, **fields: Any) -> None:
    # Call sites supply identifiers/counts only, never exceptions or model/source content.
    logger.info(json.dumps({"event": name, **fields}, default=str, separators=(",", ":")))
