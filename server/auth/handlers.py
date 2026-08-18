"""Authentication rate limiting and response helpers."""

import hashlib
from email.utils import parseaddr
from typing import Any

from fastapi import Request
from psycopg_pool import AsyncConnectionPool

from .. import envelope, redisx
from . import runtime

AUTH_RATE_LIMIT = 10
AUTH_IP_RATE_LIMIT = 100
AUTH_RATE_LIMIT_WINDOW_SECONDS = 60


def username_validation_detail(username: str) -> envelope.ValidationDetail | None:
    if len(username) < 3 or len(username) > 20:
        return envelope.ValidationDetail('username', 'Must be 3-20 letters, numbers, or underscores')
    for character in username:
        if character != '_' and not (
            '0' <= character <= '9' or 'A' <= character <= 'Z' or 'a' <= character <= 'z'
        ):
            return envelope.ValidationDetail('username', 'Must be 3-20 letters, numbers, or underscores')
    return None


def normalize_email(email: str | None, required: bool) -> tuple[str | None, envelope.ValidationDetail | None]:
    if email is None:
        if required:
            return None, envelope.ValidationDetail('email', 'Must be a valid email address')
        return None, None
    trimmed = email.strip()
    _, addr = parseaddr(trimmed)
    if addr != trimmed or len(trimmed) > 254 or '@' not in trimmed:
        return None, envelope.ValidationDetail('email', 'Must be a valid email address')
    return trimmed, None


def password_validation_detail(field: str, password: str) -> envelope.ValidationDetail | None:
    if len(password.encode()) < 8 or len(password.encode()) > 72:
        return envelope.ValidationDetail(field, 'Must be 8-72 bytes')
    return None


def _client_address(request: Request) -> str:
    if request.client and request.client.host:
        return request.client.host
    return 'unknown'


def _auth_rate_limit_unavailable() -> envelope.APIError:
    return envelope.new_error(
        503, 'AUTH_RATE_LIMIT_UNAVAILABLE', 'Authentication service is temporarily unavailable'
    )


async def rate_limit_auth(request: Request, identity: str) -> None:
    rdb = redisx.client()
    if rdb is None:
        raise _auth_rate_limit_unavailable()
    address = _client_address(request)
    normalized_identity = identity.strip().lower()
    ip_limit = AUTH_IP_RATE_LIMIT if normalized_identity else AUTH_RATE_LIMIT
    try:
        result = await redisx.increment_rate_limit(
            rdb,
            redisx.redis_key('rate-limit', 'auth', request.url.path, 'ip', address),
            ip_limit,
            AUTH_RATE_LIMIT_WINDOW_SECONDS,
        )
    except Exception as exc:
        raise _auth_rate_limit_unavailable() from exc
    if not result.allowed:
        raise envelope.new_error(429, 'RATE_LIMITED', 'Too many authentication attempts')
    if normalized_identity:
        digest = hashlib.sha256(normalized_identity.encode()).hexdigest()
        try:
            result = await redisx.increment_rate_limit(
                rdb,
                redisx.redis_key('rate-limit', 'auth', request.url.path, 'identity', digest),
                AUTH_RATE_LIMIT,
                AUTH_RATE_LIMIT_WINDOW_SECONDS,
            )
        except Exception as exc:
            raise _auth_rate_limit_unavailable() from exc
        if not result.allowed:
            raise envelope.new_error(429, 'RATE_LIMITED', 'Too many authentication attempts')


async def require_user(request: Request, pool: AsyncConnectionPool) -> runtime.User:
    user = await runtime.current_user_from_request(request, pool)
    if user is None:
        raise envelope.new_error(401, 'UNAUTHENTICATED', 'Authentication required')
    if not user.is_active:
        raise envelope.new_error(403, 'USER_INACTIVE', 'User account is disabled')
    return user


def session_tokens_response(tokens: runtime.SessionTokens) -> dict[str, Any]:
    return {
        'accessToken': tokens.access_token,
        'refreshToken': tokens.refresh_token,
        'expiresAt': tokens.access_expires_at.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'refreshExpiresAt': tokens.refresh_expires_at.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'tokenType': 'Bearer',
    }


def issued_session_response(user: runtime.User, tokens: runtime.SessionTokens) -> dict[str, Any]:
    response = user.as_dict()
    response['tokens'] = session_tokens_response(tokens)
    return response
