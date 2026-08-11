"""Shared service helpers. Mirrors backend/internal/services/helpers.go."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .. import envelope, redisx
from ..auth.runtime import User


def require_admin_role(user: User) -> None:
    if user.role != 'admin':
        raise envelope.new_error(403, 'ADMIN_REQUIRED', 'Administrator privileges required')


def trimmed_or_none(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed if trimmed else None


def ilike_or_none(value: str | None) -> str | None:
    trimmed = (value or '').strip()
    if not trimmed:
        return None
    return f'%{trimmed}%'


async def bump_slice_cache_version(scope: str, *ids: Any) -> None:
    if scope not in ('analytics', 'bank-analytics', 'leaderboard'):
        return
    rdb = redisx.client()
    if rdb is not None:
        try:
            await rdb.incr(redisx.redis_key('cache-version', scope, *ids))
        except Exception:
            pass


def format_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{value.microsecond // 1000:03d}Z'


def format_nullable_timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    return format_timestamp(value)


def json_or_empty_object(value) -> str:
    import json

    if not value:
        return '{}'
    try:
        return json.dumps(value, separators=(',', ':'))
    except (TypeError, ValueError):
        return '{}'
