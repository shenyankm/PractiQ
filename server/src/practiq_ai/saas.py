"""Account-token identities and durable, integer-point import accounting."""

import asyncio
import hashlib
import re
from contextvars import ContextVar
from decimal import Decimal, InvalidOperation
from json import dumps as json_encode
from typing import Any
from weakref import WeakValueDictionary

from langgraph.types import interrupt

from .contracts import DocumentReference, DocumentUploadRequest
from .errors import DocumentProcessingError

ACCOUNT: ContextVar[str | None] = ContextVar('import_account', default=None)
UPLOAD_LOCKS: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
SCALE = 1_000_000
BIGINT_MIN = -(2**63)
BIGINT_MAX = 2**63 - 1
DDL = """
CREATE TABLE import_accounts (
 account_id text PRIMARY KEY, phone text UNIQUE NOT NULL, balance bigint NOT NULL DEFAULT 0
);
CREATE TABLE import_products (
 product_id text PRIMARY KEY, name text NOT NULL, points bigint NOT NULL CHECK(points>0),
 purchase_url text NOT NULL, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE import_ledger (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 account_id text NOT NULL REFERENCES import_accounts(account_id), amount bigint NOT NULL,
 kind text NOT NULL, reference text NOT NULL, note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,kind,reference)
);
CREATE TABLE import_uploads (
 account_id text NOT NULL REFERENCES import_accounts(account_id), object_key text NOT NULL,
 sha256 text NOT NULL, media_type text NOT NULL, size_bytes bigint NOT NULL,
 verified boolean NOT NULL DEFAULT false,
 PRIMARY KEY(account_id,object_key)
);
CREATE TABLE import_calls (
 call_key text PRIMARY KEY, account_id text NOT NULL REFERENCES import_accounts(account_id),
 thread_id text NOT NULL, result_key text, rates jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','unknown','settled','rejected')),
 dispatched boolean NOT NULL DEFAULT false, usage jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX import_account_call ON import_calls(account_id) WHERE status IN ('pending','unknown');
CREATE INDEX import_call_task ON import_calls(thread_id);
ALTER TABLE document_tasks ADD COLUMN account_id text REFERENCES import_accounts(account_id);
ALTER TABLE document_tasks ADD COLUMN billing_rates jsonb;
CREATE INDEX document_account_order ON document_tasks(account_id,created_at DESC,thread_id DESC);
"""
TOKEN_DDL = """CREATE TABLE import_account_tokens (
 digest text PRIMARY KEY, account_id text NOT NULL REFERENCES import_accounts(account_id),
 revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
"""
DDL += TOKEN_DDL
TABLES = {'import_accounts', 'import_products', 'import_account_tokens', 'import_ledger', 'import_ledger_id_seq', 'import_uploads', 'import_calls'}


def failure(code: str, status: int = 409) -> DocumentProcessingError:
    return DocumentProcessingError(status, code.replace('_', ' ').capitalize(), code)


def phone(value: str) -> str:
    value = value.strip()
    if re.fullmatch(r'1[3-9][0-9]{9}', value):
        value = '+86' + value
    if not re.fullmatch(r'\+[1-9][0-9]{6,14}', value):
        raise failure('INVALID_PHONE', 422)
    return value


def token_digest(value: str) -> str:
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', value):
        raise failure('INVALID_ACCOUNT_ACCESS', 401)
    return hashlib.sha256(value.encode('ascii')).hexdigest()


def points(value: str) -> int:
    try:
        number = Decimal(value)
        scaled = number * SCALE
        if not number.is_finite() or number <= 0 or scaled != scaled.to_integral_value() or scaled > 10**15:
            raise ValueError('Invalid points')
        return int(scaled)
    except (InvalidOperation, ValueError, OverflowError) as exc:
        raise ValueError('Points must be positive with at most six decimal places') from exc


def db():
    from .task_api import client
    return client().db


