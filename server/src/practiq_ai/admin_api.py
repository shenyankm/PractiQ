"""Audited administrator queries and explicit account recovery; no provider writes."""
import asyncio
import os
import stat
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, LiteralString, cast

from fastapi import APIRouter, HTTPException, Query
from psycopg.types.json import Jsonb

from . import billing, grading, task_api
from . import identity as auth
from .account_api import confirm
from .config import load
from .contracts import (
    AccountOperation,
    AccountSessionInfo,
    AccountTokenInfo,
    AdministrationAllowanceChange,
    AdministrationCall,
    AdministrationCredentialRevoke,
    AdministrationFilter,
    AdministrationMonitoring,
    AdministrationOperations,
    AdministrationTaskList,
    AdministrationUsageSummary,
    AdministrationUserDetail,
)

router = APIRouter(prefix='/api/admin')
Filters = Annotated[AdministrationFilter, Query()]

# Match provider IDs or the exact durable submission hash within the task namespace.
CALLS: LiteralString = """WITH receipts AS (
 SELECT c.*,u.email,coalesce(j.value->>'status',c.record->>'status','unknown') AS status,
 CASE WHEN c.kind='tencentCalls' THEN 'Tencent' ELSE coalesce(c.record->>'modelId','unknown') END AS provider
 FROM auth_calls c JOIN auth_users u ON u.id=c.user_id
 LEFT JOIN LATERAL (SELECT s.value FROM store s
  WHERE c.kind='tencentCalls' AND s.prefix='document_tasks.'||split_part(c.scope,':',2)||'.tencent_jobs'
  AND (s.value->>'taskId'=c.record->>'taskId'
   OR c.call_key=encode(sha256(convert_to(split_part(c.scope,':',2)||'/'||s.key||'/'||(s.value->>'sourceSha256'),'UTF8')),'hex'))
  ORDER BY s.key LIMIT 1) j ON true
), calls AS (
 SELECT receipts.*, CASE
 WHEN status IN ('completed','Success') THEN 'completed'
 WHEN status IN ('failed','rejected','Failed','REJECTED') AND coalesce(record->>'error','')!='MODEL_RESULT_UNKNOWN' THEN 'failed'
 WHEN record->>'admissionState'='reserved' THEN 'reserved'
 WHEN kind='modelCalls' AND status='started' AND NOT (scope=ANY(%s::text[]) OR EXISTS (SELECT 1 FROM document_runs r WHERE receipts.scope='task:'||r.thread_id AND r.status IN ('pending','running'))) THEN 'unknown'
 WHEN status IN ('Unknown','unknown') OR record->>'error'='MODEL_RESULT_UNKNOWN'
  OR (kind='modelCalls' AND record->>'usageStatus'='unknown' AND status!='started')
  OR (kind='tencentCalls' AND status='SUBMITTING' AND record->>'taskId' IS NULL) THEN 'unknown'
 ELSE 'pending' END AS state FROM receipts
) """


def period(filters: AdministrationFilter, column: LiteralString) -> tuple[LiteralString, list[Any]]:
    where: LiteralString = ''
    args: list[Any] = []
    if filters.since:
        where += f' AND {column}>=%s'
        args.append(filters.since)
    if filters.until:
        where += f' AND {column}<%s'
        args.append(filters.until)
    return where, args


def call_where(filters: AdministrationFilter) -> tuple[LiteralString, list[Any]]:
    where, args = period(filters, 'created_at')
    args.insert(0, [f'grade:{request_id}' for request_id in grading.active_requests])
    if filters.userId:
        where += ' AND user_id=%s'
        args.append(filters.userId)
    if filters.q:
        where += ' AND (strpos(lower(email),lower(%s))>0 OR strpos(scope,%s)>0 OR strpos(call_key,%s)>0)'
        args += [filters.q] * 3
    if filters.provider:
        where += ' AND provider=%s'
        args.append(filters.provider)
    if filters.kind:
        where += ' AND kind=%s'
        args.append(filters.kind)
    if filters.state:
        if filters.state not in {'completed', 'failed', 'unknown', 'pending', 'reserved'}:
            raise HTTPException(422, {'code': 'INVALID_CALL_STATE'})
        where += ' AND state=%s'
        args.append(filters.state)
    return where, args


