"""Cookie account APIs and explicit audited administration."""
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, LiteralString
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query, Request, Response
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from . import billing
from . import identity as auth
from .contracts import (
    AccountCall,
    AccountChange,
    AccountCredentials,
    AccountOperation,
    AccountPasswordConfirm,
    AccountReset,
    AccountResetLink,
    AccountSecret,
    AccountSession,
    AccountSessionInfo,
    AccountTokenCreate,
    AccountTokenInfo,
    AccountUsage,
    AdministrationAudit,
    AdministrationFilter,
    AdministrationSettings,
    AdministrationUser,
    AdministrationUserChange,
    DocumentTaskList,
    ImportSettingsSnapshot,
)

router = APIRouter()


def me():
    user = auth.actor.get()
    if user is None:
        raise HTTPException(401, {'code': 'LOGIN_REQUIRED'})
    return user


async def confirm(password):
    if not await auth.verify(password, me()['password_hash']):
        raise HTTPException(403, {'code': 'PASSWORD_REQUIRED'})


@router.get('/api/auth/session', response_model=AccountSession)
async def current_session(request: Request, response: Response):
    user = await auth.authenticate(request)
    raw = request.cookies.get(auth.cookie_name(request), '')
    if user:
        async with auth.db().transaction() as conn:
            await conn.execute('UPDATE auth_sessions SET last_seen=now() WHERE digest=%s', (auth.digest(raw),))
    else:
        raw = secrets.token_urlsafe(32)
        response.set_cookie(auth.cookie_name(request), raw, httponly=True, secure=request.url.scheme == 'https', samesite='lax', path='/')
    ready = bool(await auth.db().rows("SELECT 1 FROM auth_users WHERE role='admin' AND enabled LIMIT 1"))
    return {'user': auth.public_user(user) if user else None, 'csrf': auth.csrf(raw), 'registrationEnabled': ready and (await auth.settings())['registrationEnabled']}


@router.post('/api/auth/register', response_model=AccountSession)
async def register(value: AccountCredentials, request: Request, response: Response):
    await auth.rate(f'register:{request.client.host if request.client else "unknown"}', 5, 3600)
    if not (await auth.settings())['registrationEnabled'] or not await auth.db().rows("SELECT 1 FROM auth_users WHERE role='admin' AND enabled"):
        raise HTTPException(403, {'code': 'REGISTRATION_DISABLED'})
    encoded = await auth.password_hash(value.password)
    try:
        async with auth.db().transaction() as conn:
            defaults = await (await conn.execute('SELECT value FROM auth_settings WHERE id=1')).fetchone()
            assert defaults is not None
            ready = await (await conn.execute("SELECT 1 FROM auth_users WHERE role='admin' AND enabled LIMIT 1")).fetchone()
            if not defaults['value']['registrationEnabled'] or not ready:
                raise HTTPException(403, {'code': 'REGISTRATION_DISABLED'})
            user = await (await conn.execute("INSERT INTO auth_users(id,email,password_hash,role,limits) VALUES(%s,%s,%s,'user',%s) RETURNING *", (str(uuid4()), value.email.lower(), encoded, Jsonb({'freePages': defaults['value'].get('freePages', 50)})))).fetchone()
    except UniqueViolation as exc:
        raise HTTPException(409, {'code': 'EMAIL_UNAVAILABLE'}) from exc
    assert user is not None
    return await auth.session(request, response, user)


@router.post('/api/auth/login', response_model=AccountSession)
async def login(value: AccountCredentials, request: Request, response: Response):
    ip = request.client.host if request.client else 'unknown'
    await auth.rate(f'login:{ip}', 50, 900)
    await auth.rate(f'login:{ip}:{value.email.lower()}', 5, 900)
    await auth.rate(f'account-login:{value.email.lower()}', 20, 900)
    rows = await auth.db().rows('SELECT * FROM auth_users WHERE email=%s', (value.email.lower(),))
    # Hash a dummy password too so absent accounts do not skip the expensive work.
    if rows:
        valid = await auth.verify(value.password, rows[0]['password_hash'])
    else:
        await auth.password_hash(value.password)
        valid = False
    if not valid or not rows[0]['enabled']:
        raise HTTPException(401, {'code': 'INVALID_CREDENTIALS'})
    return await auth.session(request, response, rows[0])


