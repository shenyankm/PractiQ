"""Validated deployment settings; this is the only module that reads the environment."""

import os
from dataclasses import dataclass
from pathlib import Path

MIB = 1024 * 1024


@dataclass(frozen=True)
class Config:
    provider: str
    api_key: str
    text_model: str
    vision_model: str | None
    storage_dir: Path
    source_max_bytes: int
    vision_max_bytes: int
    max_document_pages: int
    max_vision_page_pixels: int
    max_total_input_chars: int
    graph_max_concurrency: int
    storage_concurrency: int
    storage_timeout_seconds: float
    model_timeout_seconds: float
    model_max_tokens: int


def _required(values: dict[str, str], key: str) -> str:
    value = values.get(key, "").strip()
    if not value:
        raise ValueError(f"{key} is required")
    return value


def _positive_int(values: dict[str, str], key: str, default: int) -> int:
    raw = values.get(key, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be a positive integer") from exc
    if value <= 0:
        raise ValueError(f"{key} must be a positive integer")
    return value


def _positive_float(values: dict[str, str], key: str, default: float) -> float:
    raw = values.get(key, str(default)).strip()
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be a positive number") from exc
    if value <= 0:
        raise ValueError(f"{key} must be a positive number")
    return value


def service_token() -> str:
    return _required(dict(os.environ), "AI_SERVICE_TOKEN")


def load() -> Config:
    values = dict(os.environ)
    _required(values, "AI_SERVICE_TOKEN")
    provider = _required(values, "LLM_PROVIDER")
    if provider not in {"dashscope", "deepseek", "moonshot"}:
        raise ValueError(f"Unsupported LLM_PROVIDER: {provider}")
    storage_dir = values.get("AI_STORAGE_DIR", ".local/ai").strip()
    if not storage_dir:
        raise ValueError("AI_STORAGE_DIR must not be empty")
    vision_model = values.get("LLM_VISION_MODEL", "").strip() or None
    _required(values, "N_JOBS_PER_WORKER")
    jobs_per_worker = _positive_int(values, "N_JOBS_PER_WORKER", 8)
    graph_max_concurrency = _positive_int(values, "AI_GRAPH_MAX_CONCURRENCY", 2)
    if jobs_per_worker * graph_max_concurrency > 16:
        raise ValueError(
            "N_JOBS_PER_WORKER * AI_GRAPH_MAX_CONCURRENCY must not exceed 16"
        )
    return Config(
        provider=provider,
        api_key=_required(values, "LLM_API_KEY"),
        text_model=_required(values, "LLM_TEXT_MODEL"),
        vision_model=vision_model,
        storage_dir=(Path(__file__).resolve().parents[3] / storage_dir).resolve(),
        source_max_bytes=_positive_int(values, "AI_SOURCE_MAX_BYTES", 25 * MIB),
        vision_max_bytes=_positive_int(values, "AI_MAX_VISION_BYTES", 50 * MIB),
        max_document_pages=_positive_int(values, "AI_MAX_DOCUMENT_PAGES", 100),
        max_vision_page_pixels=_positive_int(
            values, "AI_MAX_VISION_PAGE_PIXELS", 25_000_000
        ),
        max_total_input_chars=_positive_int(
            values, "AI_MAX_TOTAL_INPUT_CHARS", 2_000_000
        ),
        graph_max_concurrency=graph_max_concurrency,
        storage_concurrency=_positive_int(values, "AI_STORAGE_CONCURRENCY", 4),
        storage_timeout_seconds=_positive_float(values, "AI_STORAGE_TIMEOUT_SECONDS", 30),
        model_timeout_seconds=_positive_float(values, "AI_AGENT_TIMEOUT_SECONDS", 180),
        model_max_tokens=_positive_int(values, "AI_AGENT_MAX_TOKENS", 16_384),
    )
