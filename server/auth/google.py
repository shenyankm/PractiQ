"""Google OAuth: browser authorization-code flow + mobile ID-token verification."""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
from fastapi import Request, Response
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from psycopg import errors as pg_errors
from psycopg_pool import AsyncConnectionPool

from .. import envelope, redisx
from . import runtime

GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
GOOGLE_STATE_COOKIE_NAME = 'google_oauth_state'
GOOGLE_OAUTH_TTL_SECONDS = 600

_http_client: httpx.AsyncClient | None = None
_google_request = google_requests.Request()


def _http() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=10.0)
    return _http_client


def _google_client_id() -> str:
    return os.environ.get('GOOGLE_CLIENT_ID', '').strip()


def _google_redirect_url() -> str:
    return os.environ.get('APP_ORIGIN', '').strip().rstrip('/') + '/api/v1/auth/google/callback'


def _google_auth_disabled() -> envelope.APIError:
    return envelope.new_error(404, 'GOOGLE_AUTH_DISABLED', 'Google sign-in is not configured')


def _google_auth_failed() -> envelope.APIError:
    return envelope.new_error(401, 'GOOGLE_AUTH_FAILED', 'Google sign-in failed')


@dataclass(frozen=True)
class GoogleClaims:
    sub: str
    email: str
    email_verified: bool


def set_state_cookie(response: Response, state: str) -> None:
    response.set_cookie(
        key=GOOGLE_STATE_COOKIE_NAME,
        value=state,
        path='/api/v1/auth/google',
        max_age=600,
        httponly=True,
        samesite='lax',
        secure=os.environ.get('NODE_ENV') == 'production',
    )


def _random_token() -> str:
    return secrets.token_urlsafe(32)


def _pkce_challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()


def _oauth_state_key(state: str) -> str:
    return redisx.redis_key('oauth', 'google', hashlib.sha256(state.encode()).hexdigest())


async def google_start_params() -> tuple[str, str]:
    client_id = _google_client_id()
    if not client_id:
        raise _google_auth_disabled()
    state, nonce, code_verifier = _random_token(), _random_token(), _random_token()
    rdb = redisx.client()
    if rdb is None:
        raise envelope.new_error(503, 'OAUTH_STATE_UNAVAILABLE', 'Authentication service is temporarily unavailable')
    try:
        await rdb.set(
            _oauth_state_key(state),
            json.dumps({'nonce': nonce, 'code_verifier': code_verifier}),
            ex=GOOGLE_OAUTH_TTL_SECONDS,
        )
    except Exception as exc:
        raise envelope.new_error(503, 'OAUTH_STATE_UNAVAILABLE', 'Authentication service is temporarily unavailable') from exc
    params = urlencode({
        'client_id': client_id,
        'redirect_uri': _google_redirect_url(),
        'response_type': 'code',
        'scope': 'openid email profile',
        'state': state,
        'nonce': nonce,
        'code_challenge': _pkce_challenge(code_verifier),
        'code_challenge_method': 'S256',
    })
    return f'{GOOGLE_AUTH_URL}?{params}', state


def _expire_state_cookie(response: Response) -> None:
    response.set_cookie(
        key=GOOGLE_STATE_COOKIE_NAME,
        value='',
        path='/api/v1/auth/google',
        max_age=-1,
        httponly=True,
        samesite='lax',
        secure=os.environ.get('NODE_ENV') == 'production',
    )


async def google_callback(request: Request, response: Response, pool: AsyncConnectionPool) -> runtime.User:
    client_id = _google_client_id()
    if not client_id:
        raise _google_auth_disabled()
    _expire_state_cookie(response)
    state_cookie = request.cookies.get(GOOGLE_STATE_COOKIE_NAME, '')
    state = request.query_params.get('state', '')
    if not state_cookie or not state or not hmac.compare_digest(state_cookie, state):
        raise _google_auth_failed()
    code = request.query_params.get('code', '')
    if not code:
        raise _google_auth_failed()
    transaction = await _consume_oauth_transaction(state)
    claims = await _exchange_google_code(client_id, code, transaction['code_verifier'], transaction['nonce'])
    return await find_or_create_google_user(pool, claims)


async def _consume_oauth_transaction(state: str) -> dict[str, str]:
    rdb = redisx.client()
    if rdb is None:
        raise envelope.new_error(503, 'OAUTH_STATE_UNAVAILABLE', 'Authentication service is temporarily unavailable')
    try:
        raw = await rdb.getdel(_oauth_state_key(state))
    except Exception as exc:
        raise envelope.new_error(503, 'OAUTH_STATE_UNAVAILABLE', 'Authentication service is temporarily unavailable') from exc
    if raw is None:
        raise _google_auth_failed()
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise _google_auth_failed() from exc
    nonce, code_verifier = data.get('nonce'), data.get('code_verifier')
    if not isinstance(nonce, str) or not isinstance(code_verifier, str) or not nonce or not code_verifier:
        raise _google_auth_failed()
    return {'nonce': nonce, 'code_verifier': code_verifier}