@router.post('/api/auth/logout', response_model=AccountOperation)
async def logout(request: Request, response: Response):
    async with auth.db().transaction() as conn:
        await conn.execute('DELETE FROM auth_sessions WHERE digest=%s', (auth.digest(request.cookies.get(auth.cookie_name(request), '')),))
    response.delete_cookie(auth.cookie_name(request), path='/', secure=request.url.scheme == 'https', httponly=True, samesite='lax')
    return {'ok': True}


@router.post('/api/auth/reset-password', response_model=AccountOperation)
async def reset_password(value: AccountReset, request: Request):
    await auth.rate(f'reset:{request.client.host if request.client else "unknown"}', 10, 900)
    encoded = await auth.password_hash(value.password)
    async with auth.db().transaction() as conn:
        token = await (await conn.execute("DELETE FROM auth_tokens WHERE digest=%s AND kind='reset' AND expires_at>now() RETURNING user_id", (auth.digest(value.token),))).fetchone()
        if not token:
            raise HTTPException(400, {'code': 'RESET_EXPIRED'})
        await conn.execute('UPDATE auth_users SET password_hash=%s WHERE id=%s', (encoded, token['user_id']))
        await conn.execute('DELETE FROM auth_sessions WHERE user_id=%s', (token['user_id'],))
        await conn.execute('DELETE FROM auth_tokens WHERE user_id=%s', (token['user_id'],))
        await auth.audit('password_reset', token['user_id'], conn=conn)
    return {'ok': True}


@router.patch('/api/me/profile', response_model=AccountOperation)
async def profile(value: AccountChange):
    await confirm(value.currentPassword)
    user = me()
    encoded = await auth.password_hash(value.password) if value.password else user['password_hash']
    try:
        async with auth.db().transaction() as conn:
            user = await auth.current_actor(conn)
            await conn.execute('UPDATE auth_users SET email=%s,name=%s,password_hash=%s WHERE id=%s', (value.email.lower() if value.email else user['email'], value.name if value.name is not None else user['name'], encoded, user['id']))
            if value.password or value.email:
                await conn.execute('DELETE FROM auth_sessions WHERE user_id=%s', (user['id'],))
                await conn.execute('DELETE FROM auth_tokens WHERE user_id=%s', (user['id'],))
            await auth.audit('profile_update', user['id'], conn=conn)
    except UniqueViolation as exc:
        raise HTTPException(409, {'code': 'EMAIL_UNAVAILABLE'}) from exc
    return {'ok': True}


@router.get('/api/me/sessions', response_model=list[AccountSessionInfo])
async def sessions():
    rows = await auth.db().rows('SELECT digest,created_at,expires_at,last_seen FROM auth_sessions WHERE user_id=%s AND expires_at>now() ORDER BY created_at DESC', (me()['id'],))
    # Session digests are not returned as revoke identifiers.
    return [{'id': auth.digest('revoke:' + r['digest']), 'createdAt': r['created_at'], 'expiresAt': r['expires_at'], 'lastSeen': r['last_seen']} for r in rows]


@router.delete('/api/me/sessions/{session_id}', response_model=AccountOperation)
async def revoke_session(session_id: str):
    async with auth.db().transaction() as conn:
        rows = await (await conn.execute('SELECT digest FROM auth_sessions WHERE user_id=%s', (me()['id'],))).fetchall()
        for row in rows:
            if auth.digest('revoke:' + row['digest']) == session_id:
                await conn.execute('DELETE FROM auth_sessions WHERE digest=%s', (row['digest'],))
    return {'ok': True}


