"""Reference data: subjects, question types, knowledge points."""

from .. import envelope
from . import helpers
from .pagination import Page, build_page, clamp_positive, parse_page_cursor


async def resolve_question_type_id_for_subject(
    conn, subject: str, requested_type_id: str, answer_mode: str | None, preferred_scope: str
) -> str:
    requested = requested_type_id.strip()
    if requested:
        cursor = await conn.execute(
            """
            SELECT type_id
            FROM question_types
            WHERE subject_id = %s
              AND type_id = %s
            LIMIT 1
            """,
            (subject, requested),
        )
        row = await cursor.fetchone()
        if row is not None:
            return row[0]

    cursor = await conn.execute(
        """
        SELECT type_id
        FROM question_types
        WHERE subject_id = %s
        ORDER BY
            CASE WHEN default_answer_mode = %s THEN 0 ELSE 1 END,
            CASE WHEN default_answer_mode IS NULL THEN 0 ELSE 1 END,
            CASE WHEN scope = %s THEN 0 WHEN scope = 'hybrid' THEN 1 ELSE 2 END,
            type_id
        LIMIT 1
        """,
        (subject, helpers.trimmed_or_none(answer_mode), preferred_scope.strip()),
    )
    row = await cursor.fetchone()
    if row is not None:
        return row[0]
    raise envelope.new_error(
        422, 'INVALID_QUESTION_TYPE', f'No compatible question type exists for subject {subject}'
    )


async def list_subjects(conn) -> list[dict]:
    cursor = await conn.execute(
        'SELECT subject_id, display_name FROM subjects ORDER BY display_name'
    )
    return [
        {'subject_id': row[0], 'display_name': row[1]} for row in await cursor.fetchall()
    ]


async def list_question_types(conn, subject: str, scope: str) -> list[dict]:
    cursor = await conn.execute(
        """
        SELECT type_id, subject_id, display_name, scope, default_answer_mode
        FROM question_types
        WHERE (%s::text IS NULL OR subject_id = %s)
          AND (%s::text IS NULL OR scope = %s)
        ORDER BY subject_id, display_name
        """,
        (
            helpers.trimmed_or_none(subject), helpers.trimmed_or_none(subject),
            helpers.trimmed_or_none(scope), helpers.trimmed_or_none(scope),
        ),
    )
    return [
        {
            'type_id': row[0],
            'subject_id': row[1],
            'display_name': row[2],
            'scope': row[3],
            'default_answer_mode': row[4],
        }
        for row in await cursor.fetchall()
    ]


async def list_knowledge_points(
    conn, subject: str, parent_id: int | None, query: str, cursor_str: str, requested_limit: int
) -> Page[dict]:
    limit = clamp_positive(requested_limit, 50, 200)
    offset = parse_page_cursor(cursor_str)
    cursor = await conn.execute(
        """
        SELECT id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at
        FROM knowledge_points
        WHERE (%s::text IS NULL OR subject_id = %s)
          AND ((%s::bigint IS NULL AND parent_id IS NULL) OR parent_id = %s)
          AND (%s::text IS NULL OR code ILIKE %s OR display_name ILIKE %s)
        ORDER BY display_name, id
        LIMIT %s OFFSET %s
        """,
        (
            helpers.trimmed_or_none(subject), helpers.trimmed_or_none(subject),
            parent_id, parent_id,
            helpers.ilike_or_none(query), helpers.ilike_or_none(query), helpers.ilike_or_none(query),
            limit + 1, offset,
        ),
    )
    items = [
        {
            'id': row[0],
            'subject_id': row[1],
            'code': row[2],
            'display_name': row[3],
            'parent_id': row[4],
            'metadata_json': row[5],
            'created_at': helpers.format_timestamp(row[6]),
            'updated_at': helpers.format_timestamp(row[7]),
        }
        for row in await cursor.fetchall()
    ]
    return build_page(items, limit, offset)
