"""Server-owned identities, resource grants and durable admission."""
import asyncio
import hashlib
import hmac
import secrets
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import HTTPException, Request
from psycopg.types.json import Jsonb

actor: ContextVar[dict[str, Any] | None] = ContextVar('actor', default=None)
owner: ContextVar[str | None] = ContextVar('owner', default=None)
_operator_evaluation: ContextVar[bool] = ContextVar('operator_evaluation', default=False)
PASSWORDS = PasswordHasher()
HASH_SLOTS = asyncio.Semaphore(2)
COOKIE = 'practiq_session'


@contextmanager
def operator_evaluation():
    """Standalone operator calls use evaluation receipts, never an inferred user owner."""
    from .runtime import current
    if current is not None or actor.get() is not None:
        raise RuntimeError('Operator evaluation requires a standalone process')
    token = _operator_evaluation.set(True)
    try:
        yield
    finally:
        _operator_evaluation.reset(token)


def _evaluating() -> bool:
    from .runtime import current
    return _operator_evaluation.get() and current is None and actor.get() is None


def db():
    from .runtime import current
    if current is None:
        raise HTTPException(503, {'code': 'AUTH_UNAVAILABLE'})
    return current.db


def cookie_name(request: Request) -> str:
    return '__Host-practiq_session' if request.url.scheme == 'https' else COOKIE


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def csrf(value: str) -> str:
    return hmac.new(value.encode(), b'practiq-csrf-v1', 'sha256').hexdigest()


async def password_hash(password: str) -> str:
    async with HASH_SLOTS:
        return await asyncio.to_thread(PASSWORDS.hash, password)


async def verify(password: str, encoded: str) -> bool:
    async with HASH_SLOTS:
        try:
            return await asyncio.to_thread(PASSWORDS.verify, encoded, password)
        except (VerificationError, InvalidHashError):
            return False


def public_user(user: dict) -> dict:
    return {key: user[key] for key in ('id', 'email', 'name', 'role', 'enabled')}


async def current_actor(conn) -> dict:
    """Fence credential mutations against a concurrent reset, revocation or role change."""
    user = actor.get()
    if user is None:
        raise HTTPException(401, {'code': 'LOGIN_REQUIRED'})
    row = await (await conn.execute("SELECT u.* FROM auth_users u JOIN auth_sessions s ON s.user_id=u.id WHERE u.id=%s AND s.digest=%s AND s.expires_at>now() AND s.last_seen>now()-interval '24 hours' AND u.enabled", (user['id'], user['credential_id']))).fetchone()
    if row is None or any(row[key] != user[key] for key in ('password_hash', 'email', 'role')):
        raise HTTPException(401, {'code': 'LOGIN_REQUIRED'})
    return row


async def settings() -> dict:
    return {'freePages': 50, **(await db().rows('SELECT value FROM auth_settings WHERE id=1'))[0]['value']}


async def audit(action: str, target: str, detail: dict | None = None, *, conn=None):
    user = actor.get()
    args = (user['id'] if user else 'operator', action, target, Jsonb(detail or {}))
    if conn is not None:
        await conn.execute('INSERT INTO auth_audit(actor,action,target,detail) VALUES(%s,%s,%s,%s)', args)
    else:
        async with db().transaction() as connection:
            await connection.execute('INSERT INTO auth_audit(actor,action,target,detail) VALUES(%s,%s,%s,%s)', args)


async def rate(key: str, maximum: int, seconds: int):
    bucket = int(datetime.now(UTC).timestamp()) // seconds
    async with db().transaction() as conn:
        row = await (await conn.execute('INSERT INTO auth_limits VALUES(%s,%s,1) ON CONFLICT(key,bucket) DO UPDATE SET count=auth_limits.count+1 RETURNING count', (digest(key), bucket))).fetchone()
    assert row is not None
    if row['count'] > maximum:
        raise HTTPException(429, {'code': 'AUTH_RATE_LIMITED'}, headers={'Retry-After': str(seconds)})


