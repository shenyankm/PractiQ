"""Environment configuration loading.

Mirrors backend/internal/config/config.go + backend/internal/db/config.go:
.env.local -> .env -> process environment (process env wins), walking up from
cwd to the directory containing .git.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 3600
DEFAULT_AI_AGENT_TIMEOUT_SECONDS = 300


def _dotenv_paths(name: str) -> list[Path]:
    try:
        directory = Path.cwd()
    except OSError:
        return []
    paths: list[Path] = []
    while True:
        paths.append(directory / name)
        if (directory / '.git').exists():
            return paths
        parent = directory.parent
        if parent == directory:
            return paths
        directory = parent


def _trim_env_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] in ('\'', '"') and value[-1] == value[0]:
        return value[1:-1]
    return value


def _load_dotenv(values: dict[str, str], path: Path) -> None:
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip()
        if not key or key in values:
            continue
        values[key] = _trim_env_value(value)


def load_env() -> dict[str, str]:
    """Load dotenv files, overlay process env, and backfill os.environ."""
    values: dict[str, str] = {}
    for path in _dotenv_paths('.env.local'):
        _load_dotenv(values, path)
    for path in _dotenv_paths('.env'):
        _load_dotenv(values, path)
    dotenv_values = dict(values)
    values.update(os.environ)
    for key, value in dotenv_values.items():
        if key not in os.environ:
            os.environ[key] = value
    return values


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


def session_ttl_seconds() -> int:
    raw = os.environ.get('SESSION_TTL_MS', '').strip()
    if not raw:
        return DEFAULT_SESSION_TTL_SECONDS
    try:
        milliseconds = int(raw)
    except ValueError as exc:
        raise ValueError(
            'SESSION_TTL_MS must be a positive integer within the supported duration range'
        ) from exc
    if milliseconds <= 0 or milliseconds > (2**63 - 1) // 1_000_000:
        raise ValueError(
            'SESSION_TTL_MS must be a positive integer within the supported duration range'
        )
    return milliseconds // 1000 or 1


@dataclass(frozen=True)
class Config:
    node_env: str
    host: str
    port: int
    app_origin: str
    revenuecat_project_id: str
    revenuecat_secret_api_key: str
    revenuecat_pro_entitlement_id: str
    revenuecat_webhook_authorization: str
    llm_key_encryption_secret: str


def load() -> Config:
    values = load_env()
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
    session_ttl_seconds()  # validate eagerly, mirroring config.Load
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
