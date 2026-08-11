"""Question bank service. Mirrors backend/internal/services/banks.go."""

from __future__ import annotations

import json
from dataclasses import dataclass

from psycopg_pool import AsyncConnectionPool

from .. import envelope
from ..auth.runtime import User
from . import helpers
from .pagination import Page, build_page, clamp_positive, parse_page_cursor

BANK_COLUMNS = 'id, name, description, subject, total_count, created_by, is_public, created_at, updated_at'
BANK_SELECT_COLUMNS = 'b.id, b.name, b.description, b.subject, b.total_count, b.created_by, b.is_public, b.created_at, b.updated_at'


def _scan_bank(row: tuple) -> dict:
    return {
        'id': row[0],
        'name': row[1],
        'description': row[2],
        'subject': row[3],
        'total_count': row[4],
        'created_by': row[5],
        'is_public': row[6],
        'created_at': helpers.format_timestamp(row[7]),
        'updated_at': helpers.format_timestamp(row[8]),
    }


def _scan_bank_with_flags(row: tuple) -> dict:
    bank = _scan_bank(row)
    bank['is_owner'] = row[9]
    bank['is_favorite'] = row[10]
    return bank


def _normalize_bank_scope(scope: str) -> str:
    scope = scope.strip()
    if scope in ('public', 'favorites', 'all'):
        return scope
    if scope in ('mine', ''):
        return 'mine'
    raise envelope.validation_error(
        [envelope.ValidationDetail('scope', 'must be one of mine, public, favorites, all')]
    )


@dataclass
class ListBanksParams:
    scope: str = ''
    subject: str = ''
    query: str = ''
    limit: int = 0
    cursor: str = ''
    updated_since: str = ''


async def list_banks(pool: AsyncConnectionPool, user: User, params: ListBanksParams) -> Page[dict]:
    scope = _normalize_bank_scope(params.scope)
    subject = helpers.trimmed_or_none(params.subject)
    query = helpers.ilike_or_none(params.query)
    limit = clamp_positive(params.limit, 30, 100)
    offset = parse_page_cursor(params.cursor)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            f"""
            SELECT
                {BANK_SELECT_COLUMNS},
                COALESCE(ubl.is_owner, false) AS is_owner,
                COALESCE(ubl.is_favorite, false) AS is_favorite
            FROM question_banks b
            LEFT JOIN user_bank_links ubl
                ON ubl.bank_id = b.id
               AND ubl.user_id = %s
            WHERE
                (
                    %s = 'public' AND b.is_public = true
                    OR %s = 'favorites' AND ubl.is_favorite = true
                    OR %s = 'mine' AND COALESCE(ubl.is_owner, false) = true
                    OR %s = 'all' AND (b.is_public = true OR ubl.id IS NOT NULL)
                )
                AND (%s::text IS NULL OR b.subject = %s)
                AND (%s::text IS NULL OR b.name ILIKE %s)
                AND (%s::timestamptz IS NULL OR GREATEST(b.updated_at, COALESCE(ubl.updated_at, b.updated_at)) >= %s::timestamptz)
            ORDER BY b.updated_at DESC, b.id DESC
            LIMIT %s OFFSET %s
            """,
            (
                user.id, scope, scope, scope, scope, subject, subject, query, query,
                params.updated_since.strip() or None, params.updated_since.strip() or None,
                limit + 1, offset,
            ),
        )
        items = [_scan_bank_with_flags(row) for row in await cursor.fetchall()]
    return build_page(items, limit, offset)


async def get_bank(pool: AsyncConnectionPool, user: User, bank_id: int) -> dict:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            f"""
            SELECT
                {BANK_SELECT_COLUMNS},
                COALESCE(ubl.is_owner, false) AS is_owner,
                COALESCE(ubl.is_favorite, false) AS is_favorite
            FROM question_banks b
            LEFT JOIN user_bank_links ubl
                ON ubl.bank_id = b.id
               AND ubl.user_id = %s
            WHERE b.id = %s
              AND (b.is_public = true OR ubl.id IS NOT NULL)
            LIMIT 1
            """,
            (user.id, bank_id),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Question bank not found')
    return _scan_bank_with_flags(row)