async def identity(number: str, credential: str, *, database=None) -> str:
    rows = await (database or db()).rows('SELECT a.account_id FROM import_accounts a JOIN import_account_tokens c USING(account_id) '
                                        'WHERE a.phone=%s AND c.digest=%s AND NOT c.revoked', (phone(number), token_digest(credential)))
    if not rows:
        raise failure('INVALID_ACCOUNT_ACCESS', 401)
    return rows[0]['account_id']


async def credit(conn, account: str, amount: int, kind: str, reference: str, note: str = '') -> None:
    balance = await (await conn.execute('SELECT balance FROM import_accounts WHERE account_id=%s FOR UPDATE', (account,))).fetchone()
    assert balance is not None
    if await (await conn.execute('SELECT 1 FROM import_ledger WHERE account_id=%s AND kind=%s AND reference=%s', (account, kind, reference))).fetchone():
        return
    if not BIGINT_MIN <= amount <= BIGINT_MAX or not BIGINT_MIN <= balance['balance'] + amount <= BIGINT_MAX:
        raise failure('POINT_BALANCE_LIMIT')
    row = await (await conn.execute('INSERT INTO import_ledger(account_id,amount,kind,reference,note) '
                                    'VALUES(%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING id',
                                    (account, amount, kind, reference, note))).fetchone()
    if row:
        await conn.execute('UPDATE import_accounts SET balance=balance+%s WHERE account_id=%s', (amount, account))


async def account_summary(account: str, *, conn=None, database=None) -> dict[str, Any]:
    query = "SELECT phone,balance,EXISTS(SELECT 1 FROM import_calls c WHERE c.account_id=a.account_id AND status='unknown') AS blocked FROM import_accounts a WHERE account_id=%s"
    if conn:
        row = await (await conn.execute(query, (account,))).fetchone()
    else:
        row = (await (database or db()).rows(query, (account,)))[0]
    assert row is not None
    return {'phone': row['phone'], 'balanceMicropoints': row['balance'], 'usageUnknown': row['blocked']}


async def products() -> dict[str, Any]:
    rows = await db().rows('SELECT product_id,name,points,purchase_url FROM import_products WHERE enabled ORDER BY product_id')
    return {'items': [{'productId': r['product_id'], 'name': r['name'], 'pointsMicropoints': r['points'], 'purchaseUrl': r['purchase_url']} for r in rows]}


async def ledger(account: str, limit: int, before: int | None) -> dict[str, Any]:
    rows = await db().rows('SELECT id,amount,kind,created_at FROM import_ledger WHERE account_id=%s '
                           'AND (%s::bigint IS NULL OR id<%s) ORDER BY id DESC LIMIT %s', (account, before, before, limit + 1))
    return {'items': [{'id': r['id'], 'amountMicropoints': r['amount'], 'kind': r['kind'], 'createdAt': r['created_at'].isoformat()} for r in rows[:limit]],
            'nextBefore': rows[limit - 1]['id'] if len(rows) > limit else None}


def require_owner(task: dict[str, Any]) -> None:
    if task['account_id'] != ACCOUNT.get():
        raise failure('TASK_NOT_FOUND', 404)


async def owns_upload(reference: DocumentReference) -> bool:
    return bool(await db().rows('SELECT 1 FROM import_uploads WHERE account_id=%s AND object_key=%s '
                                'AND sha256=%s AND size_bytes=%s AND media_type=%s AND verified',
                                (ACCOUNT.get(), reference.objectKey, reference.sha256, reference.sizeBytes, reference.mediaType)))


async def register_upload(reference: DocumentReference) -> None:
    async with db().transaction() as conn:
        await conn.execute('INSERT INTO import_uploads(account_id,object_key,sha256,media_type,size_bytes,verified) VALUES(%s,%s,%s,%s,%s,true) '
                           'ON CONFLICT(account_id,object_key) DO UPDATE SET verified=true,sha256=excluded.sha256,media_type=excluded.media_type,size_bytes=excluded.size_bytes',
                           (ACCOUNT.get(), reference.objectKey, reference.sha256, reference.mediaType, reference.sizeBytes))


