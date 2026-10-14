"""PostgreSQL task records, LangGraph checkpoints, Store and grading receipts."""

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any, LiteralString

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.store.postgres.aio import AsyncPostgresStore
from psycopg import AsyncConnection
from psycopg.rows import dict_row

from .config import database_uri
from .saas import DDL as SAAS_DDL
from .saas import TABLES as SAAS_TABLES
from .saas import TOKEN_DDL

SCHEMA_VERSION = 4
# Separate session ownership from short API transactions, scoped to this database.
LOCK_NAMESPACE = 817241
DDL = """
CREATE TABLE practiq_schema(version integer NOT NULL);
INSERT INTO practiq_schema VALUES (4);
CREATE TABLE document_tasks (
 thread_id text PRIMARY KEY, request_hash text NOT NULL, graph_id text NOT NULL,
 document jsonb NOT NULL, failure_policy text NOT NULL, parent_thread_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL
);
CREATE TABLE document_runs (
 run_id text PRIMARY KEY, thread_id text NOT NULL REFERENCES document_tasks(thread_id),
 request_id text NOT NULL, input jsonb, command jsonb, context jsonb NOT NULL,
 base_checkpoint text, status text NOT NULL DEFAULT 'pending', error_code text,
 cancel_requested boolean NOT NULL DEFAULT false, pause_requested boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), started_at timestamptz,
 deadline timestamptz, finished_at timestamptz,
 UNIQUE(thread_id, request_id)
);
CREATE UNIQUE INDEX document_active_run ON document_runs(thread_id) WHERE status IN ('pending','running');
CREATE TABLE document_receipts (
 thread_id text NOT NULL REFERENCES document_tasks(thread_id), request_id text NOT NULL,
 fingerprint text NOT NULL, response jsonb NOT NULL,
 PRIMARY KEY(thread_id, request_id)
);
CREATE TABLE grades(id text PRIMARY KEY, digest text NOT NULL, response jsonb);
CREATE TABLE grade_calls (
 grade_id text NOT NULL REFERENCES grades(id), call_key text NOT NULL, record jsonb NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 PRIMARY KEY(grade_id,call_key)
);
"""
OUTBOX_DDL = """
CREATE TABLE document_outbox (
 run_id text PRIMARY KEY REFERENCES document_runs(run_id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), published_at timestamptz
);
CREATE INDEX document_outbox_pending ON document_outbox(created_at) WHERE published_at IS NULL;
"""
DDL += OUTBOX_DDL
DDL += SAAS_DDL
INDEX_DDL = """
CREATE INDEX IF NOT EXISTS document_task_order ON document_tasks(created_at DESC,thread_id DESC);
CREATE INDEX IF NOT EXISTS document_run_latest ON document_runs(thread_id,created_at DESC);
CREATE INDEX IF NOT EXISTS document_active_order ON document_runs(created_at) WHERE status IN ('pending','running');
"""
STATE_TABLES = {'checkpoints', 'checkpoint_blobs', 'checkpoint_writes', 'checkpoint_migrations', 'store', 'store_migrations'}
TASK_TABLES = {'practiq_schema', 'document_tasks', 'document_runs', 'document_receipts', 'grades', 'grade_calls', 'grade_calls_sequence_seq', 'document_outbox'}
TASK_TABLES |= SAAS_TABLES


class Ownership:
    """PostgreSQL releases session ownership when the connection dies."""

    def __init__(self, connection: AsyncConnection[dict[str, Any]], slot: int = 1):
        self.connection, self.slot = connection, slot

    async def check(self):
        row = await (await self.connection.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() "
            "AND classid=%s AND objid=%s AND objsubid=2 AND granted) AS owned", (LOCK_NAMESPACE, self.slot),
        )).fetchone()
        if not row or not row['owned']:
            raise RuntimeError('Database ownership was lost')

    async def close(self):
        await self.connection.close()


