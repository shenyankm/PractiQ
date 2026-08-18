"""Short-lived HS256 access tokens and browser cookie helpers."""

import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from .. import config

SESSION_COOKIE_NAME = 'session'
REFRESH_COOKIE_NAME = 'refresh_token'
ACCESS_TOKEN_ISSUER = 'practiq-api'
ACCESS_TOKEN_AUDIENCE = 'practiq-mobile'


@dataclass
class SessionPayload:
    user_id: int
    expires: str  # RFC3339
    session_id: str
    jti: str = ''


def _session_secret() -> str:
    secret = os.environ.get('AUTH_SECRET', '').strip()
    if not secret:
        raise ValueError('AUTH_SECRET environment variable is required')
    return secret


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def _b64url_decode(value: str) -> bytes:
    padding = '=' * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _format_rfc3339(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _parse_rfc3339(raw: str) -> datetime:
    return datetime.fromisoformat(raw.replace('Z', '+00:00'))


def sign_session_token(payload: SessionPayload) -> str:
    secret = _session_secret()
    if payload.user_id <= 0:
        raise ValueError('session user id must be positive')
    if not payload.expires:
        ttl = config.access_token_ttl_seconds()
        payload.expires = _format_rfc3339(datetime.fromtimestamp(time.time() + ttl, timezone.utc))
    if not payload.session_id:
        raise ValueError('session id is required')
    expires_at = _parse_rfc3339(payload.expires)

    header = {'alg': 'HS256', 'typ': 'JWT'}
    claims: dict = {
        'iss': ACCESS_TOKEN_ISSUER,
        'aud': ACCESS_TOKEN_AUDIENCE,
        'sub': str(payload.user_id),
        'sid': payload.session_id,
        'typ': 'at+jwt',
        'iat': int(time.time()),
        'exp': int(expires_at.timestamp()),
    }
    if payload.jti:
        claims['jti'] = payload.jti
    signing_input = (
        _b64url_encode(json.dumps(header, separators=(',', ':')).encode())
        + '.'
        + _b64url_encode(json.dumps(claims, separators=(',', ':')).encode())
    )
    signature = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return signing_input + '.' + _b64url_encode(signature)


def verify_session_token(token: str) -> SessionPayload:
    secret = _session_secret()
    parts = token.split('.')
    if len(parts) != 3:
        raise ValueError('invalid session token')
    try:
        header = json.loads(_b64url_decode(parts[0]))
    except Exception as exc:
        raise ValueError('invalid session token') from exc
    if header.get('alg') != 'HS256':
        raise ValueError('invalid session token algorithm')
    signing_input = parts[0] + '.' + parts[1]
    want = _b64url_encode(hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(parts[2], want):
        raise ValueError('invalid session token signature')
    try:
        raw = json.loads(_b64url_decode(parts[1]))
    except Exception as exc:
        raise ValueError('invalid session token') from exc

    if raw.get('iss') != ACCESS_TOKEN_ISSUER or raw.get('aud') != ACCESS_TOKEN_AUDIENCE:
        raise ValueError('invalid session token claims')
    user_id = raw.get('sub')
    if not isinstance(user_id, str) or not user_id.isdigit() or int(user_id) <= 0:
        raise ValueError('session user id must be a positive integer')
    session_id = raw.get('sid')
    if not isinstance(session_id, str) or not session_id:
        raise ValueError('session id is required')
    jti = raw.get('jti', '')
    if not isinstance(jti, str):
        raise ValueError('session jti must be a string')

    now = datetime.now(timezone.utc)
    exp = raw.get('exp')
    if not isinstance(exp, (int, float)) or datetime.fromtimestamp(exp, timezone.utc) <= now:
        raise ValueError('session token expired')
    expires = _format_rfc3339(datetime.fromtimestamp(exp, timezone.utc))
    return SessionPayload(user_id=int(user_id), expires=expires, session_id=session_id, jti=jti)


def session_cookie_params(token: str, expires: datetime) -> dict:
    return {
        'key': SESSION_COOKIE_NAME,
        'value': token,
        'path': '/',
        'expires': expires.strftime('%a, %d %b %Y %H:%M:%S GMT'),
        'httponly': True,
        'samesite': 'lax',
        'secure': os.environ.get('NODE_ENV') == 'production',
    }


def refresh_cookie_params(token: str, expires: datetime) -> dict:
    return {
        'key': REFRESH_COOKIE_NAME,
        'value': token,
        'path': '/api/v1/auth',
        'expires': expires.strftime('%a, %d %b %Y %H:%M:%S GMT'),
        'httponly': True,
        'samesite': 'lax',
        'secure': os.environ.get('NODE_ENV') == 'production',
    }
