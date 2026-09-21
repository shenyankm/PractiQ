"""Local SQLite task records, with separate LangGraph checkpoint and Store files."""

import asyncio
import fcntl
import json
import os
import sqlite3
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, LiteralString, cast

import aiosqlite
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.store.sqlite.aio import AsyncSqliteStore

from .config import database_dir

SCHEMA_VERSION = 1
DDL = """
CREATE TABLE document_tasks (
 thread_id text PRIMARY KEY, request_hash text NOT NULL, graph_id text NOT NULL,
 document text NOT NULL CHECK(json_valid(document)), failure_policy text NOT NULL, parent_thread_id text,
 created_at text NOT NULL DEFAULT (now()), expires_at text NOT NULL
);
CREATE TABLE document_runs (
 run_id text PRIMARY KEY, thread_id text NOT NULL REFERENCES document_tasks(thread_id),
 request_id text NOT NULL, input text, command text, context text NOT NULL,
 base_checkpoint text, status text NOT NULL DEFAULT 'pending', error_code text,
 cancel_requested integer NOT NULL DEFAULT 0, pause_requested integer NOT NULL DEFAULT 0,
 created_at text NOT NULL DEFAULT (now()), started_at text,
 deadline text, finished_at text,
 UNIQUE(thread_id, request_id)
);
CREATE UNIQUE INDEX document_active_run ON document_runs(thread_id) WHERE status IN ('pending','running');
CREATE INDEX document_queue ON document_runs(created_at) WHERE status = 'pending';
CREATE TABLE document_receipts (
 thread_id text NOT NULL REFERENCES document_tasks(thread_id), request_id text NOT NULL,
 fingerprint text NOT NULL, response text NOT NULL CHECK(json_valid(response)),
 PRIMARY KEY(thread_id, request_id)
);
"""
INDEX_DDL = """
CREATE INDEX IF NOT EXISTS document_task_order ON document_tasks(created_at DESC,thread_id DESC);
CREATE INDEX IF NOT EXISTS document_run_latest ON document_runs(thread_id,created_at DESC);
CREATE INDEX IF NOT EXISTS document_active_order ON document_runs(created_at) WHERE status IN ('pending','running');
"""
JSON_COLUMNS = {'document', 'input', 'command', 'context', 'response'}
DATE_COLUMNS = {'created_at', 'expires_at', 'started_at', 'deadline', 'finished_at'}
sqlite3.register_adapter(datetime, lambda value: value.astimezone(UTC).isoformat())


def task_row(cursor, values):
    row = dict(zip((column[0] for column in cursor.description), values, strict=True))
    for key, value in row.items():
        if value is not None:
            if key in JSON_COLUMNS:
                row[key] = json.loads(value)
            elif key in DATE_COLUMNS:
                row[key] = datetime.fromisoformat(value)
    return row


class Ownership:
    """Kernel releases the lock after a crash. Never unlink the lock file."""
    def __init__(self, path: Path):
        self.path = path
        self.file = path.open('a+b')
        try:
            fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            self.file.close()
            raise

    def check(self):
        stat = os.fstat(self.file.fileno())
        current = self.path.stat()
        if (stat.st_dev, stat.st_ino) != (current.st_dev, current.st_ino):
            raise RuntimeError('Database ownership file was replaced')

    async def close(self):
        self.file.close()