async def authenticate(request: Request) -> dict | None:
    raw = request.cookies.get(cookie_name(request), '')
    bearer = request.headers.get('authorization', '')
    if bearer:
        if not bearer.startswith('Bearer pq_grade_') or request.url.path not in {'/api/maintenance', '/api/subjective-grades'}:
            raise HTTPException(401, {'code': 'INVALID_ACCESS_TOKEN'})
        rows = await db().rows("SELECT u.*,t.id AS credential_id FROM auth_tokens t JOIN auth_users u ON u.id=t.user_id WHERE t.digest=%s AND t.kind='grading' AND t.expires_at>now() AND u.enabled", (digest(bearer[7:]),))
    else:
        rows = await db().rows('SELECT u.*,s.digest AS credential_id FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.digest=%s AND s.expires_at>now() AND s.last_seen>now()-interval \'24 hours\' AND u.enabled', (digest(raw),)) if raw else []
    if rows and not bearer:
        async with db().connection() as conn:
            await conn.execute("UPDATE auth_sessions SET last_seen=now() WHERE digest=%s AND last_seen<now()-interval '5 minutes'", (digest(raw),))
    return rows[0] if rows else None


async def require_task(thread: str, user_id: str | None = None) -> dict:
    rows = await db().rows('SELECT * FROM document_tasks WHERE thread_id=%s AND owner_id=%s', (str(UUID(thread)), user_id or owner.get()))
    if not rows:
        raise HTTPException(404, {'code': 'TASK_NOT_FOUND'})
    return rows[0]


async def require_upload(reference):
    rows = await db().rows('SELECT 1 FROM auth_uploads WHERE user_id=%s AND object_key=%s AND sha256=%s AND size_bytes=%s', (owner.get(), reference.objectKey, reference.sha256, reference.sizeBytes))
    if not rows:
        raise HTTPException(404, {'code': 'UPLOAD_NOT_FOUND'})


async def grant(reference):
    async with db().transaction() as conn:
        await conn.execute('INSERT INTO auth_uploads VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING', (owner.get(), reference.objectKey, reference.sha256, reference.sizeBytes))


async def page_usage(conn, user_id: str) -> int:
    row = await (await conn.execute("SELECT coalesce(sum((record->>'quotaPages')::integer),0) AS pages FROM auth_calls WHERE user_id=%s AND kind='tencentCalls'", (user_id,))).fetchone()
    assert row is not None
    return row['pages']


async def reserve(scope: str, key: str, kind: str, record: dict, *, pages: int = 1, allow_partial: bool = False):
    if _evaluating():
        return
    from . import billing
    from .errors import DocumentProcessingError
    state = None
    day = datetime.now(ZoneInfo('Asia/Singapore')).date()
    async with db().transaction() as conn:
        table = 'document_tasks' if scope.startswith('task:') else 'grades'
        column = 'thread_id' if table == 'document_tasks' else 'id'
        rows = await (await conn.execute(f'SELECT u.* FROM {table} t JOIN auth_users u ON u.id=t.owner_id WHERE t.{column}=%s', (scope.split(':', 1)[1],))).fetchall()
        if not rows or not rows[0]['enabled']:
            raise DocumentProcessingError(403, 'Account is disabled or this historical work has no owner', 'ACCOUNT_DISABLED')
        user = rows[0]
        previous = await (await conn.execute('SELECT user_id,scope,kind,record FROM auth_calls WHERE call_key=%s', (key,))).fetchone()
        if previous:
            if any(previous[field] != value for field, value in {'user_id': user['id'], 'scope': scope, 'kind': kind}.items()):
                raise DocumentProcessingError(409, 'Call identity changed', 'REQUEST_CONFLICT')
            for field in ('quotaPages', 'pageLimit'):
                if field in previous['record']:
                    record[field] = previous['record'][field]
            return
        defaults_row = await (await conn.execute('SELECT value FROM auth_settings WHERE id=1')).fetchone()
        assert defaults_row is not None
        defaults = defaults_row['value']
        limit = user['limits'].get(kind, defaults[kind])
        count_row = await (await conn.execute('SELECT count(*) AS n FROM auth_calls WHERE user_id=%s AND day=%s AND kind=%s', (user['id'], day, kind))).fetchone()
        assert count_row is not None
        count = count_row['n']
        if count >= limit:
            raise DocumentProcessingError(429, 'Daily account call limit reached; resume explicitly after reset', 'USER_QUOTA_EXCEEDED')
        if kind == 'tencentCalls':
            if type(pages) is not int or pages < 1:
                raise ValueError('Page reservation must be a positive integer')
            state = await billing.balance(conn, user, defaults)
            remaining = state['remainingPages']
            if remaining < 1 or (pages > remaining and not allow_partial):
                raise DocumentProcessingError(429, 'Recognition page quota is insufficient; choose a plan or add pages', 'FREE_PAGE_QUOTA_EXCEEDED')
            record.update(quotaPages=min(pages, remaining), pageLimit=min(pages, remaining))
        await conn.execute('INSERT INTO auth_calls(call_key,user_id,scope,kind,day,record) VALUES(%s,%s,%s,%s,%s,%s)', (key, user['id'], scope, kind, day, Jsonb({**record, 'admissionState': 'reserved'})))
        if state is not None:
            await billing.allocate(conn, key, state, record['quotaPages'])