@router.get('/api/me/tokens', response_model=list[AccountTokenInfo])
async def tokens():
    return await auth.db().rows("SELECT id,name,created_at,expires_at FROM auth_tokens WHERE user_id=%s AND kind='grading' ORDER BY created_at DESC", (me()['id'],))


@router.post('/api/me/tokens', response_model=AccountSecret)
async def token_create(value: AccountTokenCreate):
    await confirm(value.currentPassword)
    await auth.rate('token:' + me()['id'], 10, 3600)
    raw = 'pq_grade_' + secrets.token_urlsafe(32)
    async with auth.db().transaction() as conn:
        await auth.current_actor(conn)
        await conn.execute("INSERT INTO auth_tokens(digest,id,user_id,kind,name,expires_at) VALUES(%s,%s,%s,'grading',%s,%s)", (auth.digest(raw), str(uuid4()), me()['id'], value.name, datetime.now(UTC) + timedelta(days=90)))
        await auth.audit('grading_token_create', me()['id'], conn=conn)
    return {'token': raw}


@router.delete('/api/me/tokens/{token_id}', response_model=AccountOperation)
async def token_delete(token_id: str):
    async with auth.db().transaction() as conn:
        await conn.execute('DELETE FROM auth_tokens WHERE id=%s AND user_id=%s', (token_id, me()['id']))
        await auth.audit('grading_token_revoke', token_id, conn=conn)
    return {'ok': True}


@router.get('/api/me/usage', response_model=AccountUsage)
async def usage(offset: int = Query(default=0, ge=0)):
    defaults = await auth.settings()
    async with auth.db().connection() as conn:
        pages = await auth.page_usage(conn, me()['id'])
        state = await billing.balance(conn, me(), defaults)
    limits = {k: me()['limits'].get(k, defaults[k]) for k in ('freePages', 'modelCalls', 'tencentCalls', 'activeTasks')}
    limits['activeTasks'] = state['activeTasks']
    return {'limits': limits, 'usedPages': pages, 'remainingPages': state['remainingPages'],
            'daily': await auth.db().rows('SELECT day,kind,count(*) AS calls FROM auth_calls WHERE user_id=%s GROUP BY day,kind ORDER BY day DESC LIMIT 62', (me()['id'],)),
            'calls': await auth.db().rows('SELECT call_key,kind,scope,day,record FROM auth_calls WHERE user_id=%s ORDER BY created_at DESC LIMIT 100 OFFSET %s', (me()['id'], offset))}


@router.get('/api/admin/users', response_model=list[AdministrationUser])
async def users(filters: Annotated[AdministrationFilter, Query()]):
    await auth.audit('users_read', 'users')
    from .admin_api import period
    where, args = period(filters, 'created_at')
    if filters.issue not in {None, 'quota'}:
        raise HTTPException(422, {'code': 'INVALID_USER_ISSUE'})
    if filters.issue == 'quota':
        where += """ AND coalesce((limits->>'freePages')::bigint,(SELECT (value->>'freePages')::bigint FROM auth_settings WHERE id=1),50)
          <= coalesce((SELECT sum((c.record->>'quotaPages')::bigint) FROM auth_calls c WHERE c.user_id=auth_users.id AND c.kind='tencentCalls'),0)
          - coalesce((SELECT sum(a.pages) FROM page_allocations a JOIN page_grants g USING(order_id) WHERE g.owner_id=auth_users.id),0)
          AND NOT EXISTS (SELECT 1 FROM page_grants g WHERE g.owner_id=auth_users.id AND g.state='active' AND g.expires_at>now()
          AND (g.product->>'pages')::bigint>coalesce((SELECT sum(a.pages) FROM page_allocations a WHERE a.order_id=g.order_id),0))"""
    if filters.q:
        where += ' AND (strpos(lower(email),lower(%s))>0 OR strpos(lower(name),lower(%s))>0 OR id=%s)'
        args += [filters.q] * 3
    if filters.role is not None:
        where += ' AND role=%s'
        args.append(filters.role)
    if filters.enabled is not None:
        where += ' AND enabled=%s'
        args.append(filters.enabled)
    return await auth.db().rows(f'SELECT id,email,name,role,enabled,limits,created_at FROM auth_users WHERE true {where} ORDER BY created_at,id LIMIT 50 OFFSET %s', (*args, filters.offset))