class Database:
    def __init__(self, uri: str | None = None):
        self.uri = uri if uri is not None else database_uri()
        self.control_lock = asyncio.Lock()
        self.read_lock = asyncio.Lock()
        self.connections: list[AsyncConnection[dict[str, Any]]] = []
        self.reader: AsyncConnection[dict[str, Any]] | None = None
        self.checkpointer: AsyncPostgresSaver
        self.store: AsyncPostgresStore

    async def connect(self):
        return await AsyncConnection[dict[str, Any]].connect(
            self.uri, autocommit=True, prepare_threshold=0, row_factory=dict_row,
            connect_timeout=5, options='-c search_path=public -c timezone=UTC -c lock_timeout=5000 -c synchronous_commit=on',
        )

    async def open(self):
        if self.connections:
            return
        try:
            for _ in range(2):
                self.connections.append(await self.connect())
            self.checkpointer = AsyncPostgresSaver(self.connections[0])
            self.store = AsyncPostgresStore(self.connections[1])
            self.reader = await self.connect()
        except BaseException:
            await self.close()
            raise

    async def close(self):
        # Upstream Store has no close API; reap its batch worker before closing the connection.
        store = getattr(self, 'store', None)
        if store is not None and store._task is not None:
            store._task.cancel()
            await asyncio.gather(store._task, return_exceptions=True)
        if self.reader is not None:
            await self.reader.close()
            self.reader = None
        while self.connections:
            await self.connections.pop().close()

    @asynccontextmanager
    async def connection(self):
        async with await self.connect() as conn:
            yield conn

    async def rows(self, query: LiteralString, params: Any = ()) -> list[dict[str, Any]]:
        if self.reader is not None:
            # Finish each cursor before the next read so reads have independent snapshots.
            async with self.read_lock, self.reader.cursor() as cursor:
                await cursor.execute(query, params)
                return await cursor.fetchall()
        async with self.connection() as conn, conn.cursor() as cursor:
            await cursor.execute(query, params)
            return await cursor.fetchall()

    async def ensure_indexes(self):
        async with self.connection() as conn:
            await conn.execute(INDEX_DDL, prepare=False)

    async def checkpoint_heads(self, thread_ids: list[str]) -> dict[str, str]:
        # Read only primary-key metadata, never the serialized checkpoint payload.
        async with self.checkpointer.lock, self.connections[0].cursor() as cursor:
            await cursor.execute(
                "SELECT DISTINCT ON (thread_id) thread_id,checkpoint_id FROM checkpoints "
                "WHERE thread_id=ANY(%s) AND checkpoint_ns='' ORDER BY thread_id,checkpoint_id DESC",
                (thread_ids,),
            )
            return {row['thread_id']: row['checkpoint_id'] for row in await cursor.fetchall()}

    async def tables(self) -> set[str]:
        return {row['name'] for row in await self.rows(
            "SELECT CASE WHEN n.nspname='public' THEN c.relname ELSE n.nspname||'.'||c.relname END AS name "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname !~ '^pg_' AND n.nspname!='information_schema' AND c.relkind IN ('r','p','v','m','f','S')"
        )}

    async def check_schema(self):
        tables = await self.tables()
        if 'practiq_schema' not in tables or await self.rows('SELECT version FROM practiq_schema') != [{'version': SCHEMA_VERSION}]:
            raise RuntimeError('Unsupported service schema; use init-db only for an empty database, or upgrade-db for schema 1, 2 or 3')
        if not STATE_TABLES | TASK_TABLES <= tables:
            raise RuntimeError('Incomplete PostgreSQL state; restore the entire service database before starting')
        if not await self.upload_verification_column():
            raise RuntimeError('Upload ownership requires an explicit offline upgrade-db')

    async def upload_verification_column(self):
        return bool(await self.rows("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='import_uploads' AND column_name='verified' AND data_type='boolean'"))

    @asynccontextmanager
    async def transaction(self):
        async with self.control_lock, self.connection() as conn, conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(%s,2)', (LOCK_NAMESPACE,))
            yield conn

    async def initialize(self):
        names = await self.tables()
        if names:
            if not names <= STATE_TABLES | {'practiq_initialization'} or 'practiq_initialization' not in names:
                raise RuntimeError('Initialization requires an empty dedicated database; existing data is untouched')
            if await self.rows('SELECT version FROM practiq_initialization') != [{'version': SCHEMA_VERSION}]:
                raise RuntimeError('Initialization requires an empty dedicated database')
        else:
            async with self.transaction() as conn:
                await conn.execute('CREATE TABLE practiq_initialization(version integer NOT NULL)')
                await conn.execute('INSERT INTO practiq_initialization VALUES (%s)', (SCHEMA_VERSION,))
        # Upstream setup creates concurrent indexes outside a transaction. Keep the marker for retry.
        await self.checkpointer.setup()
        await self.store.setup()
        async with self.transaction() as conn:
            await conn.execute(DDL, prepare=False)
            await conn.execute(INDEX_DDL, prepare=False)
            await conn.execute('DROP TABLE practiq_initialization')

    async def upgrade(self):
        """Called only with offline runtime ownership; schema changes are atomic."""
        tables = await self.tables()
        if 'practiq_schema' not in tables:
            raise RuntimeError('Upgrade requires an initialized service database')
        versions = await self.rows('SELECT version FROM practiq_schema')
        if versions == [{'version': SCHEMA_VERSION}]:
            if not STATE_TABLES | TASK_TABLES <= tables:
                raise RuntimeError('Upgrade requires complete PostgreSQL state')
            if not await self.upload_verification_column():
                async with self.transaction() as conn:
                    await conn.execute('ALTER TABLE import_uploads ADD COLUMN verified boolean NOT NULL DEFAULT true')
                    await conn.execute('ALTER TABLE import_uploads ALTER COLUMN verified SET DEFAULT false')
            await self.check_schema()
            return
        version = versions[0]['version'] if len(versions) == 1 else None
        required = TASK_TABLES - SAAS_TABLES - ({'document_outbox'} if version == 1 else set())
        if version == 3:
            legacy_saas = SAAS_TABLES - {'import_account_tokens'} | {'import_cards'}
            if 'import_account_tokens' in tables or not STATE_TABLES | required | legacy_saas <= tables:
                raise RuntimeError('Upgrade requires complete service schema 3')
        elif version not in {1, 2} or tables & SAAS_TABLES or not STATE_TABLES | required <= tables:
            raise RuntimeError('Upgrade supports only complete service schema 1, 2 or 3')
        async with self.transaction() as conn:
            if version == 1:
                await conn.execute(OUTBOX_DDL, prepare=False)
                await conn.execute('DROP INDEX IF EXISTS document_queue')
            if version == 3:
                await conn.execute(TOKEN_DDL, prepare=False)
                if not await self.upload_verification_column():
                    await conn.execute('ALTER TABLE import_uploads ADD COLUMN verified boolean NOT NULL DEFAULT true')
                    await conn.execute('ALTER TABLE import_uploads ALTER COLUMN verified SET DEFAULT false')
            else:
                await conn.execute(SAAS_DDL, prepare=False)
            await conn.execute('UPDATE practiq_schema SET version=%s', (SCHEMA_VERSION,))

    async def acquire(self, message: str = 'Another service already owns this database', *, slot: int = 1) -> Ownership:
        conn = await self.connect()
        try:
            row = await (await conn.execute('SELECT pg_try_advisory_lock(%s,%s) AS owned', (LOCK_NAMESPACE, slot))).fetchone()
            if not row or not row['owned']:
                raise RuntimeError(message)
            return Ownership(conn, slot)
        except BaseException:
            await conn.close()
            raise


def utcnow() -> datetime:
    return datetime.now(UTC)


async def watch_ownership(owner: Ownership, lost):
    try:
        while True:
            await asyncio.sleep(0.5)
            async with asyncio.timeout(2):
                await owner.check()
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - ownership loss must stop every writer
        lost()