async def store_upload(store, payload: bytes, request: DocumentUploadRequest) -> DocumentReference:
    from .config import load
    from .contracts import document_source_key
    from .storage import verify_payload
    account = ACCOUNT.get()
    assert account is not None
    reference = DocumentReference(**request.model_dump(), objectKey=document_source_key(request.sourceType, request.sha256 or ''))
    await verify_payload(reference, payload)
    lock = UPLOAD_LOCKS.get(account) or asyncio.Lock()
    UPLOAD_LOCKS[account] = lock
    async with lock:
        async with db().transaction() as conn:
            row = await (await conn.execute('SELECT size_bytes,verified FROM import_uploads WHERE account_id=%s AND object_key=%s', (account, reference.objectKey))).fetchone()
            if not row or not row['verified']:
                usage = await (await conn.execute('SELECT coalesce(sum(size_bytes),0) AS bytes,count(*) AS files FROM import_uploads WHERE account_id=%s', (account,))).fetchone()
                assert usage is not None
                settings = load()
                extra = max(0, reference.sizeBytes - (row['size_bytes'] if row else 0))
                if usage['bytes'] + extra > settings.account_upload_max_bytes or usage['files'] + (0 if row else 1) > settings.account_upload_max_files:
                    raise failure('ACCOUNT_UPLOAD_QUOTA', 413)
                await conn.execute('INSERT INTO import_uploads(account_id,object_key,sha256,media_type,size_bytes,verified) VALUES(%s,%s,%s,%s,%s,false) '
                                   'ON CONFLICT(account_id,object_key) DO UPDATE SET size_bytes=greatest(import_uploads.size_bytes,excluded.size_bytes)',
                                   (account, reference.objectKey, reference.sha256, reference.mediaType, reference.sizeBytes))
        # Keep failed/uncertain reservations charged to storage; they never prove ownership.
        document = await store.put_document(payload, request)
        await register_upload(document)
        return document


async def prepare_upload(request: DocumentUploadRequest):
    from urllib.parse import urlencode

    from .config import load
    from .contracts import DocumentUploadResponse, LocalUpload, document_source_key
    from .storage import get_object_store, validate_source_size
    assert request.sha256 and request.sizeBytes and request.mediaType
    validate_source_size(request.sizeBytes, request.sourceType, load())
    reference = DocumentReference(**request.model_dump(), objectKey=document_source_key(request.sourceType, request.sha256))
    if await owns_upload(reference):
        try:
            await get_object_store().get_verified(reference)
        except DocumentProcessingError as exc:
            if exc.code != 'OBJECT_NOT_FOUND':
                raise
        else:
            return DocumentUploadResponse(document=reference, upload=None)
    return DocumentUploadResponse(document=reference, upload=LocalUpload(url='/api/uploads/content?' + urlencode(request.model_dump(exclude_none=True)), headers={'Content-Type': request.mediaType}))


async def task_billing(task: dict[str, Any]) -> dict[str, Any] | None:
    if not task['account_id']:
        return None
    account = await account_summary(task['account_id'])
    rows = await db().rows("SELECT coalesce(sum(-l.amount),0) AS charged FROM import_ledger l JOIN import_calls c ON c.call_key=l.reference WHERE c.thread_id=%s AND l.account_id=%s AND l.kind='model'", (task['thread_id'], task['account_id']))
    return {**account, 'chargedMicropoints': rows[0]['charged'], 'rates': task['billing_rates']}


