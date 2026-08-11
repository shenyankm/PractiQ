"""PostgreSQL pool and schema apply/seed.

Mirrors backend/internal/db/{pool,config,runtime}.go using psycopg v3 async pool.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

from psycopg_pool import AsyncConnectionPool

from . import config

_pool: AsyncConnectionPool | None = None


def open_pool() -> AsyncConnectionPool:
    global _pool
    if _pool is not None:
        return _pool
    cfg = config.load_db_config()
    _pool = AsyncConnectionPool(
        conninfo=cfg.database_url,
        min_size=1,
        max_size=cfg.max_conns,
        max_idle=cfg.idle_timeout_seconds,
        timeout=cfg.connect_timeout_seconds,
        open=False,
    )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def check_postgres(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        await conn.execute('SELECT 1')


def _sql_file_order(path: Path) -> tuple[int, str, str]:
    match = re.match(r'(\d+)_', path.name)
    order = int(match.group(1)) if match else 1 << 30
    return order, path.name, str(path)


def collect_sql_files(root: Path) -> list[Path]:
    matches = list(root.glob('db/*/*.sql'))
    matches.sort(key=_sql_file_order)
    return matches


async def run_apply(root: Path, pool: AsyncConnectionPool) -> int:
    files = collect_sql_files(root)
    for path in files:
        script = path.read_text()
        try:
            async with pool.connection() as conn:
                await conn.execute(script)
        except Exception as exc:
            raise RuntimeError(f'apply {path}: {exc}') from exc
    return len(files)


SEED_ADMIN_USERNAME = 'admin'
SEED_ADMIN_EMAIL = 'admin@practiq.local'
DEFAULT_SEED_PASSWORD = 'PractiQ123'
SEED_BANK_NAME = 'PractiQ 示例题库'
SEED_BANK_DESCRIPTION = '用于本地验证题库、题目、练习闭环。'
SEED_BANK_SUBJECT = 'general'


async def run_seed(pool: AsyncConnectionPool, seed_password: str) -> None:
    import bcrypt  # local import: only needed for seeding

    password_hash = bcrypt.hashpw(seed_password.encode(), bcrypt.gensalt(rounds=10)).decode()
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                """
                INSERT INTO users (username, email, password_hash, role, membership)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT ((LOWER(username))) DO UPDATE
                SET email = EXCLUDED.email,
                    role = EXCLUDED.role,
                    membership = EXCLUDED.membership
                RETURNING id
                """,
                (SEED_ADMIN_USERNAME, SEED_ADMIN_EMAIL, password_hash, 'admin', 'free'),
            )
            row = await cursor.fetchone()
            user_id = row[0]

            cursor = await conn.execute(
                'SELECT id FROM question_banks WHERE created_by = %s AND name = %s LIMIT 1',
                (user_id, SEED_BANK_NAME),
            )
            row = await cursor.fetchone()
            if row is None:
                cursor = await conn.execute(
                    """
                    INSERT INTO question_banks (name, description, subject, created_by, is_public)
                    VALUES (%s, %s, %s, %s, true)
                    RETURNING id
                    """,
                    (SEED_BANK_NAME, SEED_BANK_DESCRIPTION, SEED_BANK_SUBJECT, user_id),
                )
                row = await cursor.fetchone()
            bank_id = row[0]

            await conn.execute(
                """
                INSERT INTO user_bank_links (user_id, bank_id, is_owner)
                VALUES (%s, %s, true)
                ON CONFLICT (user_id, bank_id) DO UPDATE SET is_owner = true
                """,
                (user_id, bank_id),
            )


def execute_sync(target: str, root: Path, seed_password: str) -> str:
    """Synchronous entry for the admin CLI (python -m server.admin)."""

    async def _run() -> str:
        pool = open_pool()
        try:
            await pool.open()
            if target == 'db apply':
                count = await run_apply(root, pool)
                return f'Applied {count} SQL files.'
            if target == 'db seed':
                await run_seed(pool, seed_password)
                return (
                    f'PractiQ seed complete. User: {SEED_ADMIN_USERNAME} '
                    '(password from SEED_ADMIN_PASSWORD or the local default).'
                )
            raise ValueError(f'unsupported target {target!r}')
        finally:
            await close_pool()

    return asyncio.run(_run())
