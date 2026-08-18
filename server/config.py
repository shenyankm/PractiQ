"""AI service environment configuration."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    node_env: str
    host: str
    port: int
    service_token: str
    provider: str
    api_key: str
    text_model: str
    vision_model: str | None


def _required(values: dict[str, str], key: str) -> str:
    value = values.get(key, '').strip()
    if not value:
        raise ValueError(f'{key} is required')
    return value


def load() -> Config:
    values = dict(os.environ)
    try:
        port = int(values.get('AI_PORT', '8080'))
    except ValueError as exc:
        raise ValueError('AI_PORT must be an integer from 1 through 65535') from exc
    if not 1 <= port <= 65_535:
        raise ValueError('AI_PORT must be an integer from 1 through 65535')
    return Config(
        node_env=values.get('NODE_ENV', 'development').strip() or 'development',
        host=values.get('AI_HOST', '127.0.0.1').strip() or '127.0.0.1',
        port=port,
        service_token=_required(values, 'AI_SERVICE_TOKEN'),
        provider=_required(values, 'LLM_PROVIDER'),
        api_key=_required(values, 'LLM_API_KEY'),
        text_model=_required(values, 'LLM_TEXT_MODEL'),
        vision_model=values.get('LLM_VISION_MODEL', '').strip() or None,
    )
