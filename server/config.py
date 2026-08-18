"""Environment configuration."""

import os
from dataclasses import dataclass

DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 10 * 60
DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600
DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS = 90 * 24 * 3600
DEFAULT_AI_AGENT_TIMEOUT_SECONDS = 300


def _get(values: dict[str, str], key: str, fallback: str) -> str:
    value = values.get(key, '').strip()
    return value if value else fallback


def _int_from_env(raw: str, fallback: int) -> int:
    raw = raw.strip()
    if not raw:
        return fallback
    try:
        value = int(raw)
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def _ttl_seconds(name: str, default: int) -> int:
    raw = os.environ.get(name, '').strip()
    if not raw:
        return default
    try:
        milliseconds = int(raw)
    except ValueError as exc:
        raise ValueError(
            f'{name} must be a positive integer within the supported duration range'
        ) from exc
    if milliseconds <= 0 or milliseconds > (2**63 - 1) // 1_000_000:
        raise ValueError(
            f'{name} must be a positive integer within the supported duration range'
        )
    return milliseconds // 1000 or 1


def access_token_ttl_seconds() -> int:
    return _ttl_seconds('ACCESS_TOKEN_TTL_MS', DEFAULT_ACCESS_TOKEN_TTL_SECONDS)


def refresh_token_ttl_seconds() -> int:
    return _ttl_seconds('REFRESH_TOKEN_TTL_MS', DEFAULT_REFRESH_TOKEN_TTL_SECONDS)


def session_absolute_ttl_seconds() -> int:
    return _ttl_seconds('SESSION_ABSOLUTE_TTL_MS', DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS)


@dataclass(frozen=True)
class Config:
    node_env: str
    host: str
    port: int
    app_origin: str
    revenuecat_project_id: str
    revenuecat_secret_api_key: str
    revenuecat_pro_entitlement_id: str
    revenuecat_organization_entitlement_id: str
    revenuecat_webhook_authorization: str
    llm_key_encryption_secret: str


def load() -> Config:
    values = dict(os.environ)
    port = 8080
    raw_port = values.get('PORT', '').strip()
    if raw_port:
        try:
            port = int(raw_port)
        except ValueError as exc:
            raise ValueError('PORT must be a positive integer') from exc
        if port <= 0:
            raise ValueError('PORT must be a positive integer')
    if not values.get('AUTH_SECRET', '').strip():
        raise ValueError('AUTH_SECRET is required')
    required = (
        'REVENUECAT_PROJECT_ID',
        'REVENUECAT_SECRET_API_KEY',
        'REVENUECAT_PRO_ENTITLEMENT_ID',
        'REVENUECAT_WEBHOOK_AUTHORIZATION',
        'LLM_KEY_ENCRYPTION_SECRET',
    )
    missing = next((key for key in required if not values.get(key, '').strip()), None)
    if missing:
        raise ValueError(f'{missing} is required')
    access_token_ttl_seconds()
    refresh_token_ttl_seconds()
    session_absolute_ttl_seconds()
    host = _get(values, 'PRACTIQ_HOST', '127.0.0.1')
    app_origin = values.get('APP_ORIGIN', '').strip() or f'http://{host}:{port}'
    return Config(
        node_env=_get(values, 'NODE_ENV', 'development'),
        host=host,
        port=port,
        app_origin=app_origin,
        revenuecat_project_id=values['REVENUECAT_PROJECT_ID'].strip(),
        revenuecat_secret_api_key=values['REVENUECAT_SECRET_API_KEY'].strip(),
        revenuecat_pro_entitlement_id=values['REVENUECAT_PRO_ENTITLEMENT_ID'].strip(),
        revenuecat_organization_entitlement_id=(
            values.get('REVENUECAT_ORGANIZATION_ENTITLEMENT_ID', '').strip() or 'organization'
        ),
        revenuecat_webhook_authorization=values['REVENUECAT_WEBHOOK_AUTHORIZATION'].strip(),
        llm_key_encryption_secret=values['LLM_KEY_ENCRYPTION_SECRET'].strip(),
    )


@dataclass(frozen=True)
class DBConfig:
    database_url: str
    max_conns: int
    idle_timeout_seconds: int
    connect_timeout_seconds: int


def load_db_config() -> DBConfig:
    database_url = os.environ.get('POSTGRES_URL', '').strip()
    if not database_url:
        raise ValueError('POSTGRES_URL is required')
    return DBConfig(
        database_url=database_url,
        max_conns=_int_from_env(os.environ.get('POSTGRES_POOL_MAX', ''), 8),
        idle_timeout_seconds=_int_from_env(os.environ.get('POSTGRES_IDLE_TIMEOUT_SECONDS', ''), 30),
        connect_timeout_seconds=_int_from_env(os.environ.get('POSTGRES_CONNECT_TIMEOUT_SECONDS', ''), 10),
    )
