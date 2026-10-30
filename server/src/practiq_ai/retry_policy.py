"""Pure unit retry eligibility shared by API admission and graph execution."""

from collections.abc import Mapping
from typing import Any

from .contracts import RetryUnits
from .errors import DocumentProcessingError

MAX_UNIT_RETRIES = 2
RETRYABLE_CODES = {"OUTPUT_INVALID", "OUTPUT_STALLED", "AI_PROVIDER_UNAVAILABLE", "AI_PROVIDER_AUTH_ERROR"}


def unit_failures(state: Mapping[str, Any]) -> list[dict[str, Any]]:
    failures = [{k: v for k, v in item.items() if k != "round"} for item in state.get("failures", [])]
    failures.extend({"stage": "document_parse", "index": item["index"],
                     "code": item.get("failureCode") or "OUTPUT_INVALID", "retryable": True}
                    for item in state.get("chunkResults", []) if item.get("parsed") is None)
    failures.extend(item for item in state.get("processing", {}).get("failures", []) if item["stage"] == "visual_crop")
    result = []
    for item in failures:
        key = f"{item['stage']}:{item['index']}"
        remaining = max(0, MAX_UNIT_RETRIES - state.get("retryCounts", {}).get(key, 0)) if item["code"] in RETRYABLE_CODES else 0
        result.append({**item, "retryable": remaining > 0, "retriesRemaining": remaining})
    return result


def selected_retry_units(state: Mapping[str, Any], request: RetryUnits) -> set[tuple[str, int]]:
    if str(request.requestId) in state.get("appliedRetries", []):
        raise DocumentProcessingError(409, "Retry already applied", "CONTROL_ALREADY_EXECUTED")
    failures = unit_failures(state)
    exhausted = {(item["stage"], item["index"]) for item in failures if item["code"] in RETRYABLE_CODES and not item["retriesRemaining"]}
    if any((item.stage, item.index) in exhausted for item in request.units):
        raise DocumentProcessingError(409, "Failed unit retry limit exceeded", "RETRY_LIMIT_EXCEEDED")
    eligible = {(item["stage"], item["index"]) for item in failures if item["retryable"]}
    selected = {(item.stage, item.index) for item in request.units} if request.units else eligible
    if not selected or not selected <= eligible:
        raise DocumentProcessingError(409, "Select existing retryable failures", "INVALID_RETRY_UNITS")
    return selected
