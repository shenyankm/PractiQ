"""User CRUD, session issuance/revocation, user cache.

Mirrors backend/internal/auth/runtime.go.
"""

from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

import bcrypt
from fastapi import Request, Response
from psycopg import errors as pg_errors
from psycopg_pool import AsyncConnectionPool

from .. import config, envelope, redisx
from . import session as session_mod

DUMMY_PASSWORD_HASH = '$2b$10$bPkUrUZqKDqmW.xkPE5LBuqH6HB/QoOS4dYH42xQxevBJQMStTE0W'
BCRYPT_COST = 10


@dataclass
class User:
    id: int
    username: str
    email: str | None
    is_active: bool
    role: str
    membership: str
    revenuecat_app_user_id: str = ''

    def as_dict(self) -> dict:
        return {
            'id': self.id,
            'username': self.username,
            'email': self.email,
            'is_active': self.is_active,
            'role': self.role,
            'membership': self.membership,
            'revenuecat_app_user_id': self.revenuecat_app_user_id,
        }


def new_uuid() -> str:
    return str(uuid.uuid4())


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=BCRYPT_COST)).decode()


def compare_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


def _user_conflict_error(exc: Exception) -> Exception:
    if isinstance(exc, pg_errors.UniqueViolation):
        constraint = getattr(exc.diag, 'constraint_name', '') or ''
        if constraint == 'uq_users_username_lower':
            return envelope.new_error(409, 'USERNAME_TAKEN', 'Username is already in use')
        if constraint == 'uq_users_email_lower':
            return envelope.new_error(409, 'EMAIL_TAKEN', 'Email is already in use')
        return envelope.new_error(409, 'USER_CONFLICT', 'User details conflict with an existing account')
    return exc


def _scan_user(row: tuple | None) -> User | None:
    if row is None:
        return None
    return User(
        id=row[0], username=row[1], email=row[2], is_active=row[3], role=row[4],
        membership=row[5], revenuecat_app_user_id=str(row[6]),
    )


async def register_user(
    pool: AsyncConnectionPool, username: str, email: str | None, password: str
) -> User:
    password_hash = hash_password(password)
    try:
        async with pool.connection() as conn:
            cursor = await conn.execute(
                """
                INSERT INTO users (username, email, password_hash, role, membership)
                VALUES (%s, %s, %s, 'user', 'free')
                RETURNING id, username, email, is_active, role, membership, revenuecat_app_user_id
                """,
                (username, email, password_hash),
            )
            user = _scan_user(await cursor.fetchone())
    except Exception as exc:
        raise _user_conflict_error(exc) from exc
    if user is not None:
        await _cache_user(user)
    return user


@dataclass
class UpdateUserInput:
    username: str | None = None
    email: str | None = None
    email_set: bool = False
    current_password: str | None = None
    new_password: str | None = None


async def update_user(pool: AsyncConnectionPool, user_id: int, input: UpdateUserInput) -> User:
    password_hash: str | None = None
    if input.new_password is not None:
        async with pool.connection() as conn:
            cursor = await conn.execute('SELECT password_hash FROM users WHERE id = %s', (user_id,))
            row = await cursor.fetchone()
            if row is None:
                raise envelope.new_error(404, 'NOT_FOUND', 'User not found')
            current_hash = row[0] or ''
        if input.current_password is None or not compare_password(input.current_password, current_hash):
            raise envelope.validation_error(
                [envelope.ValidationDetail('currentPassword', 'is incorrect')]
            )
        password_hash = hash_password(input.new_password)
    try:
        async with pool.connection() as conn:
            cursor = await conn.execute(
                """
                UPDATE users
                SET
                    username = COALESCE(%s, username),
                    email = CASE WHEN %s THEN %s ELSE email END,
                    password_hash = COALESCE(%s, password_hash)
                WHERE id = %s
                RETURNING id, username, email, is_active, role, membership, revenuecat_app_user_id
                """,
                (input.username, input.email_set, input.email, password_hash, user_id),
            )
            user = _scan_user(await cursor.fetchone())
    except Exception as exc:
        raise _user_conflict_error(exc) from exc
    if user is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'User not found')
    await invalidate_user_cache(user_id)
    await _cache_user(user)
    return user