async def verify_google_id_token(raw_id_token: str, nonce: str | None = None) -> GoogleClaims:
    try:
        info = await asyncio.to_thread(
            google_id_token.verify_oauth2_token, raw_id_token, _google_request
        )
    except ValueError as exc:
        raise _google_auth_failed() from exc
    sub = info.get('sub', '')
    iss = info.get('iss', '')
    if not sub or iss not in ('accounts.google.com', 'https://accounts.google.com'):
        raise _google_auth_failed()
    if not _google_audience_allowed(info.get('aud', '')):
        raise _google_auth_failed()
    if nonce is not None and not hmac.compare_digest(str(info.get('nonce', '')), nonce):
        raise _google_auth_failed()
    return GoogleClaims(
        sub=sub,
        email=info.get('email', ''),
        email_verified=info.get('email_verified') is True or info.get('email_verified') == 'true',
    )


async def _exchange_google_code(
    client_id: str, code: str, code_verifier: str, nonce: str
) -> GoogleClaims:
    form = {
        'code': code,
        'client_id': client_id,
        'client_secret': os.environ.get('GOOGLE_CLIENT_SECRET', ''),
        'redirect_uri': _google_redirect_url(),
        'grant_type': 'authorization_code',
        'code_verifier': code_verifier,
    }
    try:
        token_resp = await _http().post(GOOGLE_TOKEN_URL, data=form)
    except httpx.HTTPError as exc:
        raise _google_auth_failed() from exc
    if token_resp.status_code != 200:
        raise _google_auth_failed()
    try:
        id_token = token_resp.json().get('id_token', '')
    except ValueError as exc:
        raise _google_auth_failed() from exc
    if not id_token:
        raise _google_auth_failed()
    return await verify_google_id_token(id_token, nonce)


def _google_audience_allowed(aud: str) -> bool:
    if not aud:
        return False
    if aud == _google_client_id():
        return True
    for allowed in os.environ.get('GOOGLE_MOBILE_CLIENT_IDS', '').split(','):
        if allowed.strip() and allowed.strip() == aud:
            return True
    return False


def _google_username(email: str) -> str:
    local = email.split('@', 1)[0]
    name = ''.join(c for c in local if c == '_' or c.isascii() and c.isalnum())[:12] or 'user'
    return f"{name}_{runtime.new_uuid().replace('-', '')[:6]}"


async def find_or_create_google_user(pool: AsyncConnectionPool, claims: GoogleClaims) -> runtime.User:
    try:
        return await _find_or_create_google_user_once(pool, claims)
    except pg_errors.UniqueViolation:
        # Retry once: covers a concurrent first login and username-suffix collisions.
        return await _find_or_create_google_user_once(pool, claims)


async def _find_or_create_google_user_once(pool: AsyncConnectionPool, claims: GoogleClaims) -> runtime.User:
    if not claims.sub:
        raise _google_auth_failed()
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT id, username, email, is_active, role, membership, trial_ends_at, revenuecat_app_user_id
            FROM users
            WHERE google_sub = %s
            LIMIT 1
            """,
            (claims.sub,),
        )
        user = runtime._scan_user(await cursor.fetchone())

        if user is None and claims.email and claims.email_verified:
            cursor = await conn.execute(
                """
                SELECT 1 FROM users
                WHERE lower(email) = lower(%s)
                LIMIT 1
                """,
                (claims.email,),
            )
            if await cursor.fetchone() is not None:
                raise envelope.new_error(
                    409, 'ACCOUNT_LINK_REQUIRED',
                    'Sign in with the existing account before linking Google',
                )

        if user is None:
            if not claims.email or not claims.email_verified:
                raise envelope.new_error(
                    403, 'GOOGLE_EMAIL_UNVERIFIED', 'Google account email must be verified'
                )
            cursor = await conn.execute(
                """
                INSERT INTO users (username, email, google_sub, role, membership)
                VALUES (%s, %s, %s, 'user', 'free')
                RETURNING id, username, email, is_active, role, membership, trial_ends_at, revenuecat_app_user_id
                """,
                (_google_username(claims.email), claims.email, claims.sub),
            )
            user = runtime._scan_user(await cursor.fetchone())

    if user is None:
        raise _google_auth_failed()
    if not user.is_active:
        raise envelope.new_error(403, 'USER_INACTIVE', 'User account is disabled')
    await runtime._cache_user(user)
    return user
