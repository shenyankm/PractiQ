"""Admin service. Mirrors backend/internal/services/admin.go."""

from __future__ import annotations

import json

from psycopg_pool import AsyncConnectionPool

from .. import envelope
from ..auth.runtime import User, invalidate_user_cache
from . import helpers
from .pagination import Page, build_page, parse_page_cursor
from .users import USER_RECORD_COLUMNS, scan_user_record


async def get_admin_overview(pool: AsyncConnectionPool, user: User) -> dict:
    helpers.require_admin_role(user)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT
              (SELECT COUNT(*)::int FROM users) AS total_users,
              (SELECT COUNT(*)::int FROM users WHERE is_active = true) AS active_users,
              (SELECT COUNT(*)::int FROM users WHERE role = 'admin') AS admin_users,
              (SELECT COUNT(*)::int FROM users WHERE membership IN ('plus', 'enterprise')) AS plus_users,
              (SELECT COUNT(*)::int FROM question_banks) AS total_banks,
              (SELECT COUNT(*)::int FROM questions) AS total_questions,
              (SELECT COUNT(*)::int FROM question_import_jobs) AS import_jobs,
              (SELECT COUNT(*)::int FROM knowledge_points) AS knowledge_points
            """
        )
        row = await cursor.fetchone()
    return {
        'total_users': row[0],
        'active_users': row[1],
        'admin_users': row[2],
        'plus_users': row[3],
        'total_banks': row[4],
        'total_questions': row[5],
        'import_jobs': row[6],
        'knowledge_points': row[7],
    }


def _parse_page_limit(raw: str, fallback: int, maximum: int) -> int:
    if not raw.strip():
        return fallback
    try:
        limit = int(raw.strip())
    except ValueError as exc:
        raise envelope.validation_error([envelope.ValidationDetail('limit', 'is invalid')]) from exc
    if limit < 1 or limit > maximum:
        raise envelope.validation_error([envelope.ValidationDetail('limit', 'is invalid')])
    return limit


async def list_admin_users(
    pool: AsyncConnectionPool, user: User,
    limit_raw: str, cursor_str: str, q: str, status: str, role: str,
) -> Page[dict]:
    helpers.require_admin_role(user)
    limit = _parse_page_limit(limit_raw, 30, 100)
    offset = parse_page_cursor(cursor_str)
    q = q.strip()
    status = status or 'all'
    if status not in ('all', 'active', 'inactive'):
        raise envelope.validation_error(
            [envelope.ValidationDetail('status', 'must be one of all, active, inactive')]
        )
    role = role or 'all'
    if role not in ('all', 'admin', 'user'):
        raise envelope.validation_error(
            [envelope.ValidationDetail('role', 'must be one of all, admin, user')]
        )
    async with pool.connection() as conn:
        cursor = await conn.execute(
            f"""
            SELECT
              u.id, u.username, u.email, u.avatar_url, u.is_active, u.role, u.membership,
              u.plus_trial_ends_at, u.plus_expires_at, u.created_at, u.updated_at,
              COALESCE(bank_counts.bank_count, 0)::int AS bank_count,
              COALESCE(import_counts.import_job_count, 0)::int AS import_job_count,
              COALESCE(session_counts.practice_session_count, 0)::int AS practice_session_count
            FROM users u
            LEFT JOIN (
              SELECT user_id, COUNT(*)::int AS bank_count
              FROM user_bank_links
              WHERE is_owner = true
              GROUP BY user_id
            ) bank_counts ON bank_counts.user_id = u.id
            LEFT JOIN (
              SELECT created_by, COUNT(*)::int AS import_job_count
              FROM question_import_jobs
              GROUP BY created_by
            ) import_counts ON import_counts.created_by = u.id
            LEFT JOIN (
              SELECT user_id, COUNT(*)::int AS practice_session_count
              FROM user_practice_sessions
              GROUP BY user_id
            ) session_counts ON session_counts.user_id = u.id
            WHERE
              (%s::text IS NULL OR u.username ILIKE %s OR u.email ILIKE %s)
              AND (%s = 'all' OR (%s = 'active' AND u.is_active = true) OR (%s = 'inactive' AND u.is_active = false))
              AND (%s = 'all' OR u.role = %s)
            ORDER BY u.created_at DESC, u.id DESC
            LIMIT %s OFFSET %s
            """,
            (
                helpers.trimmed_or_none(q), helpers.ilike_or_none(q), helpers.ilike_or_none(q),
                status, status, status, role, role,
                limit + 1, offset,
            ),
        )
        items = []
        for row in await cursor.fetchall():
            item = scan_user_record(row[:11])
            item['bank_count'] = row[11]
            item['import_job_count'] = row[12]
            item['practice_session_count'] = row[13]
            items.append(item)
    return build_page(items, limit, offset)


def _scan_knowledge_point(row: tuple) -> dict:
    return {
        'id': row[0],
        'subject_id': row[1],
        'code': row[2],
        'display_name': row[3],
        'parent_id': row[4],
        'metadata_json': row[5],
        'created_at': helpers.format_timestamp(row[6]),
        'updated_at': helpers.format_timestamp(row[7]),
    }


async def list_admin_knowledge_points(
    pool: AsyncConnectionPool, user: User,
    limit_raw: str, cursor_str: str, subject: str, q: str,
) -> Page[dict]:
    helpers.require_admin_role(user)
    limit = _parse_page_limit(limit_raw, 50, 200)
    offset = parse_page_cursor(cursor_str)
    subject = subject.strip()
    q = q.strip()
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at
            FROM knowledge_points
            WHERE
              (%s::text IS NULL OR subject_id = %s)
              AND (%s::text IS NULL OR code ILIKE %s OR display_name ILIKE %s)
            ORDER BY subject_id, code
            LIMIT %s OFFSET %s
            """,
            (
                helpers.trimmed_or_none(subject), helpers.trimmed_or_none(subject),
                helpers.trimmed_or_none(q), helpers.ilike_or_none(q), helpers.ilike_or_none(q),
                limit + 1, offset,
            ),
        )
        items = [_scan_knowledge_point(row) for row in await cursor.fetchall()]
    return build_page(items, limit, offset)