async def record_call(key: str, record: dict):
    if _evaluating():
        return
    async with db().transaction() as conn:
        previous = await (await conn.execute('SELECT record FROM auth_calls WHERE call_key=%s', (key,))).fetchone()
        if previous and 'quotaPages' in previous['record']:
            from . import billing
            record['quotaPages'] = min(previous['record']['quotaPages'], record.get('quotaPages', previous['record']['quotaPages']))
            await billing.settle(conn, key, record['quotaPages'])
        await conn.execute('UPDATE auth_calls SET record=%s WHERE call_key=%s', (Jsonb({**record, 'admissionState': 'dispatched'}), key))


async def release(key: str):
    """Release only a positively unsubmitted admission, never an uncertain call."""
    if _evaluating():
        return
    async with db().transaction() as conn:
        await conn.execute("DELETE FROM auth_calls WHERE call_key=%s AND record->>'admissionState'='reserved'", (key,))


async def admit(conn, task):
    from .errors import DocumentProcessingError
    if not task.get('owner_id'):
        return  # Internal fixtures and historical read-only maintenance have no principal.
    user = await (await conn.execute('SELECT * FROM auth_users WHERE id=%s', (task['owner_id'],))).fetchone()
    if not user['enabled']:
        raise DocumentProcessingError(403, 'Account is disabled', 'ACCOUNT_DISABLED')
    defaults_row = await (await conn.execute('SELECT value FROM auth_settings WHERE id=1')).fetchone()
    assert defaults_row is not None
    defaults = defaults_row['value']
    count = (await (await conn.execute("SELECT count(*) AS n FROM document_runs r JOIN document_tasks t USING(thread_id) WHERE t.owner_id=%s AND r.status IN ('pending','running')", (user['id'],))).fetchone())['n']
    from . import billing
    if count >= (await billing.balance(conn, user, defaults))['activeTasks']:
        raise DocumentProcessingError(429, 'Account task concurrency limit reached', 'USER_TASK_LIMIT')


async def session(request: Request, response, user: dict):
    raw = secrets.token_urlsafe(32)
    async with db().transaction() as conn:
        latest = await (await conn.execute('SELECT * FROM auth_users WHERE id=%s AND enabled', (user['id'],))).fetchone()
        if latest is None or any(latest[key] != user[key] for key in ('password_hash', 'email')):
            raise HTTPException(401, {'code': 'INVALID_CREDENTIALS'})
        user = latest
        await conn.execute('DELETE FROM auth_sessions WHERE digest=%s', (digest(request.cookies.get(cookie_name(request), '')),))
        await conn.execute('INSERT INTO auth_sessions(digest,user_id,expires_at) VALUES(%s,%s,%s)', (digest(raw), user['id'], datetime.now(UTC) + timedelta(days=7)))
    response.set_cookie(cookie_name(request), raw, max_age=604800, httponly=True, secure=request.url.scheme == 'https', samesite='lax', path='/')
    return {'user': public_user(user), 'csrf': csrf(raw), 'registrationEnabled': (await settings())['registrationEnabled']}