async def user_row(user_id: str, conn=None) -> dict:
    query: LiteralString = 'SELECT id,email,name,role,enabled,limits,created_at FROM auth_users WHERE id=%s'
    rows = await (await conn.execute(query, (user_id,))).fetchall() if conn else await auth.db().rows(query, (user_id,))
    if not rows:
        raise HTTPException(404, {'code': 'USER_NOT_FOUND'})
    return rows[0]


async def user_detail(user_id: str) -> dict:
    async with auth.db().connection() as conn, conn.transaction():
        await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        user = await user_row(user_id, conn)
        defaults_row = await (await conn.execute('SELECT value FROM auth_settings WHERE id=1')).fetchone()
        assert defaults_row is not None
        defaults = defaults_row['value']
        balance = await billing.balance(conn, user, defaults)
        where = AdministrationFilter(userId=user_id)
        condition, args = call_where(where)
        pages = await (await conn.execute(CALLS + f"""SELECT
          coalesce(sum((record->>'quotaPages')::integer) FILTER (WHERE kind='tencentCalls' AND state='completed'),0) AS settled,
          coalesce(sum((record->>'quotaPages')::integer) FILTER (WHERE kind='tencentCalls' AND state!='completed'),0) AS held,
          coalesce(sum((record->>'quotaPages')::integer) FILTER (WHERE kind='tencentCalls' AND state='unknown'),0) AS unknown
          FROM calls WHERE true {condition}""", args)).fetchone()
        sessions = await (await conn.execute("SELECT count(*) AS n FROM auth_sessions WHERE user_id=%s AND expires_at>now() AND last_seen>now()-interval '24 hours'", (user_id,))).fetchone()
        tokens = await (await conn.execute("SELECT count(*) AS n FROM auth_tokens WHERE user_id=%s AND kind='grading' AND expires_at>now()", (user_id,))).fetchone()
    assert pages is not None and sessions is not None and tokens is not None
    return {'user': user, 'balance': balance,
            'limits': {**{k: defaults[k] for k in ('freePages', 'modelCalls', 'tencentCalls', 'activeTasks')}, **user['limits'], 'activeTasks': balance['activeTasks']},
            'settledPages': pages['settled'], 'heldPages': pages['held'], 'unknownPages': pages['unknown'],
            'activeSessions': sessions['n'], 'activeTokens': tokens['n']}


@router.get('/users/{user_id}', response_model=AdministrationUserDetail)
async def inspect_user(user_id: str):
    await auth.audit('user_detail_read', user_id)
    return await user_detail(user_id)


@router.post('/users/{user_id}/allowance', response_model=AdministrationUserDetail)
async def change_allowance(user_id: str, value: AdministrationAllowanceChange):
    await confirm(value.currentPassword)
    if load().read_only:
        raise HTTPException(409, {'code': 'SERVICE_READ_ONLY'})
    async with auth.db().transaction() as conn:
        await auth.current_actor(conn)
        user = await user_row(user_id, conn)
        before = await billing.balance(conn, user)
        if before['freePages'] != value.expectedFreePages:
            raise HTTPException(409, {'code': 'ALLOWANCE_CHANGED'})
        limits = {**user['limits'], 'freePages': value.freePages}
        await conn.execute('UPDATE auth_users SET limits=%s WHERE id=%s', (Jsonb(limits), user_id))
        after = await billing.balance(conn, {**user, 'limits': limits})
        await auth.audit('allowance_update', user_id, {'reason': value.reason, 'before': before, 'after': after}, conn=conn)
    return await user_detail(user_id)


@router.get('/users/{user_id}/sessions', response_model=list[AccountSessionInfo])
async def user_sessions(user_id: str, offset: int = Query(default=0, ge=0, le=1_000_000)):
    await user_row(user_id)
    await auth.audit('user_sessions_read', user_id)
    rows = await auth.db().rows("SELECT digest,created_at,expires_at,last_seen FROM auth_sessions WHERE user_id=%s AND expires_at>now() AND last_seen>now()-interval '24 hours' ORDER BY created_at DESC,digest LIMIT 100 OFFSET %s", (user_id, offset))
    return [{'id': auth.digest('revoke:' + row['digest']), 'createdAt': row['created_at'], 'expiresAt': row['expires_at'], 'lastSeen': row['last_seen']} for row in rows]