@router.patch('/api/admin/users/{user_id}', response_model=AccountOperation)
async def user_change(user_id: str, value: AdministrationUserChange):
    await confirm(value.currentPassword)
    async with auth.db().transaction() as conn:
        await auth.current_actor(conn)
        from .admin_api import user_row
        before_user = await user_row(user_id, conn)
        before_balance = await billing.balance(conn, before_user)
        if value.expectedFreePages is not None and value.expectedFreePages != before_balance['freePages']:
            raise HTTPException(409, {'code': 'ALLOWANCE_CHANGED'})
        defaults_row = await (await conn.execute('SELECT value FROM auth_settings WHERE id=1')).fetchone()
        assert defaults_row is not None
        next_free = value.limits.freePages if value.limits else defaults_row['value'].get('freePages', 50)
        if next_free != before_balance['freePages'] and not value.reason.strip():
            raise HTTPException(422, {'code': 'ALLOWANCE_REASON_REQUIRED'})
        admins = await (await conn.execute("SELECT id FROM auth_users WHERE role='admin' AND enabled")).fetchall()
        if len(admins) == 1 and admins[0]['id'] == user_id and (not value.enabled or value.role != 'admin'):
            raise HTTPException(409, {'code': 'LAST_ADMIN'})
        updated = await (await conn.execute('UPDATE auth_users SET enabled=%s,role=%s,limits=%s WHERE id=%s RETURNING id', (value.enabled, value.role, Jsonb(value.limits.model_dump() if value.limits else {}), user_id))).fetchone()
        if updated is None:
            raise HTTPException(404, {'code': 'USER_NOT_FOUND'})
        await conn.execute('DELETE FROM auth_sessions WHERE user_id=%s', (user_id,))
        await conn.execute('DELETE FROM auth_tokens WHERE user_id=%s', (user_id,))
        if not value.enabled:
            await conn.execute("UPDATE document_runs SET pause_requested=true WHERE thread_id IN (SELECT thread_id FROM document_tasks WHERE owner_id=%s) AND status IN ('pending','running')", (user_id,))
        await auth.audit('user_update', user_id, {'enabled': value.enabled, 'role': value.role, 'limits': value.limits.model_dump() if value.limits else {}, 'reason': value.reason, 'before': {'enabled': before_user['enabled'], 'role': before_user['role'], 'limits': before_user['limits']}, 'after': {'enabled': value.enabled, 'role': value.role, 'limits': value.limits.model_dump() if value.limits else {}}}, conn=conn)
    return {'ok': True}


@router.post('/api/admin/users/{user_id}/reset-link', response_model=AccountResetLink)
async def reset_link(user_id: str, value: AccountPasswordConfirm):
    await confirm(value.currentPassword)
    if not await auth.db().rows('SELECT 1 FROM auth_users WHERE id=%s', (user_id,)):
        raise HTTPException(404)
    raw = secrets.token_urlsafe(32)
    async with auth.db().transaction() as conn:
        await auth.current_actor(conn)
        await conn.execute("DELETE FROM auth_tokens WHERE user_id=%s AND kind='reset'", (user_id,))
        await conn.execute("INSERT INTO auth_tokens(digest,id,user_id,kind,expires_at) VALUES(%s,%s,%s,'reset',%s)", (auth.digest(raw), str(uuid4()), user_id, datetime.now(UTC) + timedelta(minutes=30)))
        await auth.audit('reset_link_create', user_id, conn=conn)
    return {'path': '/reset-password#' + raw}


@router.get('/api/admin/settings', response_model=AdministrationSettings)
async def admin_settings():
    return await auth.settings()