async def create_knowledge_point(
    pool: AsyncConnectionPool, user: User,
    subject_id: str, code: str, display_name: str, parent_id: int | None, metadata: dict | None,
) -> dict:
    helpers.require_admin_role(user)
    metadata_json = json.dumps(metadata if metadata is not None else {}, separators=(',', ':'))
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            INSERT INTO knowledge_points (subject_id, code, display_name, parent_id, metadata_json)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at
            """,
            (subject_id, code, display_name, parent_id, metadata_json),
        )
        item = _scan_knowledge_point(await cursor.fetchone())
    await helpers.bump_slice_cache_version('knowledge-points')
    return item


async def update_knowledge_point(
    pool: AsyncConnectionPool, user: User, knowledge_point_id: int,
    code: str | None, display_name: str | None,
    parent_id: int | None, parent_id_set: bool,
    metadata: dict | None, metadata_set: bool,
) -> dict:
    helpers.require_admin_role(user)
    metadata_json = (
        json.dumps(metadata, separators=(',', ':')) if metadata_set and metadata is not None else None
    )
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            UPDATE knowledge_points
            SET
              code = COALESCE(%s, code),
              display_name = COALESCE(%s, display_name),
              parent_id = CASE WHEN %s THEN %s ELSE parent_id END,
              metadata_json = COALESCE(%s, metadata_json)
            WHERE id = %s
            RETURNING id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at
            """,
            (code, display_name, parent_id_set, parent_id, metadata_json, knowledge_point_id),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Knowledge point not found')
    await helpers.bump_slice_cache_version('knowledge-points')
    return _scan_knowledge_point(row)


async def set_user_status(
    pool: AsyncConnectionPool, user: User, target_user_id: int, is_active: bool
) -> dict:
    helpers.require_admin_role(user)
    if user.id == target_user_id and not is_active:
        raise envelope.new_error(
            409, 'INVALID_STATE', 'Administrators cannot disable their own account'
        )
    async with pool.connection() as conn:
        cursor = await conn.execute(
            f"""
            UPDATE users
            SET is_active = %s
            WHERE id = %s
            RETURNING {USER_RECORD_COLUMNS}
            """,
            (is_active, target_user_id),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'User not found')
    await invalidate_user_cache(target_user_id)
    return scan_user_record(row)


async def update_user_access(
    pool: AsyncConnectionPool, user: User, target_user_id: int,
    role: str | None, membership: str | None,
) -> dict:
    helpers.require_admin_role(user)
    if user.id == target_user_id and role == 'user':
        raise envelope.new_error(
            409, 'INVALID_STATE', 'Administrators cannot remove their own admin role'
        )
    async with pool.connection() as conn:
        cursor = await conn.execute(
            f"""
            UPDATE users
            SET
              role = COALESCE(%s, role),
              membership = COALESCE(%s, membership),
              plus_expires_at = CASE
                WHEN %s = 'free' THEN NULL
                ELSE plus_expires_at
              END
            WHERE id = %s
            RETURNING {USER_RECORD_COLUMNS}
            """,
            (role, membership, membership, target_user_id),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'User not found')
    await invalidate_user_cache(target_user_id)
    return scan_user_record(row)
