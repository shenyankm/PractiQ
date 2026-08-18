"""Redis client singleton, key prefixing, JSON helpers, rate-limit Lua script."""

import asyncio
import json
import os
from dataclasses import dataclass
from typing import Any

import redis.asyncio as aioredis

_client_url: str | None = None
_client: aioredis.Redis | None = None


def client() -> aioredis.Redis | None:
    """Lazy singleton keyed off REDIS_URL; None when unset or invalid."""
    global _client, _client_url
    url = os.environ.get('REDIS_URL', '').strip()
    if not url:
        _reset()
        return None
    if _client is not None and _client_url == url:
        return _client
    try:
        new_client = aioredis.from_url(url)
    except Exception:
        _reset()
        return None
    _reset()
    _client = new_client
    _client_url = url
    return _client


def _reset() -> None:
    global _client, _client_url
    if _client is not None:
        try:
            asyncio.get_running_loop().create_task(_client.aclose())
        except RuntimeError:
            asyncio.run(_client.aclose())
    _client = None
    _client_url = None


async def check_redis() -> tuple[bool, Exception | None]:
    if not os.environ.get('REDIS_URL', '').strip():
        return False, ValueError('REDIS_URL is required')
    rdb = client()
    if rdb is None:
        return False, ValueError('REDIS_URL is invalid')
    try:
        await rdb.ping()
        return True, None
    except Exception as exc:
        return True, exc


def redis_key(*parts: Any) -> str:
    prefix = os.environ.get('REDIS_KEY_PREFIX', '').strip() or 'practiq'
    values = [prefix]
    for part in parts:
        if part is None:
            continue
        value = str(part).strip()
        if value:
            values.append(value)
    return ':'.join(values)


async def set_json(rdb: aioredis.Redis, key: str, value: Any, ttl_seconds: float) -> bool:
    try:
        payload = json.dumps(value, separators=(',', ':'), default=str)
    except (TypeError, ValueError):
        return False
    try:
        await rdb.set(key, payload, ex=max(int(ttl_seconds), 1))
        return True
    except Exception:
        return False


async def get_json(rdb: aioredis.Redis, key: str) -> Any | None:
    try:
        raw = await rdb.get(key)
    except Exception:
        return None
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


async def get_text(rdb: aioredis.Redis, key: str) -> str | None:
    try:
        raw = await rdb.get(key)
    except Exception:
        return None
    if raw is None:
        return None
    return raw.decode() if isinstance(raw, bytes) else str(raw)


_INCREMENT_RATE_LIMIT_SCRIPT = """
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
"""


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    count: int
    remaining: int
    reset_seconds: int


async def increment_rate_limit(
    rdb: aioredis.Redis | None, key: str, limit: int, window_seconds: float
) -> RateLimitResult:
    if rdb is None:
        raise ValueError('redis client is required')
    if window_seconds <= 0:
        raise ValueError('rate-limit window must be positive')
    window_ms = int(window_seconds * 1000)
    values = await rdb.eval(_INCREMENT_RATE_LIMIT_SCRIPT, 1, key, window_ms)
    if not isinstance(values, (list, tuple)) or len(values) != 2:
        raise ValueError('unexpected rate-limit script result')
    count, ttl_ms = int(values[0]), int(values[1])
    remaining = max(limit - count, 0)
    reset_seconds = max((ttl_ms + 999) // 1000, 1)
    return RateLimitResult(
        allowed=count <= limit, count=count, remaining=remaining, reset_seconds=reset_seconds
    )