@router.put('/api/admin/settings', response_model=AdministrationSettings)
async def save_settings(value: AdministrationSettings):
    from .config import load
    if load().read_only:
        raise HTTPException(409, {'code': 'SERVICE_READ_ONLY'})
    async with auth.db().transaction() as conn:
        await auth.current_actor(conn)
        previous_row = await (await conn.execute('SELECT value FROM auth_settings WHERE id=1')).fetchone()
        assert previous_row is not None
        previous = previous_row['value']
        await conn.execute('UPDATE auth_settings SET value=%s WHERE id=1', (Jsonb(value.model_dump()),))
        await auth.audit('settings_update', 'settings', {'before': previous, 'after': value.model_dump()}, conn=conn)
    return value


@router.get('/api/admin/audit', response_model=list[AdministrationAudit])
async def audit_log(filters: Annotated[AdministrationFilter, Query()]):
    from .admin_api import period
    where, args = period(filters, 'created_at')
    selectors: tuple[tuple[LiteralString, str], ...] = (('actor', filters.actor), ('target', filters.target), ('action', filters.action))
    for column, value in selectors:
        if value:
            where += f' AND {column}=%s'
            args.append(value)
    if filters.userId:
        where += """ AND (actor=%s OR target=%s
          OR target='/api/admin/users/'||%s OR strpos(target,'/api/admin/users/'||%s||'/')=1
          OR EXISTS (SELECT 1 FROM document_tasks t WHERE t.owner_id=%s
            AND (t.thread_id=auth_audit.target OR auth_audit.target='/api/admin/document-tasks/'||t.thread_id
              OR strpos(auth_audit.target,'/api/admin/document-tasks/'||t.thread_id||'/')=1))
          OR EXISTS (SELECT 1 FROM payment_orders p WHERE p.owner_id=%s
            AND (p.id=auth_audit.target OR auth_audit.target='/api/admin/payments/'||p.id
              OR strpos(auth_audit.target,'/api/admin/payments/'||p.id||'/')=1))
          OR EXISTS (SELECT 1 FROM grades g WHERE g.owner_id=%s AND g.id=auth_audit.target))"""
        args += [filters.userId] * 7
    if filters.q:
        where += ' AND (strpos(lower(actor),lower(%s))>0 OR strpos(lower(target),lower(%s))>0 OR strpos(lower(action),lower(%s))>0)'
        args += [filters.q] * 3
    return await auth.db().rows(f'SELECT * FROM auth_audit WHERE true {where} ORDER BY id DESC LIMIT 100 OFFSET %s', (*args, filters.offset))


@router.get('/api/admin/usage', response_model=list[AccountCall])
async def provider_usage(filters: Annotated[AdministrationFilter, Query()]):
    from .admin_api import CALLS, call_where
    where, args = call_where(filters)
    await auth.audit('usage_read', filters.userId or 'provider')
    rows = await auth.db().rows(CALLS + f'SELECT call_key,user_id,scope,kind,day,record,created_at FROM calls WHERE true {where} ORDER BY created_at DESC,call_key LIMIT 100 OFFSET %s', (*args, filters.offset))
    return rows


@router.get('/api/admin/import-settings', response_model=ImportSettingsSnapshot)
async def execution_settings():
    from .task_api import client
    return client().import_control.snapshot


@router.put('/api/admin/import-settings', response_model=ImportSettingsSnapshot)
async def execution_settings_save(value: ImportSettingsSnapshot):
    from .config import load
    if load().read_only:
        raise HTTPException(409, {'code': 'SERVICE_READ_ONLY'})
    from .task_api import client
    previous = client().import_control.snapshot.model_dump(mode='json')
    result = await client().import_control.save(auth.db().store, value)
    await auth.audit('import_settings_update', 'settings', {'before': previous, 'after': result.model_dump(mode='json')})
    return result


@router.get('/api/me/banks', response_model=DocumentTaskList)
async def banks(offset: int = Query(default=0, ge=0)):
    from .task_api import list_tasks
    return await list_tasks(limit=50, offset=offset, state_filter='completed')
