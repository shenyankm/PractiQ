"""User CRUD, session issuance/revocation, user cache."""

import os
import uuid
from hashlib import sha256
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Request, Response
from psycopg import errors as pg_errors
from psycopg_pool import AsyncConnectionPool

from .. import config, envelope, membership, redisx
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
    trial_ends_at: datetime | None = None

    def as_dict(self) -> dict:
        return {
            'id': self.id,
            'username': self.username,
            'email': self.email,
            'is_active': self.is_active,
            'role': self.role,
            'membership': self.membership,
            'revenuecat_app_user_id': self.revenuecat_app_user_id,
            'trial_ends_at': self.trial_ends_at.isoformat() if self.trial_ends_at else None,
            'trialEndsAt': self.trial_ends_at.isoformat() if self.trial_ends_at else None,
            'effectiveMembership': membership.effective_membership(
                self.membership, self.trial_ends_at
            ),
        }


@dataclass(frozen=True)
class SessionTokens:
    access_token: str
    refresh_token: str
    access_expires_at: datetime
    refresh_expires_at: datetime


def _new_refresh_token() -> tuple[str, bytes]:
    raw = secrets.token_urlsafe(48)
    return raw, sha256(raw.encode()).digest()


def _refresh_token_hash(raw: str) -> bytes:
    return sha256(raw.encode()).digest()


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
        membership=row[5], trial_ends_at=row[6], revenuecat_app_user_id=str(row[7]),
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
                RETURNING id, username, email, is_active, role, membership, trial_ends_at, revenuecat_app_user_id
                """,
                (username, email, password_hash),
            )
            user = _scan_user(await cursor.fetchone())
    except Exception as exc:
        raise _user_conflict_error(exc) from exc
    if user is None:
        raise RuntimeError('could not create user')
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
                RETURNING id, username, email, is_active, role, membership, trial_ends_at, revenuecat_app_user_id
                """,
                (input.username, input.email_set, input.email, password_hash, user_id),
            )
            user = _scan_user(await cursor.fetchone())
    except Exception as exc:
        raise _user_conflict_error(exc) from exc
    if user is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'User not found')
    if password_hash is not None:
        await revoke_user_sessions(pool, user_id, 'password_changed')
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
    # Keep timing consistent if legacy data contains an account without a password.
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


def _issue_access_token(user_id: int, session_id: str, now: datetime) -> tuple[str, datetime]:
    expires = now + timedelta(seconds=config.access_token_ttl_seconds())
    return session_mod.sign_session_token(
        session_mod.SessionPayload(
            user_id=user_id,
            expires=session_mod._format_rfc3339(expires),
            session_id=session_id,
            jti=new_uuid(),
        )
    ), expires


async def issue_session(pool: AsyncConnectionPool, user_id: int) -> SessionTokens:
    now = datetime.now(timezone.utc)
    absolute_expires = now + timedelta(seconds=config.session_absolute_ttl_seconds())
    refresh_expires = min(
        now + timedelta(seconds=config.refresh_token_ttl_seconds()), absolute_expires
    )
    raw_refresh, refresh_hash = _new_refresh_token()
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                """
                INSERT INTO auth_sessions (user_id, absolute_expires_at)
                VALUES (%s, %s)
                RETURNING id
                """,
                (user_id, absolute_expires),
            )
            row = await cursor.fetchone()
            if row is None:
                raise RuntimeError('could not create auth session')
            session_id = str(row[0])
            await conn.execute(
                """
                INSERT INTO refresh_tokens (session_id, token_hash, expires_at)
                VALUES (%s, %s, %s)
                """,
                (session_id, refresh_hash, refresh_expires),
            )
    access_token, access_expires = _issue_access_token(user_id, session_id, now)
    return SessionTokens(access_token, raw_refresh, access_expires, refresh_expires)


def set_session_cookie(response: Response, token: str, expires: datetime) -> None:
    response.set_cookie(**session_mod.session_cookie_params(token, expires))


def set_refresh_cookie(response: Response, token: str, expires: datetime) -> None:
    response.set_cookie(**session_mod.refresh_cookie_params(token, expires))


async def revoke_session(request: Request, pool: AsyncConnectionPool) -> None:
    token = session_token_from_request(request)
    if token:
        try:
            payload = session_mod.verify_session_token(token)
        except ValueError:
            payload = None
        if payload is not None:
            await revoke_session_id(pool, payload.session_id, 'logout')


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


def clear_refresh_cookie(response: Response) -> None:
    response.set_cookie(
        key=session_mod.REFRESH_COOKIE_NAME,
        value='',
        path='/api/v1/auth',
        max_age=-1,
        httponly=True,
        samesite='lax',
        secure=os.environ.get('NODE_ENV') == 'production',
    )


