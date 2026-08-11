"""Question group service. Mirrors backend/internal/services/groups.go."""

from __future__ import annotations

import json
from dataclasses import dataclass

from psycopg_pool import AsyncConnectionPool

from .. import envelope
from ..auth.runtime import User
from . import helpers, reference
from .banks import get_bank, require_bank_owner
from .pagination import Page, build_page, clamp_positive, parse_page_cursor
from .questions import ensure_question_editable, _normalize_question_status_or_default

QUESTION_GROUP_COLUMNS = (
    'id, business_type, subject_id, group_type_id, parent_group_id, hierarchy_level, '
    'hierarchy_path, chapter_ref, chapter_title, chapter_order, title, instructions, '
    'source_ref, content_mode, detail_payload, imported_by, created_at, updated_at, source_job_id'
)


def _scan_group(row: tuple) -> dict:
    return {
        'id': row[0],
        'business_type': row[1],
        'subject_id': row[2],
        'group_type_id': row[3],
        'parent_group_id': row[4],
        'hierarchy_level': row[5],
        'hierarchy_path': row[6],
        'chapter_ref': row[7],
        'chapter_title': row[8],
        'chapter_order': row[9],
        'title': row[10],
        'instructions': row[11],
        'source_ref': row[12],
        'content_mode': row[13],
        'detail_payload': row[14],
        'imported_by': row[15],
        'created_at': helpers.format_timestamp(row[16]),
        'updated_at': helpers.format_timestamp(row[17]),
        'source_job_id': row[18],
    }


def _validate_group_content_mode(value: str | None) -> envelope.ValidationDetail | None:
    if value is None:
        return None
    if value.strip() in ('text_only', 'mixed_media', 'structured_rich'):
        return None
    return envelope.ValidationDetail('contentMode', 'must be one of text_only, mixed_media, structured_rich')


async def ensure_group_editable(pool: AsyncConnectionPool, user: User, group_id: int) -> None:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT g.id
            FROM question_groups g
            JOIN bank_group_links bgl ON bgl.group_id = g.id
            JOIN user_bank_links ubl ON ubl.bank_id = bgl.bank_id
            WHERE g.id = %s
              AND ubl.user_id = %s
              AND ubl.is_owner = true
            LIMIT 1
            """,
            (group_id, user.id),
        )
        if await cursor.fetchone() is None:
            raise envelope.new_error(403, 'FORBIDDEN', 'Group editor access required')


async def list_bank_groups(
    pool: AsyncConnectionPool, user: User, bank_id: int, limit: int, cursor_str: str
) -> Page[dict]:
    bank = await get_bank(pool, user, bank_id)
    limit = clamp_positive(limit, 30, 100)
    offset = parse_page_cursor(cursor_str)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT
                g.id,
                g.group_type_id,
                g.title,
                g.instructions,
                g.content_mode,
                bgl.status,
                bgl.sort_order,
                COUNT(gql.question_id)::int
            FROM bank_group_links bgl
            JOIN question_groups g ON g.id = bgl.group_id
            LEFT JOIN group_question_links gql ON gql.group_id = g.id
            WHERE bgl.bank_id = %s
              AND (%s OR bgl.status = 'active')
            GROUP BY g.id, bgl.status, bgl.sort_order
            ORDER BY bgl.sort_order, g.id
            LIMIT %s OFFSET %s
            """,
            (bank_id, bank['is_owner'], limit + 1, offset),
        )
        items = [
            {
                'id': row[0],
                'group_type_id': row[1],
                'title': row[2],
                'instructions': row[3],
                'content_mode': row[4],
                'status': row[5],
                'sort_order': row[6],
                'question_count': row[7],
                'can_edit': bank['is_owner'],
            }
            for row in await cursor.fetchall()
        ]
    return build_page(items, limit, offset)


@dataclass
class CreateGroupInput:
    title: str
    instructions: str | None = None
    group_type_id: str = ''
    content_mode: str | None = None
    status: str = ''
    source_job_id: int | None = None