@router.get('/users/{user_id}/tokens', response_model=list[AccountTokenInfo])
async def user_tokens(user_id: str, offset: int = Query(default=0, ge=0, le=1_000_000)):
    await user_row(user_id)
    await auth.audit('user_tokens_read', user_id)
    return await auth.db().rows("SELECT id,name,created_at,expires_at FROM auth_tokens WHERE user_id=%s AND kind='grading' AND expires_at>now() ORDER BY created_at DESC,id LIMIT 100 OFFSET %s", (user_id, offset))


async def revoke(user_id: str, value: AdministrationCredentialRevoke, session_id: str | None = None, token_id: str | None = None):
    await confirm(value.currentPassword)
    async with auth.db().transaction() as conn:
        await auth.current_actor(conn)
        await user_row(user_id, conn)
        if token_id is not None:
            result = await conn.execute("DELETE FROM auth_tokens WHERE user_id=%s AND id=%s AND kind='grading'", (user_id, token_id))
        elif session_id is not None:
            result = await conn.execute("DELETE FROM auth_sessions WHERE user_id=%s AND encode(sha256(convert_to('revoke:'||digest,'UTF8')),'hex')=%s", (user_id, session_id))
        else:
            result = await conn.execute('DELETE FROM auth_sessions WHERE user_id=%s', (user_id,))
        if (session_id is not None or token_id is not None) and result.rowcount == 0:
            raise HTTPException(404, {'code': 'CREDENTIAL_NOT_FOUND'})
        await auth.audit('user_token_revoke' if token_id else 'user_session_revoke', user_id,
                         {'reason': value.reason, 'credentialId': token_id or session_id, 'allSessions': session_id is None and token_id is None, 'count': result.rowcount}, conn=conn)
    return {'ok': True}


@router.delete('/users/{user_id}/sessions', response_model=AccountOperation)
async def revoke_all_sessions(user_id: str, value: AdministrationCredentialRevoke):
    return await revoke(user_id, value)


@router.delete('/users/{user_id}/sessions/{session_id}', response_model=AccountOperation)
async def revoke_user_session(user_id: str, session_id: str, value: AdministrationCredentialRevoke):
    return await revoke(user_id, value, session_id=session_id)


@router.delete('/users/{user_id}/tokens/{token_id}', response_model=AccountOperation)
async def revoke_user_token(user_id: str, token_id: str, value: AdministrationCredentialRevoke):
    return await revoke(user_id, value, token_id=token_id)


@router.get('/usage/summary', response_model=AdministrationUsageSummary)
async def usage_summary(filters: Filters):
    where, args = call_where(filters)
    aggregates: LiteralString = '''count(*) AS calls,
      count(*) FILTER (WHERE state='failed') AS "failedCalls",
      count(*) FILTER (WHERE state='unknown') AS "unknownCalls",
      count(*) FILTER (WHERE state IN ('pending','reserved')) AS "pendingCalls",
      coalesce(sum((record->>'quotaPages')::bigint) FILTER (WHERE kind='tencentCalls'),0) AS pages,
      coalesce(sum((record->>'inputTokens')::bigint),0) AS "inputTokens",
      coalesce(sum((record->>'outputTokens')::bigint),0) AS "outputTokens",
      count(*) FILTER (WHERE kind='modelCalls' AND (record->>'inputTokens' IS NULL OR record->>'outputTokens' IS NULL)) AS "unknownTokenCalls"
    '''
    async with auth.db().connection() as conn, conn.transaction():
        await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        totals = await (await conn.execute(CALLS + f'SELECT {aggregates} FROM calls WHERE true {where}', args)).fetchone()
        rows = await (await conn.execute(CALLS + f'SELECT day,user_id AS "userId",email,provider,kind,{aggregates} FROM calls WHERE true {where} GROUP BY day,user_id,email,provider,kind ORDER BY day DESC,user_id,provider,kind LIMIT 101 OFFSET %s', (*args, filters.offset))).fetchall()
    await auth.audit('usage_summary_read', filters.userId or 'provider')
    return {'totals': totals, 'items': rows[:100], 'hasMore': len(rows) > 100}


@router.get('/calls', response_model=list[AdministrationCall])
async def call_list(filters: Filters):
    where, args = call_where(filters)
    await auth.audit('usage_read', filters.userId or 'provider')
    return await auth.db().rows(CALLS + f'SELECT * FROM calls WHERE true {where} ORDER BY created_at DESC,call_key LIMIT 100 OFFSET %s', (*args, filters.offset))