class Database:
    def __init__(self, directory: str | Path | None = None):
        self.directory = Path(directory) if directory is not None else database_dir()
        self.directory = self.directory.resolve()
        self.control_lock = asyncio.Lock()
        self.read_lock = asyncio.Lock()
        self.connections: list[aiosqlite.Connection] = []
        self.reader: aiosqlite.Connection | None = None
        self.checkpointer: AsyncSqliteSaver
        self.store: AsyncSqliteStore

    async def connect(self, filename: str, *, business: bool = False):
        conn = await aiosqlite.connect(self.directory / filename, isolation_level=None, timeout=5)
        try:
            await conn.execute('PRAGMA busy_timeout=5000')
            await conn.execute('PRAGMA journal_mode=WAL')
            await conn.execute('PRAGMA synchronous=FULL')
            await conn.execute('PRAGMA foreign_keys=ON')
            if business:
                conn.row_factory = cast(Any, task_row)
                await conn.create_function('now', 0, lambda: utcnow().isoformat())
            return conn
        except BaseException:
            await conn.close()
            raise

    async def open(self):
        if self.connections:
            return
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            for name in ('checkpoints.sqlite', 'store.sqlite'):
                self.connections.append(await self.connect(name))
            self.checkpointer = AsyncSqliteSaver(self.connections[0])
            self.store = AsyncSqliteStore(self.connections[1])
            self.reader = await self.connect('tasks.sqlite', business=True)
        except BaseException:
            await self.close()
            raise

    async def close(self):
        if self.reader is not None:
            await self.reader.close()
            self.reader = None
        while self.connections:
            await self.connections.pop().close()

    @asynccontextmanager
    async def connection(self):
        conn = await self.connect('tasks.sqlite', business=True)
        try:
            yield conn
        finally:
            await conn.close()

    async def rows(self, query: LiteralString, params: Any = ()) -> list[dict[str, Any]]:
        if self.reader is not None:
            # Finish each cursor before the next read, so concurrent reads cannot share a stale snapshot.
            async with self.read_lock, self.reader.execute(query, params) as cursor:
                return cast(list[dict[str, Any]], await cursor.fetchall())
        async with self.connection() as conn, conn.execute(query, params) as cursor:
            return cast(list[dict[str, Any]], await cursor.fetchall())

    async def ensure_indexes(self):
        # Additive indexes keep schema-1 databases and durable checkpoints compatible.
        async with self.connection() as conn:
            await conn.executescript(INDEX_DDL)

    async def check_schema(self):
        rows = await self.rows('PRAGMA user_version')
        if rows[0]['user_version'] != SCHEMA_VERSION:
            raise RuntimeError('Initialize a new dedicated database with python -m practiq_ai.manage init-db')
        for conn, required in zip(self.connections, ({'checkpoints', 'writes'}, {'store', 'store_migrations'}), strict=True):
            tables = await (await conn.execute("SELECT name FROM sqlite_master WHERE type='table'")).fetchall()
            if not required <= {row[0] for row in tables}:
                raise RuntimeError('Incomplete SQLite state; restore the entire database directory before starting')


    @asynccontextmanager
    async def transaction(self):
        async with self.control_lock, self.connection() as conn:
            await conn.execute('BEGIN IMMEDIATE')
            try:
                yield conn
                await conn.commit()
            except BaseException:
                await conn.rollback()
                raise

    async def initialize(self):
        async with self.connection() as conn:
            names = {row['name'] for row in await (await conn.execute("SELECT name FROM sqlite_master WHERE type='table'")).fetchall()}
            if names and names != {'practiq_initialization'}:
                raise RuntimeError('Initialization requires an empty dedicated database; existing data is untouched')
            if names:
                marker = await (await conn.execute('SELECT version FROM practiq_initialization')).fetchall()
                if marker != [{'version': SCHEMA_VERSION}]:
                    raise RuntimeError('Initialization requires an empty dedicated database')
            else:
                # A foreign checkpoint/Store file must never be adopted by a fresh task database.
                for other in self.connections:
                    tables = await (await other.execute("SELECT name FROM sqlite_master WHERE type='table'")).fetchall()
                    if tables:
                        raise RuntimeError('Initialization requires an empty dedicated database')
                await conn.executescript(f'BEGIN IMMEDIATE; CREATE TABLE practiq_initialization(version INTEGER); INSERT INTO practiq_initialization VALUES({SCHEMA_VERSION}); COMMIT;')
            await self.checkpointer.setup()
            await self.store.setup()
            try:
                await conn.executescript(f'BEGIN IMMEDIATE; {DDL} {INDEX_DDL} PRAGMA user_version={SCHEMA_VERSION}; DROP TABLE practiq_initialization; COMMIT;')
            except BaseException:
                await conn.rollback()
                raise

    def acquire(self, message: str = 'Another service already owns this database') -> Ownership:
        try:
            return Ownership(self.directory / 'owner.lock')
        except BlockingIOError as exc:
            raise RuntimeError(message) from exc


def utcnow() -> datetime:
    return datetime.now(UTC)


async def watch_ownership(owner: Ownership, lost):
    try:
        while True:
            await asyncio.sleep(0.5)
            owner.check()
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - ownership loss must stop every writer
        lost()