async def create_group(
    pool: AsyncConnectionPool, user: User, bank_id: int, input: CreateGroupInput
) -> dict:
    title = input.title.strip()
    details: list[envelope.ValidationDetail] = []
    if not title or len(title) > 1000:
        details.append(envelope.ValidationDetail('title', 'must be 1-1000 characters'))
    instructions = input.instructions.strip() if input.instructions is not None else None
    if instructions is not None and len(instructions) > 20000:
        details.append(envelope.ValidationDetail('instructions', 'must be no more than 20000 characters'))
    if detail := _validate_group_content_mode(input.content_mode):
        details.append(detail)
    if details:
        raise envelope.validation_error(details)
    async with pool.connection() as conn:
        _, subject = await require_bank_owner(conn, user, bank_id)
        group_type_id = await reference.resolve_question_type_id_for_subject(
            conn, subject, input.group_type_id, None, 'group'
        )
    status = _normalize_question_status_or_default(input.status, 'draft')
    content_mode = input.content_mode if input.content_mode is not None else 'text_only'
    async with pool.connection() as conn:
        async with conn.transaction():
            await conn.execute('SELECT id FROM question_banks WHERE id = %s FOR UPDATE', (bank_id,))
            cursor = await conn.execute(
                """
                SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
                FROM bank_group_links
                WHERE bank_id = %s
                """,
                (bank_id,),
            )
            next_sort = (await cursor.fetchone())[0]
            cursor = await conn.execute(
                f"""
                INSERT INTO question_groups (
                    subject_id, group_type_id, title, instructions,
                    content_mode, imported_by, source_job_id
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING {QUESTION_GROUP_COLUMNS}
                """,
                (subject, group_type_id, title, instructions, content_mode, user.id, input.source_job_id),
            )
            created = _scan_group(await cursor.fetchone())
            await conn.execute(
                """
                INSERT INTO bank_group_links (bank_id, group_id, sort_order, status, added_by)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (bank_id, created['id'], next_sort, status, user.id),
            )
            return created


async def get_group(pool: AsyncConnectionPool, user: User, group_id: int) -> dict:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            f"""
            WITH access AS (
                SELECT
                    COUNT(*) > 0 AS has_access,
                    COALESCE(BOOL_OR(COALESCE(ubl.is_owner, false)), false) AS can_edit
                FROM bank_group_links bgl
                JOIN question_banks b ON b.id = bgl.bank_id
                LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = %s
                WHERE bgl.group_id = %s
                  AND (b.is_public = true OR ubl.id IS NOT NULL)
                  AND (COALESCE(ubl.is_owner, false) OR bgl.status = 'active')
            )
            SELECT
                {QUESTION_GROUP_COLUMNS},
                access.can_edit,
                COALESCE(
                    (
                        SELECT jsonb_agg(
                            jsonb_strip_nulls(jsonb_build_object(
                                'id', q.id,
                                'subject_id', q.subject_id,
                                'question_type_id', q.question_type_id,
                                'answer_mode', q.answer_mode,
                                'choice_variant', q.choice_variant,
                                'stem', q.stem,
                                'analysis', CASE WHEN access.can_edit THEN q.analysis ELSE NULL END,
                                'status', q.status
                            ))
                            ORDER BY gql.sort_order
                        )
                        FROM group_question_links gql
                        JOIN questions q ON q.id = gql.question_id
                        WHERE gql.group_id = g.id
                          AND (access.can_edit OR q.status = 'active')
                    ),
                    '[]'::json
                ) AS questions
            FROM question_groups g
            CROSS JOIN access
            WHERE g.id = %s
              AND access.has_access
            LIMIT 1
            """,
            (user.id, group_id, group_id),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Group not found')
    detail = _scan_group(row)
    detail['can_edit'] = row[19]
    questions = row[20]
    detail['questions'] = json.loads(questions) if isinstance(questions, str) else (questions or [])
    return detail


async def update_group(
    pool: AsyncConnectionPool, user: User, group_id: int,
    title: str | None, instructions: str | None, instructions_set: bool, content_mode: str | None,
) -> dict:
    if title is None and not instructions_set and content_mode is None:
        raise envelope.validation_error(
            [envelope.ValidationDetail('body', 'must include a field to update')]
        )
    details: list[envelope.ValidationDetail] = []
    if title is not None:
        title = title.strip()
        if not title or len(title) > 1000:
            details.append(envelope.ValidationDetail('title', 'must be 1-1000 characters'))
    if instructions_set and instructions is not None:
        instructions = instructions.strip()
        if len(instructions) > 20000:
            details.append(envelope.ValidationDetail('instructions', 'must be no more than 20000 characters'))
    if detail := _validate_group_content_mode(content_mode):
        details.append(detail)
    if details:
        raise envelope.validation_error(details)
    await ensure_group_editable(pool, user, group_id)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            f"""
            UPDATE question_groups
            SET
                title = COALESCE(%s, title),
                instructions = CASE WHEN %s THEN %s ELSE instructions END,
                content_mode = COALESCE(%s, content_mode)
            WHERE id = %s
            RETURNING {QUESTION_GROUP_COLUMNS}
            """,
            (title, instructions_set, instructions, content_mode, group_id),
        )
        return _scan_group(await cursor.fetchone())


async def set_group_status(
    pool: AsyncConnectionPool, user: User, group_id: int, status: str
) -> dict:
    normalized = _normalize_question_status_or_default(status, '')
    await ensure_group_editable(pool, user, group_id)
    async with pool.connection() as conn:
        if normalized == 'active':
            cursor = await conn.execute(
                """
                SELECT COUNT(*)::int, COUNT(*) FILTER (WHERE q.status = 'active')::int
                FROM group_question_links gql
                JOIN questions q ON q.id = gql.question_id
                WHERE gql.group_id = %s
                """,
                (group_id,),
            )
            total, active = await cursor.fetchone()
            if total == 0 or active != total:
                raise envelope.new_error(
                    409, 'GROUP_NOT_PUBLISHABLE', 'Publish every question before publishing the group'
                )
        result = await conn.execute(
            """
            UPDATE bank_group_links bgl
            SET status = %s
            FROM user_bank_links ubl
            WHERE bgl.group_id = %s
              AND ubl.bank_id = bgl.bank_id
              AND ubl.user_id = %s
              AND ubl.is_owner = true
            """,
            (normalized, group_id, user.id),
        )
        if result.rowcount == 0:
            raise envelope.new_error(404, 'NOT_FOUND', 'Group not found')
    return await get_group(pool, user, group_id)


async def delete_group(pool: AsyncConnectionPool, user: User, group_id: int) -> None:
    await ensure_group_editable(pool, user, group_id)
    async with pool.connection() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                WITH owner_banks AS (
                    SELECT bgl.bank_id
                    FROM bank_group_links bgl
                    JOIN user_bank_links ubl ON ubl.bank_id = bgl.bank_id
                    WHERE bgl.group_id = %s
                      AND ubl.user_id = %s
                      AND ubl.is_owner = true
                ),
                missing AS (
                    SELECT
                        ob.bank_id,
                        gql.question_id,
                        q.status,
                        ROW_NUMBER() OVER (PARTITION BY ob.bank_id ORDER BY gql.sort_order, gql.question_id)::int AS row_no
                    FROM owner_banks ob
                    JOIN group_question_links gql ON gql.group_id = %s
                    JOIN questions q ON q.id = gql.question_id
                    WHERE NOT EXISTS (
                        SELECT 1 FROM bank_question_links direct
                        WHERE direct.bank_id = ob.bank_id AND direct.question_id = gql.question_id
                    )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM bank_group_links other_bank_group
                        JOIN group_question_links other_group_question ON other_group_question.group_id = other_bank_group.group_id
                        WHERE other_bank_group.bank_id = ob.bank_id
                          AND other_bank_group.group_id <> %s
                          AND other_group_question.question_id = gql.question_id
                    )
                ),
                bases AS (
                    SELECT ob.bank_id, COALESCE(MAX(bql.sort_order), 0) AS base_sort
                    FROM owner_banks ob
                    LEFT JOIN bank_question_links bql ON bql.bank_id = ob.bank_id
                    GROUP BY ob.bank_id
                )
                INSERT INTO bank_question_links (bank_id, question_id, sort_order, status, added_by)
                SELECT missing.bank_id, missing.question_id, bases.base_sort + missing.row_no, missing.status, %s
                FROM missing
                JOIN bases ON bases.bank_id = missing.bank_id
                ON CONFLICT (bank_id, question_id) DO NOTHING
                """,
                (group_id, user.id, group_id, group_id, user.id),
            )
            await conn.execute(
                """
                DELETE FROM bank_group_links bgl
                USING user_bank_links ubl
                WHERE bgl.group_id = %s
                  AND ubl.bank_id = bgl.bank_id
                  AND ubl.user_id = %s
                  AND ubl.is_owner = true
                """,
                (group_id, user.id),
            )
            await conn.execute(
                """
                DELETE FROM question_groups g
                WHERE g.id = %s
                  AND NOT EXISTS (SELECT 1 FROM bank_group_links bgl WHERE bgl.group_id = g.id)
                """,
                (group_id,),
            )