@router.get('/task-search', response_model=AdministrationTaskList)
async def task_search(filters: Filters):
    if filters.issue not in {None, 'unknown', 'blocked', 'stalled', 'quota'}:
        raise HTTPException(422, {'code': 'INVALID_TASK_ISSUE'})
    state = filters.state or None
    if state and state not in task_api.FILTER_STATES:
        raise HTTPException(422, {'code': 'INVALID_TASK_STATE'})
    from .errors import DocumentProcessingError
    try:
        result = await task_api.list_tasks(limit=20, offset=filters.offset, state_filter=cast(task_api.TaskFilter | None, state), admin_filter=filters)
    except DocumentProcessingError as exc:
        raise HTTPException(exc.status_code, {'code': exc.code, 'message': exc.detail}) from exc
    ids = [row['threadId'] for row in result['items']]
    owners = await auth.db().rows('SELECT t.thread_id,t.owner_id,u.email FROM document_tasks t LEFT JOIN auth_users u ON u.id=t.owner_id WHERE t.thread_id=ANY(%s)', (ids,)) if ids else []
    mapped = {row['thread_id']: row for row in owners}
    await auth.audit('task_search', filters.userId or 'tasks')
    return {**result, 'nextCursor': None, 'items': [{**row, 'ownerId': mapped[row['threadId']]['owner_id'], 'ownerEmail': mapped[row['threadId']]['email']} for row in result['items']]}


def read_monitoring(path: Path | None) -> tuple[str, AdministrationMonitoring | None]:
    if path is None:
        return 'not_configured', None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise ValueError('Monitoring evidence must be a regular file')
            payload = handle.read(16_385)
        if len(payload) > 16_384:
            raise ValueError('Monitoring evidence is too large')
        value = AdministrationMonitoring.model_validate_json(payload)
        age = datetime.now(UTC) - value.observedAt
        if age < timedelta(seconds=-60):
            raise ValueError('Monitoring observation is in the future')
        return ('stale' if age > timedelta(minutes=15) else 'current'), value
    except (OSError, ValueError):
        return 'unavailable', None


@router.get('/operations', response_model=AdministrationOperations)
async def operations():
    from . import runtime
    from .cost_budget import NAMESPACE, now
    from .database import SCHEMA_VERSION
    from .execution import code_version
    from .storage import get_object_store
    service = runtime.current
    assert service is not None
    settings = load()
    runs = await auth.db().rows("SELECT status,count(*) AS n FROM document_runs WHERE status IN ('pending','running') GROUP BY status")
    outbox = (await auth.db().rows('SELECT count(*) AS n,coalesce(extract(epoch FROM now()-min(created_at)),0) AS age FROM document_outbox WHERE published_at IS NULL'))[0]
    health = None
    try:
        health = await (await asyncio.to_thread(get_object_store)).health()
    except (OSError, ValueError):
        pass
    daily = await service.db.store.aget(NAMESPACE, f'day:{now().date().isoformat()}', refresh_ttl=False)
    state, monitoring = await asyncio.to_thread(read_monitoring, settings.operations_status_file)
    delivery = getattr(service, 'delivery', None)
    await auth.audit('operations_read', 'service')
    return {'observedAt': datetime.now(UTC), 'codeVersion': code_version(), 'schemaVersion': SCHEMA_VERSION,
            'maintenance': settings.maintenance, 'readOnly': settings.read_only, 'accepting': service.accepting,
            'broker': {'publisher': bool(getattr(delivery, 'publisher_connected', False)), 'consumer': bool(getattr(delivery, 'consumer_connected', False))},
            'runs': {row['status']: row['n'] for row in runs}, 'outboxPending': outbox['n'], 'oldestPendingSeconds': max(0, float(outbox['age'])),
            'queueCapacity': settings.max_busy_threads, 'workersAvailable': max(0, settings.jobs_per_worker - len(getattr(service, 'active', {}))),
            'storageHealthy': health.healthy if health else None, 'storageFreeBytes': health.free_bytes if health else None,
            'modelId': settings.model_id, 'parserConfigured': settings.parser_configured,
            'costCurrency': settings.cost_currency, 'dailyCostLimitMicros': settings.cost_daily_limit,
            'dailyReservedMicros': (daily.value.get('reservedMicros') if daily else 0) if settings.cost_enabled else None, 'taskCostLimitMicros': settings.cost_task_limit,
            'monitoringState': state, 'monitoring': monitoring}
