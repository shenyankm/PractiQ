"""Auth request validation, rate limiting, and shared handler helpers.

Mirrors backend/internal/auth/handlers.go.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from email.utils import parseaddr
from typing import Any

from fastapi import Request
from psycopg_pool import AsyncConnectionPool

from .. import envelope, redisx
from . import runtime

MAX_AUTH_JSON_BODY_BYTES = 16 * 1024
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


async def decode_auth_request(request: Request) -> dict[str, Any]:
    body = await request.body()
    if len(body) > MAX_AUTH_JSON_BODY_BYTES:
        raise envelope.request_too_large()
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise envelope.invalid_json() from exc
    if not isinstance(payload, dict):
        raise envelope.invalid_json()
    return payload


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


@dataclass
class RegisterBody:
    username: str
    email: str
    password: str
    code: str


def validate_register_request(body: dict[str, Any]) -> RegisterBody:
    allowed = {'username', 'email', 'password', 'code'}
    if any(key not in allowed for key in body):
        raise envelope.invalid_json()
    details: list[envelope.ValidationDetail] = []
    username = body.get('username') if isinstance(body.get('username'), str) else ''
    if detail := username_validation_detail(username):
        details.append(detail)
    email_raw = body.get('email') if isinstance(body.get('email'), str) else None
    email, detail = normalize_email(email_raw, True)
    if detail:
        details.append(detail)
    password = body.get('password') if isinstance(body.get('password'), str) else ''
    if detail := password_validation_detail('password', password):
        details.append(detail)
    if details:
        raise envelope.validation_error(details)
    code = body.get('code') if isinstance(body.get('code'), str) else ''
    return RegisterBody(username=username, email=email or '', password=password, code=code)


def validate_login_request(body: dict[str, Any]) -> tuple[str, str]:
    allowed = {'login', 'password'}
    if any(key not in allowed for key in body):
        raise envelope.invalid_json()
    login = body.get('login') if isinstance(body.get('login'), str) else ''
    password = body.get('password') if isinstance(body.get('password'), str) else ''
    return login, password


@dataclass
class UpdateMeBody:
    username: str | None
    email: str | None
    email_set: bool
    current_password: str | None
    new_password: str | None


def validate_update_me_request(body: dict[str, Any]) -> runtime.UpdateUserInput:
    allowed = {'username', 'email', 'currentPassword', 'newPassword'}
    if any(key not in allowed for key in body):
        raise envelope.invalid_json()
    details: list[envelope.ValidationDetail] = []

    username: str | None = None
    if 'username' in body and body['username'] is not None:
        if not isinstance(body['username'], str):
            raise envelope.invalid_json()
        username = body['username'].strip()
        if detail := username_validation_detail(username):
            details.append(detail)

    email: str | None = None
    email_set = 'email' in body
    if email_set and body['email'] is not None:
        if not isinstance(body['email'], str):
            raise envelope.invalid_json()
        email, detail = normalize_email(body['email'], False)
        if detail:
            details.append(detail)

    new_password = body.get('newPassword') if isinstance(body.get('newPassword'), str) else None
    current_password = (
        body.get('currentPassword') if isinstance(body.get('currentPassword'), str) else None
    )
    if new_password is not None:
        if detail := password_validation_detail('newPassword', new_password):
            details.append(detail)
        if not current_password:
            details.append(
                envelope.ValidationDetail('currentPassword', 'is required to change the password')
            )

    if username is None and not email_set and new_password is None:
        details.append(
            envelope.ValidationDetail('body', 'username, email, or newPassword is required')
        )
    if details:
        raise envelope.validation_error(details)
    return runtime.UpdateUserInput(
        username=username,
        email=email,
        email_set=email_set,
        current_password=current_password,
        new_password=new_password,
    )