async def add_question_to_group(
    pool: AsyncConnectionPool, user: User, group_id: int, question_id: int, sort_order: int | None
) -> dict:
    if sort_order is not None and sort_order <= 0:
        raise envelope.validation_error([envelope.ValidationDetail('sortOrder', 'must be positive')])
    await ensure_group_editable(pool, user, group_id)
    await ensure_question_editable(pool, user, question_id)
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                """
                SELECT
                    bgl.bank_id,
                    EXISTS (
                        SELECT 1
                        FROM v_bank_question_items item
                        WHERE item.bank_id = bgl.bank_id AND item.question_id = %s
                    )
                FROM bank_group_links bgl
                JOIN user_bank_links ubl ON ubl.bank_id = bgl.bank_id
                WHERE bgl.group_id = %s
                  AND ubl.user_id = %s
                  AND ubl.is_owner = true
                FOR UPDATE OF bgl
                """,
                (question_id, group_id, user.id),
            )
            banks = [(row[0], row[1]) for row in await cursor.fetchall()]
            if sort_order is None:
                cursor = await conn.execute(
                    """
                    SELECT COALESCE(MAX(sort_order), 0) + 1
                    FROM group_question_links
                    WHERE group_id = %s
                    """,
                    (group_id,),
                )
                sort_order = (await cursor.fetchone())[0]
            cursor = await conn.execute(
                """
                INSERT INTO group_question_links (group_id, question_id, sort_order)
                VALUES (%s, %s, %s)
                RETURNING id, group_id, question_id, group_subject_id, question_subject_id, sort_order, question_no, created_at, updated_at
                """,
                (group_id, question_id, sort_order),
            )
            row = await cursor.fetchone()
            link = {
                'id': row[0],
                'group_id': row[1],
                'question_id': row[2],
                'group_subject_id': row[3],
                'question_subject_id': row[4],
                'sort_order': row[5],
                'question_no': row[6],
                'created_at': helpers.format_timestamp(row[7]),
                'updated_at': helpers.format_timestamp(row[8]),
            }
            for bank_id, had in banks:
                await conn.execute(
                    'DELETE FROM bank_question_links WHERE bank_id = %s AND question_id = %s',
                    (bank_id, question_id),
                )
                if not had:
                    await conn.execute(
                        'UPDATE question_banks SET total_count = total_count + 1 WHERE id = %s',
                        (bank_id,),
                    )
            return link