async def authenticate_user(pool: AsyncConnectionPool, login: str, password: str) -> User:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT id, COALESCE(password_hash, '')
            FROM users
            WHERE lower(username) = lower(%s)
               OR lower(email) = lower(%s)
            LIMIT 1
            """,
            (login, login),
        )
        row = await cursor.fetchone()
    if row is None:
        compare_password(password, DUMMY_PASSWORD_HASH)
        raise envelope.new_error(401, 'UNAUTHENTICATED', 'Authentication required')
    user_id, password_hash = row[0], row[1]
    # Google-only accounts have no password hash; keep timing consistent and reject.
    if not password_hash:
        compare_password(password, DUMMY_PASSWORD_HASH)
        raise envelope.new_error(401, 'UNAUTHENTICATED', 'Authentication required')
    if not compare_password(password, password_hash):
        raise envelope.new_error(401, 'UNAUTHENTICATED', 'Authentication required')
    user = await current_user_by_id(pool, user_id)
    if user is None:
        raise envelope.new_error(401, 'UNAUTHENTICATED', 'Authentication required')
    if not user.is_active:
        raise envelope.new_error(403, 'USER_INACTIVE', 'User account is disabled')
    return user


async def issue_session(user_id: int) -> tuple[str, datetime]:
    ttl = config.session_ttl_seconds()
    expires = datetime.fromtimestamp(time.time() + ttl, timezone.utc)
    token = session_mod.sign_session_token(
        session_mod.SessionPayload(
            user_id=user_id,
            expires=session_mod._format_rfc3339(expires),
            jti=new_uuid(),
        )
    )
    return token, expires


def set_session_cookie(response: Response, token: str, expires: datetime) -> None:
    response.set_cookie(**session_mod.session_cookie_params(token, expires))


async def revoke_session(request: Request) -> None:
    token = session_token_from_request(request)
    if token:
        try:
            payload = session_mod.verify_session_token(token)
        except ValueError:
            payload = None
        if payload is not None and payload.jti:
            ttl = session_mod._parse_rfc3339(payload.expires).timestamp() - time.time()
            if ttl > 0:
                rdb = redisx.client()
                if rdb is None:
                    raise session_store_unavailable()
                try:
                    await rdb.set(_session_revocation_key(payload.jti), 'true', ex=max(int(ttl), 1))
                except Exception as exc:
                    raise session_store_unavailable() from exc


def clear_session_cookie(response: Response) -> None:
    response.set_cookie(
        key=session_mod.SESSION_COOKIE_NAME,
        value='',
        path='/',
        max_age=-1,
        httponly=True,
        samesite='lax',
        secure=os.environ.get('NODE_ENV') == 'production',
    )


async def current_user_by_id(pool: AsyncConnectionPool, user_id: int) -> User | None:
    rdb = redisx.client()
    if rdb is not None:
        cached = await redisx.get_json(rdb, _user_cache_key(user_id))
        if isinstance(cached, dict) and cached.get('revenuecat_app_user_id'):
            return User(
                id=cached['id'], username=cached['username'], email=cached.get('email'),
                is_active=cached['is_active'], role=cached['role'], membership=cached['membership'],
                revenuecat_app_user_id=cached['revenuecat_app_user_id'],
            )
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT id, username, email, is_active, role, membership, revenuecat_app_user_id
            FROM users
            WHERE id = %s
            LIMIT 1
            """,
            (user_id,),
        )
        user = _scan_user(await cursor.fetchone())
    if user is not None:
        await _cache_user(user)
    return user


def session_token_from_request(request: Request) -> str:
    cookie = request.cookies.get(session_mod.SESSION_COOKIE_NAME)
    if cookie:
        return cookie
    authorization = request.headers.get('authorization', '')
    if authorization.startswith('Bearer '):
        return authorization[len('Bearer '):].strip()
    return ''


async def _resolve_session_token(pool: AsyncConnectionPool, token: str) -> User | None:
    try:
        payload = session_mod.verify_session_token(token)
    except ValueError:
        return None
    if not payload.jti:
        return None
    rdb = redisx.client()
    if rdb is None:
        raise session_store_unavailable()
    try:
        revoked = await rdb.exists(_session_revocation_key(payload.jti))
    except Exception as exc:
        raise session_store_unavailable() from exc
    if revoked:
        return None
    return await current_user_by_id(pool, payload.user_id)


async def current_user_from_request_token(pool: AsyncConnectionPool, token: str) -> User | None:
    """Token-based resolution used by the SPA guard (cookie value already extracted)."""
    if not token:
        return None
    return await _resolve_session_token(pool, token)


async def current_user_from_request(request: Request, pool: AsyncConnectionPool) -> User | None:
    token = session_token_from_request(request)
    if not token:
        return None
    return await _resolve_session_token(pool, token)


async def require_user(request: Request, pool: AsyncConnectionPool) -> User:
    user = await current_user_from_request(request, pool)
    if user is None:
        raise envelope.new_error(401, 'UNAUTHENTICATED', 'Authentication required')
    if not user.is_active:
        raise envelope.new_error(403, 'USER_INACTIVE', 'User account is disabled')
    return user


def session_store_unavailable() -> envelope.APIError:
    return envelope.new_error(503, 'SESSION_STORE_UNAVAILABLE', 'Session service is temporarily unavailable')


def _user_cache_key(user_id: int) -> str:
    return redisx.redis_key('cache', 'user', user_id)


def _session_revocation_key(jti: str) -> str:
    return redisx.redis_key('session', 'revoked', jti)


def _cache_ttl_seconds() -> int:
    raw = os.environ.get('USER_CACHE_TTL_SECONDS', '').strip()
    try:
        seconds = int(raw)
    except ValueError:
        seconds = 60
    return seconds if seconds > 0 else 60


async def _cache_user(user: User) -> None:
    rdb = redisx.client()
    if rdb is None:
        return
    await redisx.set_json(rdb, _user_cache_key(user.id), user.as_dict(), _cache_ttl_seconds())


async def invalidate_user_cache(user_id: int) -> None:
    rdb = redisx.client()
    if rdb is not None:
        try:
            await rdb.delete(_user_cache_key(user_id))
        except Exception:
            pass