async def revoke_session_id(pool: AsyncConnectionPool, session_id: str, reason: str) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE auth_sessions
            SET revoked_at = COALESCE(revoked_at, NOW()), revoke_reason = COALESCE(revoke_reason, %s)
            WHERE id = %s
            """,
            (reason, session_id),
        )


async def revoke_user_sessions(pool: AsyncConnectionPool, user_id: int, reason: str) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE auth_sessions
            SET revoked_at = COALESCE(revoked_at, NOW()), revoke_reason = COALESCE(revoke_reason, %s)
            WHERE user_id = %s AND revoked_at IS NULL
            """,
            (reason, user_id),
        )


async def rotate_refresh_token(pool: AsyncConnectionPool, raw_refresh_token: str) -> SessionTokens:
    now = datetime.now(timezone.utc)
    refresh_hash = _refresh_token_hash(raw_refresh_token)
    replay_detected = False
    result: tuple[int, str, str, datetime] | None = None
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                """
                SELECT rt.id, rt.session_id, session.user_id, session.absolute_expires_at,
                       rt.expires_at, rt.used_at, rt.revoked_at, session.revoked_at
                FROM refresh_tokens AS rt
                JOIN auth_sessions AS session ON session.id = rt.session_id
                WHERE rt.token_hash = %s
                FOR UPDATE OF rt, session
                """,
                (refresh_hash,),
            )
            row = await cursor.fetchone()
            if row is None:
                raise envelope.new_error(401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token')
            token_id, session_id, user_id, absolute_expires, token_expires, used_at, token_revoked_at, session_revoked_at = row
            if session_revoked_at is not None or absolute_expires <= now or token_expires <= now:
                raise envelope.new_error(401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token')
            if used_at is not None or token_revoked_at is not None:
                await conn.execute(
                    """
                    UPDATE auth_sessions
                    SET revoked_at = %s, revoke_reason = 'refresh_token_reuse'
                    WHERE id = %s AND revoked_at IS NULL
                    """,
                    (now, session_id),
                )
                replay_detected = True
            else:
                new_raw, new_hash = _new_refresh_token()
                new_expires = min(
                    now + timedelta(seconds=config.refresh_token_ttl_seconds()), absolute_expires
                )
                await conn.execute('UPDATE refresh_tokens SET used_at = %s WHERE id = %s', (now, token_id))
                cursor = await conn.execute(
                    """
                    INSERT INTO refresh_tokens (session_id, token_hash, parent_token_id, expires_at)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id
                    """,
                    (session_id, new_hash, token_id, new_expires),
                )
                new_row = await cursor.fetchone()
                if new_row is None:
                    raise RuntimeError('could not rotate refresh token')
                await conn.execute(
                    'UPDATE refresh_tokens SET replaced_by_token_id = %s WHERE id = %s',
                    (new_row[0], token_id),
                )
                try:
                    result = (int(user_id), str(session_id), new_raw, new_expires)
                except (TypeError, ValueError) as exc:
                    raise RuntimeError('invalid session row') from exc
    if replay_detected:
        raise envelope.new_error(401, 'REFRESH_TOKEN_REUSE', 'Refresh token reuse detected')
    if result is None:
        raise RuntimeError('could not rotate refresh token')
    user_id, session_id, new_raw, refresh_expires = result
    access_token, access_expires = _issue_access_token(user_id, session_id, now)
    return SessionTokens(access_token, new_raw, access_expires, refresh_expires)


async def current_user_by_id(pool: AsyncConnectionPool, user_id: int) -> User | None:
    rdb = redisx.client()
    if rdb is not None:
        cached = await redisx.get_json(rdb, _user_cache_key(user_id))
        if isinstance(cached, dict) and cached.get('revenuecat_app_user_id'):
            trial_raw = cached.get('trial_ends_at')
            trial_ends_at = None
            if isinstance(trial_raw, str) and trial_raw:
                try:
                    trial_ends_at = datetime.fromisoformat(trial_raw)
                except ValueError:
                    trial_ends_at = None
            return User(
                id=cached['id'], username=cached['username'], email=cached.get('email'),
                is_active=cached['is_active'], role=cached['role'], membership=cached['membership'],
                revenuecat_app_user_id=cached['revenuecat_app_user_id'],
                trial_ends_at=trial_ends_at,
            )
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT id, username, email, is_active, role, membership, trial_ends_at, revenuecat_app_user_id
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
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT 1 FROM auth_sessions
            WHERE id = %s AND user_id = %s AND revoked_at IS NULL AND absolute_expires_at > NOW()
            """,
            (payload.session_id, payload.user_id),
        )
        if await cursor.fetchone() is None:
            return None
    return await current_user_by_id(pool, payload.user_id)


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
    """Compatibility error for Redis-backed auth controls such as email codes."""
    return envelope.new_error(503, 'SESSION_STORE_UNAVAILABLE', 'Authentication service is temporarily unavailable')


def _user_cache_key(user_id: int) -> str:
    return redisx.redis_key('cache', 'user', user_id)


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