async def require_bank_owner(conn, user: User, bank_id: int) -> tuple[int, str]:
    cursor = await conn.execute(
        """
        SELECT b.id, b.subject
        FROM question_banks b
        JOIN user_bank_links ubl ON ubl.bank_id = b.id
        WHERE b.id = %s
          AND ubl.user_id = %s
          AND ubl.is_owner = true
        LIMIT 1
        """,
        (bank_id, user.id),
    )
    row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(403, 'FORBIDDEN', 'Bank owner access required')
    return row[0], row[1]


async def create_bank(
    pool: AsyncConnectionPool, user: User, name: str, description: str | None, subject: str, is_public: bool
) -> dict:
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                f"""
                INSERT INTO question_banks (name, description, subject, created_by, is_public)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING {BANK_COLUMNS}
                """,
                (name.strip(), description, subject.strip(), user.id, is_public),
            )
            created = _scan_bank(await cursor.fetchone())
            await conn.execute(
                'INSERT INTO user_bank_links (user_id, bank_id, is_owner) VALUES (%s, %s, true)',
                (user.id, created['id']),
            )
    return created


async def update_bank(
    pool: AsyncConnectionPool, user: User, bank_id: int,
    name: str | None, description: str | None, description_set: bool, is_public: bool | None,
) -> dict:
    if name is None and not description_set and is_public is None:
        raise envelope.validation_error(
            [envelope.ValidationDetail('body', 'must include a field to update')]
        )
    async with pool.connection() as conn:
        await require_bank_owner(conn, user, bank_id)
        cursor = await conn.execute(
            f"""
            UPDATE question_banks
            SET
                name = COALESCE(%s, name),
                description = CASE WHEN %s THEN %s ELSE description END,
                is_public = COALESCE(%s, is_public)
            WHERE id = %s
            RETURNING {BANK_COLUMNS}
            """,
            (name, description_set, description, is_public, bank_id),
        )
        return _scan_bank(await cursor.fetchone())


async def delete_bank(pool: AsyncConnectionPool, user: User, bank_id: int) -> None:
    async with pool.connection() as conn:
        await require_bank_owner(conn, user, bank_id)
        await conn.execute('DELETE FROM question_banks WHERE id = %s', (bank_id,))


async def set_favorite(pool: AsyncConnectionPool, user: User, bank_id: int, favorite: bool) -> None:
    async with pool.connection() as conn:
        await get_bank(pool, user, bank_id)
        if favorite:
            await conn.execute(
                """
                INSERT INTO user_bank_links (user_id, bank_id, is_favorite)
                VALUES (%s, %s, true)
                ON CONFLICT (user_id, bank_id)
                DO UPDATE SET is_favorite = true
                """,
                (user.id, bank_id),
            )
            return
        await conn.execute(
            """
            DELETE FROM user_bank_links
            WHERE user_id = %s AND bank_id = %s AND is_owner = false
            """,
            (user.id, bank_id),
        )
        await conn.execute(
            """
            UPDATE user_bank_links
            SET is_favorite = false
            WHERE user_id = %s AND bank_id = %s AND is_owner = true
            """,
            (user.id, bank_id),
        )


@dataclass
class ListBankItemsParams:
    status: str = ''
    type: str = ''
    limit: int = 0
    include_answers: bool = False
    cursor: str = ''