@dataclass
class ReorderGroupQuestionItem:
    question_id: int
    sort_order: int


async def reorder_group_questions(
    pool: AsyncConnectionPool, user: User, group_id: int, items: list[ReorderGroupQuestionItem]
) -> None:
    await ensure_group_editable(pool, user, group_id)
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                'SELECT COUNT(*) FROM group_question_links WHERE group_id = %s', (group_id,)
            )
            total = (await cursor.fetchone())[0]
            if total != len(items):
                raise envelope.validation_error(
                    [envelope.ValidationDetail('items', 'must include every group question exactly once')]
                )
            cursor = await conn.execute(
                """
                SELECT COALESCE(MAX(sort_order), 0) + 1000 AS offset_value
                FROM group_question_links
                WHERE group_id = %s
                """,
                (group_id,),
            )
            offset_value = (await cursor.fetchone())[0]
            await conn.execute(
                'UPDATE group_question_links SET sort_order = sort_order + %s WHERE group_id = %s',
                (offset_value, group_id),
            )
            for item in items:
                result = await conn.execute(
                    """
                    UPDATE group_question_links
                    SET sort_order = %s
                    WHERE group_id = %s AND question_id = %s
                    """,
                    (item.sort_order, group_id, item.question_id),
                )
                if result.rowcount != 1:
                    raise envelope.validation_error(
                        [envelope.ValidationDetail('items', 'contains an unknown question')]
                    )


async def remove_question_from_group(
    pool: AsyncConnectionPool, user: User, group_id: int, question_id: int
) -> None:
    await ensure_group_editable(pool, user, group_id)
    async with pool.connection() as conn:
        async with conn.transaction():
            result = await conn.execute(
                'DELETE FROM group_question_links WHERE group_id = %s AND question_id = %s',
                (group_id, question_id),
            )
            if result.rowcount == 0:
                raise envelope.new_error(404, 'NOT_FOUND', 'Group question link not found')
            await conn.execute(
                """
                INSERT INTO bank_question_links (bank_id, question_id, sort_order, status, added_by)
                SELECT
                    bgl.bank_id,
                    q.id,
                    (SELECT COALESCE(MAX(existing.sort_order), 0) + 1 FROM bank_question_links existing WHERE existing.bank_id = bgl.bank_id),
                    q.status,
                    %s
                FROM bank_group_links bgl
                JOIN user_bank_links ubl ON ubl.bank_id = bgl.bank_id
                JOIN questions q ON q.id = %s
                WHERE bgl.group_id = %s
                  AND ubl.user_id = %s
                  AND ubl.is_owner = true
                  AND NOT EXISTS (
                    SELECT 1
                    FROM v_bank_question_items item
                    WHERE item.bank_id = bgl.bank_id AND item.question_id = %s
                  )
                ON CONFLICT (bank_id, question_id) DO NOTHING
                """,
                (user.id, question_id, group_id, user.id, question_id),
            )
