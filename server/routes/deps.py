"""Shared route helpers: pool access, current user, strict JSON decoding.

Mirrors backend/internal/httpserver/route_helpers.go.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from fastapi import Request
from psycopg_pool import AsyncConnectionPool

from .. import envelope
from ..auth import runtime as auth_runtime

MAX_JSON_BODY_BYTES = 1024 * 1024


def pool(request: Request) -> AsyncConnectionPool:
    return request.app.state.pool


async def current_user(request: Request) -> auth_runtime.User:
    return await auth_runtime.require_user(request, pool(request))


async def decode_json_body(request: Request, allowed_fields: set[str] | None = None, allow_empty: bool = False) -> dict[str, Any]:
    body = await request.body()
    if len(body) > MAX_JSON_BODY_BYTES:
        raise envelope.request_too_large()
    if not body:
        if allow_empty:
            return {}
        raise envelope.invalid_json()
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise envelope.invalid_json() from exc
    if not isinstance(payload, dict):
        raise envelope.invalid_json()
    if allowed_fields is not None and any(key not in allowed_fields for key in payload):
        raise envelope.invalid_json()
    return payload


def parse_path_id(value: str, name: str) -> int:
    try:
        parsed = int(value.strip())
    except (ValueError, AttributeError) as exc:
        raise envelope.new_error(422, 'VALIDATION_ERROR', f'Invalid {name}') from exc
    if parsed <= 0:
        raise envelope.new_error(422, 'VALIDATION_ERROR', f'Invalid {name}')
    return parsed


def query_page_limit(request: Request, maximum: int) -> int:
    raw = request.query_params.get('limit', '').strip()
    if not raw:
        return 0
    try:
        limit = int(raw)
    except ValueError as exc:
        raise envelope.validation_error(
            [envelope.ValidationDetail('limit', f'must be between 1 and {maximum}')]
        ) from exc
    if limit < 1 or limit > maximum:
        raise envelope.validation_error(
            [envelope.ValidationDetail('limit', f'must be between 1 and {maximum}')]
        )
    return limit


def query_updated_since(request: Request) -> str:
    raw = request.query_params.get('updated_since', '').strip()
    if not raw:
        return ''
    try:
        datetime.fromisoformat(raw.replace('Z', '+00:00'))
    except ValueError as exc:
        raise envelope.validation_error(
            [envelope.ValidationDetail('updated_since', 'must be an ISO 8601 timestamp')]
        ) from exc
    return raw