async def list_bank_items(
    pool: AsyncConnectionPool, user: User, bank_id: int, params: ListBankItemsParams
) -> Page[dict]:
    bank = await get_bank(pool, user, bank_id)
    can_edit = bank['is_owner']
    include_answers = can_edit and params.include_answers

    status_value = params.status.strip()
    if status_value and status_value not in ('draft', 'active', 'archived'):
        raise envelope.validation_error(
            [envelope.ValidationDetail('status', 'must be one of draft, active, archived')]
        )
    status = helpers.trimmed_or_none(status_value)
    question_type_id = helpers.trimmed_or_none(params.type)
    limit = clamp_positive(params.limit, 50, 100)
    offset = parse_page_cursor(params.cursor)

    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT
                item.bank_id,
                item.group_id,
                item.question_id,
                item.item_scope,
                item.bank_sort_order,
                item.group_sort_order,
                item.question_no,
                item.bank_link_status,
                item.business_type,
                item.subject_id,
                item.question_type_id,
                item.answer_mode,
                item.choice_variant,
                item.content_mode,
                item.stem,
                CASE WHEN %s THEN item.analysis ELSE NULL END,
                item.question_status,
                item.group_title,
                item.group_instructions,
                COALESCE(
                    (
                        SELECT jsonb_agg(
                            jsonb_strip_nulls(jsonb_build_object(
                                'id', qo.id,
                                'question_id', qo.question_id,
                                'option_label', qo.option_label,
                                'sort_order', qo.sort_order,
                                'content', qo.content,
                                'is_correct', CASE WHEN %s THEN qo.is_correct ELSE NULL END,
                                'created_at', qo.created_at,
                                'updated_at', qo.updated_at
                            ))
                            ORDER BY qo.sort_order
                        )
                        FROM question_options qo
                        WHERE qo.question_id = item.question_id
                    ),
                    '[]'::json
                ) AS options
            FROM v_bank_question_items item
            WHERE item.bank_id = %s
              AND (%s::text IS NULL OR item.bank_link_status = %s)
              AND (%s::text IS NULL OR item.question_type_id = %s)
              AND (%s OR (item.bank_link_status = 'active' AND item.question_status = 'active'))
            ORDER BY item.bank_sort_order, item.group_sort_order NULLS FIRST, item.question_id
            LIMIT %s OFFSET %s
            """,
            (
                can_edit, include_answers,
                bank_id, status, status, question_type_id, question_type_id, can_edit,
                limit + 1, offset,
            ),
        )
        items = []
        for row in await cursor.fetchall():
            options = row[19]
            if isinstance(options, str):
                options = json.loads(options)
            items.append({
                'bank_id': row[0],
                'group_id': row[1],
                'question_id': row[2],
                'item_scope': row[3],
                'bank_sort_order': row[4],
                'group_sort_order': row[5],
                'question_no': row[6],
                'bank_link_status': row[7],
                'business_type': row[8],
                'subject_id': row[9],
                'question_type_id': row[10],
                'answer_mode': row[11],
                'choice_variant': row[12],
                'content_mode': row[13],
                'stem': row[14],
                'analysis': row[15],
                'question_status': row[16],
                'group_title': row[17],
                'group_instructions': row[18],
                'options': options or [],
            })
    return build_page(items, limit, offset)


@dataclass
class ReorderBankItem:
    question_id: int | None
    group_id: int | None
    sort_order: int


async def reorder_bank_items(
    pool: AsyncConnectionPool, user: User, bank_id: int, items: list[ReorderBankItem]
) -> None:
    async with pool.connection() as conn:
        await require_bank_owner(conn, user, bank_id)
        async with conn.transaction():
            cursor = await conn.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM bank_question_links WHERE bank_id = %s)
                    + (SELECT COUNT(*) FROM bank_group_links WHERE bank_id = %s)
                """,
                (bank_id, bank_id),
            )
            total = (await cursor.fetchone())[0]
            if total != len(items):
                raise envelope.validation_error(
                    [envelope.ValidationDetail('items', 'must include every bank item exactly once')]
                )
            cursor = await conn.execute(
                """
                SELECT COALESCE(MAX(sort_order), 0) + 1000 AS offset_value
                FROM (
                    SELECT sort_order FROM bank_question_links WHERE bank_id = %s
                    UNION ALL
                    SELECT sort_order FROM bank_group_links WHERE bank_id = %s
                ) s
                """,
                (bank_id, bank_id),
            )
            offset_value = (await cursor.fetchone())[0]
            await conn.execute(
                'UPDATE bank_question_links SET sort_order = sort_order + %s WHERE bank_id = %s',
                (offset_value, bank_id),
            )
            await conn.execute(
                'UPDATE bank_group_links SET sort_order = sort_order + %s WHERE bank_id = %s',
                (offset_value, bank_id),
            )
            for item in items:
                if item.question_id is not None:
                    result = await conn.execute(
                        """
                        UPDATE bank_question_links
                        SET sort_order = %s
                        WHERE bank_id = %s AND question_id = %s
                        """,
                        (item.sort_order, bank_id, item.question_id),
                    )
                    if result.rowcount != 1:
                        raise envelope.validation_error(
                            [envelope.ValidationDetail('items', 'contains an unknown question')]
                        )
                if item.group_id is not None:
                    result = await conn.execute(
                        """
                        UPDATE bank_group_links
                        SET sort_order = %s
                        WHERE bank_id = %s AND group_id = %s
                        """,
                        (item.sort_order, bank_id, item.group_id),
                    )
                    if result.rowcount != 1:
                        raise envelope.validation_error(
                            [envelope.ValidationDetail('items', 'contains an unknown group')]
                        )
