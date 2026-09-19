"""PostgreSQL task records; LangGraph owns checkpoint and Store tables."""

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any, LiteralString

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.store.postgres import AsyncPostgresStore
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool

from .config import database_uri

SCHEMA_VERSION = 'practiq-oss-1'
INSTANCE_LOCK = 728194602
ADMISSION_LOCK = 728194603
DDL = """
CREATE TABLE document_tasks (
 thread_id text PRIMARY KEY, request_hash text NOT NULL, graph_id text NOT NULL,
 document jsonb NOT NULL, failure_policy text NOT NULL, parent_thread_id text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
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
CREATE INDEX document_queue ON document_runs(created_at) WHERE status = 'pending';
CREATE TABLE document_receipts (
 thread_id text NOT NULL REFERENCES document_tasks(thread_id), request_id text NOT NULL,
 fingerprint text NOT NULL, response jsonb NOT NULL,
 PRIMARY KEY(thread_id, request_id)
);
COMMENT ON TABLE document_tasks IS 'practiq-oss-1';
"""


class Database:
    def __init__(self, uri: str | None = None):
        self.uri = uri or database_uri()
        self.control_lock = asyncio.Lock()
        self.pool = AsyncConnectionPool[AsyncConnection[DictRow]](self.uri, open=False, min_size=1, max_size=16,
                                       timeout=5, kwargs={'autocommit': True, 'prepare_threshold': 0, 'row_factory': dict_row})
        self.checkpointer = AsyncPostgresSaver(self.pool)
        self.store = AsyncPostgresStore(self.pool)

    async def open(self):
        await self.pool.open(wait=True)

    async def close(self):
        await self.pool.close()

    async def rows(self, query: LiteralString, params: Any = ()) -> list[dict[str, Any]]:
        async with self.pool.connection() as conn:
            return await (await conn.execute(query, params)).fetchall()

    async def check_schema(self):
        rows = await self.rows("SELECT obj_description(to_regclass('document_tasks')) AS version")
        if rows[0]['version'] != SCHEMA_VERSION:
            raise RuntimeError('Initialize a new dedicated database with python -m practiq_ai.manage init-db')

    @asynccontextmanager
    async def transaction(self):
        async with self.control_lock, self.pool.connection() as conn, conn.transaction():
            # All short admission/control transactions serialize; graph work never holds this lock.
            await conn.execute('SELECT pg_advisory_xact_lock(%s)', (ADMISSION_LOCK,))
            yield conn

    async def initialize(self):
        async with self.pool.connection() as conn:
            tables = await (await conn.execute("SELECT relname AS tablename FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind IN ('r','p','v','m','S','f')")).fetchall()
            names = {row['tablename'] for row in tables}
            owned = {'practiq_initialization', 'checkpoint_migrations', 'checkpoints', 'checkpoint_blobs',
                     'checkpoint_writes', 'store', 'store_migrations'}
            marker = await (await conn.execute("SELECT obj_description(to_regclass('practiq_initialization')) AS version")).fetchone()
            if names and (not names <= owned or not marker or marker['version'] != SCHEMA_VERSION):
                raise RuntimeError('Initialization requires an empty dedicated database; existing data is untouched')
            if not names:
                async with conn.transaction():
                    await conn.execute("CREATE TABLE practiq_initialization (id boolean PRIMARY KEY)")
                    await conn.execute("COMMENT ON TABLE practiq_initialization IS 'practiq-oss-1'")
            await self.checkpointer.setup()
            await self.store.setup()
            # Business DDL and removal of the initialization marker commit together.
            async with conn.transaction():
                await conn.execute(DDL, prepare=False)
                await conn.execute('DROP TABLE practiq_initialization')

    async def lock_connection(self) -> AsyncConnection[DictRow]:
        return await AsyncConnection[DictRow].connect(self.uri, autocommit=True, row_factory=dict_row,
                                             connect_timeout=5, keepalives=1, keepalives_idle=5,
                                             keepalives_interval=2, keepalives_count=2)


def utcnow() -> datetime:
    return datetime.now(UTC)


async def watch_ownership(conn, lost):
    """A lost lock session must stop every writer, including maintenance threads."""
    try:
        while True:
            await asyncio.sleep(0.5)
            async with asyncio.timeout(2):
                await conn.execute('SELECT 1')
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - fail closed without logging database credentials
        lost()
