"""Validated deployment settings; this is the only module that reads the environment."""

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

MIB = 1024 * 1024
SERVER_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Config:
    provider: str
    api_key: str
    vision_model: str
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
    structured_output_method: str = "function_calling"
    soffice_path: str = "soffice"
    storage_backend: str = "local"
    oss_region: str = ""
    oss_bucket: str = ""
    oss_endpoint: str | None = None
    oss_use_cname: bool = False
    oss_access_key_id: str = field(default="", repr=False)
    oss_access_key_secret: str = field(default="", repr=False)
    oss_security_token: str | None = field(default=None, repr=False)


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
    storage_backend = values.get("AI_STORAGE_BACKEND", "local").strip()
    if storage_backend not in {"local", "oss"}:
        raise ValueError("AI_STORAGE_BACKEND must be local or oss")
    oss_settings: dict[str, Any] = {}
    if storage_backend == "oss":
        for name in ("REGION", "BUCKET", "ACCESS_KEY_ID", "ACCESS_KEY_SECRET"):
            oss_settings[f"oss_{name.lower()}"] = _required(values, f"AI_OSS_{name}")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", oss_settings["oss_bucket"]):
            raise ValueError("AI_OSS_BUCKET must be a valid OSS bucket name")
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)+", oss_settings["oss_region"]):
            raise ValueError("AI_OSS_REGION must be an OSS region ID")
        endpoint = values.get("AI_OSS_ENDPOINT", "").strip() or None
        if endpoint:
            url = urlsplit(endpoint)
            if (url.scheme != "https" or not url.hostname or url.username or url.password
                    or url.path not in {"", "/"} or url.query or url.fragment):
                raise ValueError("AI_OSS_ENDPOINT must be an HTTPS origin")
        cname = values.get("AI_OSS_USE_CNAME", "false").strip().lower()
        if cname not in {"true", "false"} or (cname == "true" and not endpoint):
            raise ValueError("AI_OSS_USE_CNAME must be true or false; true requires AI_OSS_ENDPOINT")
        oss_settings.update(
            oss_endpoint=endpoint,
            oss_use_cname=cname == "true",
            oss_security_token=values.get("AI_OSS_SECURITY_TOKEN", "").strip() or None,
        )
    method = values.get("AI_STRUCTURED_OUTPUT_METHOD", "function_calling")
    if method not in {"auto", "json_schema", "function_calling"}:
        raise ValueError("AI_STRUCTURED_OUTPUT_METHOD must be auto, json_schema or function_calling")
    vision_model = _required(values, "LLM_VISION_MODEL")
    _required(values, "N_JOBS_PER_WORKER")
    jobs_per_worker = _positive_int(values, "N_JOBS_PER_WORKER", 8)
    graph_max_concurrency = _positive_int(values, "AI_GRAPH_MAX_CONCURRENCY", 2)
    if jobs_per_worker * graph_max_concurrency > 16:
        raise ValueError(
            "N_JOBS_PER_WORKER * AI_GRAPH_MAX_CONCURRENCY must not exceed 16"
        )
    return Config(
        structured_output_method=method,
        storage_backend=storage_backend,
        **oss_settings,
        soffice_path=values.get("AI_SOFFICE_PATH", "").strip() or "soffice",
        provider=provider,
        api_key=_required(values, "LLM_API_KEY"),
        vision_model=vision_model,
        storage_dir=Path(os.path.abspath(SERVER_ROOT / storage_dir)),
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
