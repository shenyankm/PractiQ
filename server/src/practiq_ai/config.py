"""Validated deployment settings; this is the only module that reads the environment."""

import ipaddress
import os
from dataclasses import dataclass
from math import isfinite
from pathlib import Path
from urllib.parse import urlsplit

MIB = 1024 * 1024
SERVER_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Config:
    provider: str
    api_key: str
    model_id: str
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
    base_url: str | None = None
    desktop_mode: bool = False
    jobs_per_worker: int = 8
    task_max_model_calls: int = 400
    run_timeout_seconds: float = 1800
    model_max_input_chars: int = 64_000
    deployment_workers: int = 1
    provider_concurrency: int = 16
    provider_rpm: int = 120
    upload_concurrency: int = 4
    upload_timeout_seconds: float = 120
    max_busy_threads: int = 300
    maintenance: bool = False
    structured_output_method: str = "function_calling"


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
    if not isfinite(value) or value <= 0:
        raise ValueError(f"{key} must be a positive number")
    return value


def service_token() -> str:
    return _required(dict(os.environ), "AI_SERVICE_TOKEN")


def is_loopback_host(hostname: str | None) -> bool:
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname or "").is_loopback
    except ValueError:
        return False


def load() -> Config:
    values = dict(os.environ)
    _required(values, "AI_SERVICE_TOKEN")
    provider = _required(values, "LLM_PROVIDER")
    if provider not in {"dashscope", "deepseek", "moonshot", "openai"}:
        raise ValueError(f"Unsupported LLM_PROVIDER: {provider}")
    storage_dir = values.get("AI_STORAGE_DIR", ".local/ai-oss").strip()
    if not storage_dir:
        raise ValueError("AI_STORAGE_DIR must not be empty")
    if values.get("AI_STORAGE_BACKEND", "local").strip() != "local":
        raise ValueError("AI_STORAGE_BACKEND no longer supports remote storage; migrate files to AI_STORAGE_DIR before using local storage")
    method = values.get("AI_STRUCTURED_OUTPUT_METHOD", "function_calling")
    if method not in {"auto", "json_schema", "function_calling"}:
        raise ValueError("AI_STRUCTURED_OUTPUT_METHOD must be auto, json_schema or function_calling")
    model_id = _required(values, "LLM_MODEL")
    jobs_per_worker = _positive_int(values, "N_JOBS_PER_WORKER", 8)
    graph_max_concurrency = _positive_int(values, "AI_GRAPH_MAX_CONCURRENCY", 2)
    if jobs_per_worker * graph_max_concurrency > 16:
        raise ValueError(
            "N_JOBS_PER_WORKER * AI_GRAPH_MAX_CONCURRENCY must not exceed 16"
        )
    workers = _positive_int(values, "AI_DEPLOYMENT_WORKERS", 1)
    if workers != 1:
        raise ValueError("AI_DEPLOYMENT_WORKERS must be 1; use one Uvicorn process")
    provider_concurrency = _positive_int(values, "AI_PROVIDER_CONCURRENCY", 16)
    provider_rpm = _positive_int(values, "AI_PROVIDER_RPM", 120)
    maintenance = values.get("AI_MAINTENANCE_MODE", "false").lower().strip()
    if maintenance not in {"true", "false"}:
        raise ValueError("AI_MAINTENANCE_MODE must be true or false")
    if jobs_per_worker * graph_max_concurrency > provider_concurrency:
        raise ValueError("Total deployment model concurrency exceeds AI_PROVIDER_CONCURRENCY")
    base_url = values.get("LLM_BASE_URL", "").strip() or None
    if provider == "openai" and not base_url:
        raise ValueError("LLM_BASE_URL is required for openai")
    if base_url:
        url = urlsplit(base_url)
        loopback = is_loopback_host(url.hostname)
        if (url.scheme != "https" and not (url.scheme == "http" and loopback)) or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("LLM_BASE_URL requires HTTPS or loopback HTTP without credentials, query or fragment")
    return Config(
        base_url=base_url,
        desktop_mode=values.get("AI_DESKTOP_MODE") == "1",
        jobs_per_worker=jobs_per_worker,
        maintenance=maintenance == "true",
        task_max_model_calls=_positive_int(values, "AI_TASK_MAX_MODEL_CALLS", 400),
        run_timeout_seconds=_positive_float(values, "AI_RUN_TIMEOUT_SECONDS", 1800),
        model_max_input_chars=_positive_int(values, "AI_MODEL_MAX_INPUT_CHARS", 64_000),
        deployment_workers=workers,
        provider_concurrency=provider_concurrency,
        provider_rpm=provider_rpm,
        upload_concurrency=_positive_int(values, "AI_UPLOAD_CONCURRENCY", 4),
        upload_timeout_seconds=_positive_float(values, "AI_UPLOAD_TIMEOUT_SECONDS", 120),
        max_busy_threads=_positive_int(values, "AI_MAX_BUSY_THREADS", 300),
        structured_output_method=method,
        provider=provider,
        api_key=_required(values, "LLM_API_KEY"),
        model_id=model_id,
        storage_dir=storage_path(storage_dir),
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


def storage_path(value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return Path(os.path.abspath(path))
    if not (SERVER_ROOT / "pyproject.toml").is_file() or not (SERVER_ROOT / "src/practiq_ai").is_dir():
        raise ValueError("Wheel installations require an absolute AI_STORAGE_DIR")
    legacy = SERVER_ROOT.parent / path
    if legacy.is_dir() and any(legacy.iterdir()):
        raise ValueError("Existing storage at the old repository-relative path; set an absolute AI_STORAGE_DIR to keep it or migrate explicitly")
    return Path(os.path.abspath(SERVER_ROOT / path))


def database_dir() -> Path:
    """Dedicated local SQLite directory; never silently reuse a PostgreSQL deployment."""
    if os.environ.get("DATABASE_URI", "").strip():
        raise ValueError("DATABASE_URI is no longer supported; set AI_DATABASE_DIR for a new SQLite database. Existing PostgreSQL data is untouched")
    value = os.environ.get("AI_DATABASE_DIR", ".local/database").strip()
    if not value:
        raise ValueError("AI_DATABASE_DIR must not be empty")
    return storage_path(value)
