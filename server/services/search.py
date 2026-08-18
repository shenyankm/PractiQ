
from .. import envelope
from ..auth.runtime import User
from . import helpers
from .pagination import Page, build_page, parse_page_cursor


async def search_questions(
    conn, user: User, bank_id_raw: str, type_raw: str, status_raw: str,
    limit_raw: str, cursor_str: str, query: str,
) -> Page[dict]:
    bank_id = None
    if bank_id_raw.strip():
        try:
            bank_id = int(bank_id_raw.strip())
        except ValueError as exc:
            raise envelope.validation_error(
                [envelope.ValidationDetail('bankId', 'must be a positive integer')]
            ) from exc
        if bank_id < 1:
            raise envelope.validation_error(
                [envelope.ValidationDetail('bankId', 'must be a positive integer')]
            )
    type_filter = helpers.trimmed_or_none(type_raw)
    status_filter = helpers.trimmed_or_none(status_raw)
    if status_filter is not None and status_filter not in ('draft', 'active', 'archived'):
        raise envelope.validation_error(
            [envelope.ValidationDetail('status', 'must be one of draft, active, archived')]
        )
    limit = 50
    if limit_raw.strip():
        try:
            limit = int(limit_raw.strip())
        except ValueError as exc:
            raise envelope.validation_error(
                [envelope.ValidationDetail('limit', 'must be between 1 and 100')]
            ) from exc
        if limit < 1 or limit > 100:
            raise envelope.validation_error(
                [envelope.ValidationDetail('limit', 'must be between 1 and 100')]
            )
    offset = parse_page_cursor(cursor_str)
    term = helpers.trimmed_or_none(query.strip())

    cursor = await conn.execute(
        """
        WITH visible_question_ids AS MATERIALIZED (
          SELECT item.question_id, BOOL_OR(COALESCE(ubl.is_owner, false)) AS can_edit
          FROM v_bank_question_items item
          JOIN question_banks b ON b.id = item.bank_id
          LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = %s
          WHERE (%s::bigint IS NULL OR item.bank_id = %s)
            AND (
              COALESCE(ubl.is_owner, false) = true
              OR (
                (b.is_public = true OR ubl.id IS NOT NULL)
                AND item.question_status = 'active'
                AND item.bank_link_status = 'active'
              )
            )
          GROUP BY item.question_id
        ),
        searchable_questions AS MATERIALIZED (
          SELECT q.*, vq.can_edit
          FROM visible_question_ids vq
          JOIN questions q ON q.id = vq.question_id
          WHERE (%s::text IS NULL OR q.question_type_id = %s)
            AND (%s::text IS NULL OR q.status = %s)
            AND (vq.can_edit OR q.status = 'active')
        ),
        query AS (
          SELECT
            %s::text AS term,
            CASE
              WHEN %s::text IS NULL THEN NULL
              ELSE plainto_tsquery('simple', %s::text)
            END AS tsq
        )
        SELECT sq.id, sq.business_type, sq.subject_id, sq.question_type_id, sq.answer_mode, sq.choice_variant,
               sq.stem, CASE WHEN sq.can_edit THEN sq.analysis ELSE NULL END, sq.status, sq.can_edit
        FROM searchable_questions sq
        CROSS JOIN query
        WHERE query.term IS NULL
           OR sq.stem ILIKE '%' || query.term || '%'
           OR to_tsvector('simple', COALESCE(sq.stem, '')) @@ query.tsq
        ORDER BY
          CASE
            WHEN query.tsq IS NULL THEN 0
            ELSE ts_rank_cd(to_tsvector('simple', COALESCE(sq.stem, '')), query.tsq)
          END DESC,
          sq.updated_at DESC
        LIMIT %s OFFSET %s
        """,
        (
            user.id, bank_id, bank_id,
            type_filter, type_filter, status_filter, status_filter,
            term, term, term,
            limit + 1, offset,
        ),
    )
    items = [
        {
            'id': row[0],
            'business_type': row[1],
            'subject_id': row[2],
            'question_type_id': row[3],
            'answer_mode': row[4],
            'choice_variant': row[5],
            'stem': row[6],
            'analysis': row[7],
            'status': row[8],
            'can_edit': row[9],
        }
        for row in await cursor.fetchall()
    ]
    return build_page(items, limit, offset)