async def begin_call(runtime, call_key: str, result_key: str | None) -> bool:
    from .execution import CURRENT_EXECUTION
    if not (CURRENT_EXECUTION.get() or {}).get('accountId'):
        return False
    if not runtime or not runtime.execution_info:
        return False
    rows = await db().rows('SELECT account_id,billing_rates FROM document_tasks WHERE thread_id=%s', (runtime.execution_info.thread_id,))
    if not rows or not rows[0]['account_id']:
        return False
    task = rows[0]
    while True:
        waiting = False
        async with db().transaction() as conn:
            account = await (await conn.execute('SELECT balance FROM import_accounts WHERE account_id=%s FOR UPDATE', (task['account_id'],))).fetchone()
            active = await (await conn.execute("SELECT status FROM import_calls WHERE account_id=%s AND status IN ('pending','unknown')", (task['account_id'],))).fetchone()
            if active and active['status'] == 'unknown':
                interrupt({'kind': 'billing', 'code': 'USAGE_UNKNOWN'})
                waiting = True
            elif active:
                waiting = True
            elif account is None or account['balance'] <= 0:
                interrupt({'kind': 'billing', 'code': 'INSUFFICIENT_POINTS'})
                waiting = True
            else:
                await conn.execute("INSERT INTO import_calls(call_key,account_id,thread_id,result_key,rates,status) VALUES(%s,%s,%s,%s,%s,'pending')",
                                   (call_key, task['account_id'], runtime.execution_info.thread_id, result_key, json_encode(task['billing_rates'])))
        if not waiting:
            return True
        await asyncio.sleep(.05)


async def dispatched(call_key: str) -> None:
    async with db().transaction() as conn:
        await conn.execute('UPDATE import_calls SET dispatched=true WHERE call_key=%s', (call_key,))


def charge(usage: dict[str, Any], rates: dict[str, int]) -> int:
    total = usage['inputTokens'] * rates['inputMicropointsPer1k'] + usage['outputTokens'] * rates['outputMicropointsPer1k']
    return (total + 999) // 1000


async def settle(call_key: str, usage: dict[str, Any] | None, *, rejected: bool = False, note: str = '', database=None) -> None:
    async with (database or db()).transaction() as conn:
        row = await (await conn.execute('SELECT * FROM import_calls WHERE call_key=%s FOR UPDATE', (call_key,))).fetchone()
        if (row and row['status'] == 'settled' and note and usage is not None
                and any(row['usage'].get(key) != usage.get(key) for key in ('inputTokens', 'outputTokens'))):
            raise ValueError('Call was already resolved with different usage')
        if not row or row['status'] in {'settled', 'rejected'}:
            return
        status = 'rejected' if rejected else 'settled' if usage is not None else 'unknown'
        if usage is not None:
            await credit(conn, row['account_id'], -charge(usage, row['rates']), 'model', call_key, note)
        await conn.execute('UPDATE import_calls SET status=%s,usage=%s WHERE call_key=%s', (status, json_encode(usage), call_key))


async def reconcile(database) -> None:
    from .execution import namespace
    for row in await database.rows("SELECT * FROM import_calls WHERE status IN ('pending','unknown')"):
        saved = await database.store.aget(namespace(row['thread_id'], 'model_results'), row['result_key'], refresh_ttl=False) if row['result_key'] else None
        usage = saved.value.get('usage') if saved else None
        if usage is not None or row['status'] == 'pending':
            await settle(row['call_key'], usage, rejected=not row['dispatched'], database=database)


async def cleanup_task_store(database, thread_id: str) -> None:
    from .execution import namespace
    unresolved = await database.rows("SELECT call_key,result_key FROM import_calls WHERE thread_id=%s AND status IN ('pending','unknown')", (thread_id,))
    retained = {(namespace(thread_id, kind), row[key]) for row in unresolved
                for kind, key in (('calls', 'call_key'), ('model_results', 'result_key')) if row[key]}
    offset = 0
    while items := await database.store.asearch(namespace(thread_id, '')[:2], limit=100, offset=offset, refresh_ttl=False):
        for item in items:
            if (item.namespace, item.key) in retained:
                offset += 1
            else:
                await database.store.adelete(item.namespace, item.key)
