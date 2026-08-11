"""Question service. Mirrors backend/internal/services/questions.go."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from psycopg_pool import AsyncConnectionPool

from .. import envelope
from ..auth.runtime import User
from . import helpers, reference
from .banks import require_bank_owner

QUESTION_COLUMNS = (
    'id, business_type, subject_id, question_type_id, answer_mode, choice_variant, '
    'hierarchy_level, hierarchy_path, chapter_ref, chapter_title, chapter_order, '
    'content_mode, stem, analysis, detail_payload, status, source_type, source_ref, '
    'source_job_id, imported_by, created_at, updated_at'
)

PERSIST_IMPORTED_QUESTION_CLAIM_SQL = """
    UPDATE question_import_jobs
    SET updated_at = NOW()
    WHERE id = %s
      AND status = 'processing'
      AND stage = 'persisting'
      AND claim_version = %s
    RETURNING id
"""


class ClaimLostError(Exception):
    """Raised when the import job claim fence no longer matches."""


def _scan_question(row: tuple) -> dict:
    return {
        'id': row[0],
        'business_type': row[1],
        'subject_id': row[2],
        'question_type_id': row[3],
        'answer_mode': row[4],
        'choice_variant': row[5],
        'hierarchy_level': row[6],
        'hierarchy_path': row[7],
        'chapter_ref': row[8],
        'chapter_title': row[9],
        'chapter_order': row[10],
        'content_mode': row[11],
        'stem': row[12],
        'analysis': row[13],
        'detail_payload': row[14],
        'status': row[15],
        'source_type': row[16],
        'source_ref': row[17],
        'source_job_id': row[18],
        'imported_by': row[19],
        'created_at': helpers.format_timestamp(row[20]),
        'updated_at': helpers.format_timestamp(row[21]),
    }


def _decode_json_list(raw) -> list:
    if raw is None:
        return []
    if isinstance(raw, str):
        return json.loads(raw) if raw else []
    return list(raw)


async def get_question(pool: AsyncConnectionPool, user: User, question_id: int) -> dict:
    detail = await _load_question_detail(pool, user, question_id)
    if detail['can_edit']:
        return detail
    return _learner_question_detail(detail)


async def get_question_for_editor(pool: AsyncConnectionPool, user: User, question_id: int) -> dict:
    await ensure_question_editable(pool, user, question_id)
    detail = await _load_question_detail(pool, user, question_id)
    detail['can_edit'] = True
    return detail


async def _load_question_detail(pool: AsyncConnectionPool, user: User, question_id: int) -> dict:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            f"""
            SELECT
                {QUESTION_COLUMNS},
                COALESCE(
                    (
                        SELECT json_agg(qo.* ORDER BY qo.sort_order)
                        FROM question_options qo
                        WHERE qo.question_id = q.id
                    ),
                    '[]'::json
                ) AS options,
                COALESCE(
                    (
                        SELECT json_agg(qak.* ORDER BY qak.version)
                        FROM question_answer_keys qak
                        WHERE qak.question_id = q.id
                    ),
                    '[]'::json
                ) AS answer_keys,
                COALESCE(
                    (
                        SELECT json_agg(qcb.* ORDER BY qcb.sequence)
                        FROM question_content_blocks qcb
                        WHERE qcb.question_id = q.id
                    ),
                    '[]'::json
                ) AS content_blocks,
                COALESCE(
                    (
                        SELECT json_agg(qml.* ORDER BY qml.sort_order)
                        FROM question_media_links qml
                        WHERE qml.question_id = q.id
                    ),
                    '[]'::json
                ) AS media_links,
                EXISTS (
                    SELECT 1
                    FROM v_bank_question_items owner_item
                    JOIN user_bank_links owner_link ON owner_link.bank_id = owner_item.bank_id
                    WHERE owner_item.question_id = q.id
                      AND owner_link.user_id = %s
                      AND owner_link.is_owner = true
                ) AS can_edit
            FROM questions q
            WHERE q.id = %s
              AND EXISTS (
                SELECT 1
                FROM v_bank_question_items item
                JOIN question_banks b ON b.id = item.bank_id
                LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = %s
                WHERE item.question_id = q.id
                  AND (
                    ubl.is_owner = true
                    OR (
                        (b.is_public = true OR ubl.id IS NOT NULL)
                        AND q.status = 'active'
                        AND item.question_status = 'active'
                        AND item.bank_link_status = 'active'
                    )
                  )
              )
            LIMIT 1
            """,
            (user.id, question_id, user.id),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Question not found')
    detail = _scan_question(row)
    detail['options'] = _decode_json_list(row[22])
    detail['answer_keys'] = _decode_json_list(row[23])
    detail['content_blocks'] = _decode_json_list(row[24])
    detail['media_links'] = _decode_json_list(row[25])
    detail['can_edit'] = row[26]
    return detail


def _learner_question_detail(detail: dict) -> dict:
    options = [
        {
            'id': option['id'],
            'question_id': option['question_id'],
            'option_label': option['option_label'],
            'sort_order': option['sort_order'],
            'content': option['content'],
        }
        for option in detail['options']
    ]
    blocks = [
        block for block in detail['content_blocks']
        if block.get('owner_kind') in ('question', 'stem')
    ]
    return {
        'id': detail['id'],
        'business_type': detail['business_type'],
        'subject_id': detail['subject_id'],
        'question_type_id': detail['question_type_id'],
        'answer_mode': detail['answer_mode'],
        'choice_variant': detail['choice_variant'],
        'content_mode': detail['content_mode'],
        'stem': detail['stem'],
        'status': detail['status'],
        'options': options,
        'content_blocks': blocks,
        'media_links': detail['media_links'],
        'can_edit': False,
    }


@dataclass
class QuestionOptionInput:
    label: str
    content: str
    is_correct: bool


@dataclass
class CreateQuestionInput:
    question_type_id: str
    answer_mode: str
    stem: str
    analysis: str | None = None
    choice_variant: str | None = None
    status: str = ''
    options: list[QuestionOptionInput] = field(default_factory=list)
    answer_payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class QuestionContentBlockInput:
    part_type: str
    owner_kind: str | None = None
    role: str | None = None
    sequence: int | None = None
    content_mode: str | None = None
    text_format: str | None = None
    text_value: str | None = None
    latex_value: str | None = None
    mathml_value: str | None = None
    html_value: str | None = None
    markdown_value: str | None = None
    json_value: Any = None
    media_id: int | None = None


@dataclass
class PersistImportedQuestionInput:
    job_id: int
    claim_version: int
    question: CreateQuestionInput
    content_blocks: list[QuestionContentBlockInput]
    confidence: float
    output_metadata: dict[str, Any]


def _validate_create_question_input(input: CreateQuestionInput) -> None:
    details: list[envelope.ValidationDetail] = []
    if not input.question_type_id.strip():
        details.append(envelope.ValidationDetail('questionTypeId', 'is required'))
    if input.answer_mode.strip() not in ('choice', 'true_false', 'fill_blank', 'short_answer'):
        details.append(
            envelope.ValidationDetail('answerMode', 'must be one of choice, true_false, fill_blank, short_answer')
        )
    if not input.stem.strip():
        details.append(envelope.ValidationDetail('stem', 'is required'))
    if input.choice_variant is not None:
        variant = input.choice_variant.strip()
        if input.answer_mode.strip() != 'choice' or variant not in ('single', 'multiple'):
            details.append(
                envelope.ValidationDetail('choiceVariant', 'must be single or multiple for choice questions')
            )
    if details:
        raise envelope.validation_error(details)


def _normalize_question_status_or_default(status: str, fallback: str) -> str:
    status = status.strip()
    if not status:
        return fallback
    if status in ('draft', 'active', 'archived'):
        return status
    raise envelope.new_error(422, 'VALIDATION_ERROR', 'Invalid question status')


def _question_object_value(payload: dict | None, key: str):
    if payload is None:
        return None
    return payload.get(key)


def _normalize_question_string_array(value) -> list[str]:
    if value is None:
        return []
    items = value if isinstance(value, list) else [value]
    out = []
    for item in items:
        text = str(item).strip()
        if text:
            out.append(text)
    return out


def selected_answer_values(payload: dict | None) -> list[str]:
    for key in ('selected', 'correctOptions', 'correctOption'):
        values = _normalize_question_string_array(_question_object_value(payload, key))
        if values:
            return values
    return []


def _canonical_choice_answer_payload(payload: dict, selected: list[str]) -> dict:
    result = dict(payload)
    result.pop('correctOption', None)
    result.pop('correctOptions', None)
    result['selected'] = selected
    return result


def _normalize_question_text(value) -> str:
    return ' '.join(str(value).strip().lower().split())


def _question_fill_blank_values(payload: dict | None) -> list[str]:
    direct = _question_object_value(payload, 'value')
    if isinstance(direct, list):
        return [_normalize_question_text(item) for item in direct]
    if direct is not None:
        return [_normalize_question_text(direct)]
    slots = _question_object_value(payload, 'slots')
    if not isinstance(slots, list):
        return []
    values = []
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        nested = slot.get('value') if slot.get('value') is not None else slot.get('answers')
        if isinstance(nested, list):
            values.extend(_normalize_question_text(item) for item in nested)
        else:
            values.append(_normalize_question_text(nested))
    return values


def has_usable_answer_payload(mode: str, payload: dict | None) -> bool:
    if payload is None:
        return False
    if mode == 'choice':
        return len(selected_answer_values(payload)) > 0
    if mode == 'true_false':
        return isinstance(payload.get('value'), bool)
    if mode == 'fill_blank':
        return any(value != '' for value in _question_fill_blank_values(payload))
    return _normalize_question_text(payload.get('value')) != ''


def _validate_question_payload(
    answer_mode: str, status: str, options: list[QuestionOptionInput], answer_payload: dict | None
) -> None:
    mode = answer_mode.strip()
    if mode != 'choice' and options:
        raise envelope.new_error(422, 'VALIDATION_ERROR', 'Options are only supported for choice questions')
    if mode == 'choice':
        labels: set[str] = set()
        if len(options) > 32767:
            raise envelope.validation_error(
                [envelope.ValidationDetail('options', 'must contain no more than 32767 items')]
            )
        for option in options:
            label = option.label.strip()
            if not label or len(label) > 16 or not option.content.strip():
                raise envelope.new_error(
                    422, 'VALIDATION_ERROR',
                    'Choice options require a label of at most 16 characters and non-empty content',
                )
            if label in labels:
                raise envelope.new_error(
                    422, 'VALIDATION_ERROR', 'Choice option labels must be unique and non-empty'
                )
            labels.add(label)
        for label in selected_answer_values(answer_payload):
            if label not in labels:
                raise envelope.new_error(
                    422, 'VALIDATION_ERROR', 'Choice answer must reference existing option labels'
                )
    if status.strip() == 'active':
        has_answer = has_usable_answer_payload(mode, answer_payload)
        if mode == 'choice' and not has_answer:
            has_answer = any(option.is_correct for option in options)
        if not has_answer:
            raise envelope.new_error(
                409, 'INVALID_STATE', 'Active questions require a usable answer payload'
            )
        if mode == 'choice':
            correct = len(selected_answer_values(answer_payload)) > 0 or any(
                option.is_correct for option in options
            )
            if len(options) < 2 or not correct:
                raise envelope.new_error(
                    409, 'INVALID_STATE',
                    'Active choice questions require at least two options and one correct option',
                )


async def _prepare_question_create(
    pool: AsyncConnectionPool, user: User, bank_id: int, input: CreateQuestionInput
) -> tuple[str, str, str]:
    _validate_create_question_input(input)
    async with pool.connection() as conn:
        _, subject = await require_bank_owner(conn, user, bank_id)
        _validate_question_payload(input.answer_mode, input.status, input.options, input.answer_payload)
        question_type_id = await reference.resolve_question_type_id_for_subject(
            conn, subject, input.question_type_id.strip(), input.answer_mode.strip(), 'question'
        )
    status = _normalize_question_status_or_default(input.status, 'draft')
    return subject, question_type_id, status


async def _create_question_tx(
    conn, user: User, bank_id: int, subject: str, question_type_id: str, status: str,
    input: CreateQuestionInput,
) -> dict:
    await conn.execute('SELECT id FROM question_banks WHERE id = %s FOR UPDATE', (bank_id,))
    cursor = await conn.execute(
        """
        SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
        FROM bank_question_links
        WHERE bank_id = %s
        """,
        (bank_id,),
    )
    next_sort = (await cursor.fetchone())[0]

    choice_variant = input.choice_variant.strip() if input.choice_variant is not None else None
    cursor = await conn.execute(
        f"""
        INSERT INTO questions (
            subject_id, question_type_id, answer_mode, choice_variant,
            stem, analysis, status, source_type, imported_by
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, 'manual', %s)
        RETURNING {QUESTION_COLUMNS}
        """,
        (
            subject, question_type_id, input.answer_mode.strip(), choice_variant,
            input.stem.strip(), input.analysis, status, user.id,
        ),
    )
    created = _scan_question(await cursor.fetchone())

    answer_payload = dict(input.answer_payload or {})
    correct_labels = selected_answer_values(answer_payload)
    if created['answer_mode'] == 'choice':
        if not correct_labels:
            correct_labels = [option.label.strip() for option in input.options if option.is_correct]
        answer_payload = _canonical_choice_answer_payload(answer_payload, correct_labels)
    await conn.execute(
        """
        INSERT INTO question_answer_keys (question_id, answer_mode, answer_payload)
        VALUES (%s, %s, %s)
        """,
        (created['id'], created['answer_mode'], helpers.json_or_empty_object(answer_payload)),
    )

    if created['answer_mode'] == 'choice':
        correct = set(correct_labels)
        for index, option in enumerate(input.options):
            await conn.execute(
                """
                INSERT INTO question_options (question_id, option_label, sort_order, content, is_correct)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    created['id'], option.label.strip(), index + 1,
                    option.content.strip(), option.label.strip() in correct,
                ),
            )

    await conn.execute(
        """
        INSERT INTO bank_question_links (bank_id, question_id, sort_order, status, added_by)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (bank_id, created['id'], next_sort, status, user.id),
    )
    await conn.execute(
        'UPDATE question_banks SET total_count = total_count + 1 WHERE id = %s', (bank_id,)
    )
    return created


async def create_question(
    pool: AsyncConnectionPool, user: User, bank_id: int, input: CreateQuestionInput
) -> dict:
    subject, question_type_id, status = await _prepare_question_create(pool, user, bank_id, input)
    async with pool.connection() as conn:
        async with conn.transaction():
            return await _create_question_tx(conn, user, bank_id, subject, question_type_id, status, input)


async def persist_imported_question(
    pool: AsyncConnectionPool, user: User, bank_id: int, input: PersistImportedQuestionInput
) -> dict:
    subject, question_type_id, status = await _prepare_question_create(pool, user, bank_id, input.question)
    metadata = helpers.json_or_empty_object(input.output_metadata)
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                PERSIST_IMPORTED_QUESTION_CLAIM_SQL, (input.job_id, input.claim_version)
            )
            row = await cursor.fetchone()
            if row is None:
                raise ClaimLostError()
            job_id = row[0]
            question = await _create_question_tx(
                conn, user, bank_id, subject, question_type_id, status, input.question
            )
            await conn.execute(
                """
                UPDATE questions
                SET source_type = 'imported', source_job_id = %s
                WHERE id = %s
                """,
                (input.job_id, question['id']),
            )
            question['source_type'] = 'imported'
            question['source_job_id'] = input.job_id
            await _replace_question_content_blocks_tx(conn, question['id'], input.content_blocks)
            await conn.execute(
                """
                INSERT INTO question_import_job_outputs (job_id, output_kind, question_id, confidence, metadata_json)
                VALUES (%s, 'question', %s, %s, %s)
                """,
                (job_id, question['id'], input.confidence, metadata),
            )
            return question


async def update_question(
    pool: AsyncConnectionPool, user: User, question_id: int,
    stem: str | None, analysis: str | None, analysis_set: bool,
) -> dict:
    if stem is None and not analysis_set:
        raise envelope.validation_error(
            [envelope.ValidationDetail('body', 'must include stem or analysis')]
        )
    if stem is not None:
        stem = stem.strip()
        if not stem:
            raise envelope.validation_error([envelope.ValidationDetail('stem', 'is required')])
    if analysis_set and analysis is not None:
        analysis = analysis.strip()
    await ensure_question_editable(pool, user, question_id)
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                f"""
                UPDATE questions
                SET
                    stem = COALESCE(%s, stem),
                    analysis = CASE WHEN %s THEN %s ELSE analysis END
                WHERE id = %s
                RETURNING {QUESTION_COLUMNS}
                """,
                (stem, analysis_set, analysis, question_id),
            )
            return _scan_question(await cursor.fetchone())


async def delete_question(pool: AsyncConnectionPool, user: User, question_id: int) -> None:
    await ensure_question_editable(pool, user, question_id)
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                'SELECT DISTINCT bank_id FROM v_bank_question_items WHERE question_id = %s',
                (question_id,),
            )
            bank_ids = [row[0] for row in await cursor.fetchall()]
            await conn.execute('DELETE FROM questions WHERE id = %s', (question_id,))
            for bank_id in bank_ids:
                await conn.execute(
                    """
                    UPDATE question_banks
                    SET total_count = GREATEST(total_count - 1, 0)
                    WHERE id = %s
                    """,
                    (bank_id,),
                )


async def set_question_status(
    pool: AsyncConnectionPool, user: User, question_id: int, status: str
) -> dict:
    normalized = _normalize_question_status_or_default(status, '')
    if normalized == 'active':
        await _assert_question_publishable(pool, user, question_id)
    await ensure_question_editable(pool, user, question_id)
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                f"""
                UPDATE questions
                SET status = %s
                WHERE id = %s
                RETURNING {QUESTION_COLUMNS}
                """,
                (normalized, question_id),
            )
            updated = _scan_question(await cursor.fetchone())
            await conn.execute(
                'UPDATE bank_question_links SET status = %s WHERE question_id = %s',
                (normalized, question_id),
            )
            return updated


async def upsert_answer_key(
    pool: AsyncConnectionPool, user: User, question_id: int,
    answer_mode: str, answer_payload: dict, explanation_payload: dict, score_payload: dict,
) -> dict:
    await ensure_question_editable(pool, user, question_id)
    mode = answer_mode.strip()
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                'SELECT answer_mode FROM questions WHERE id = %s FOR UPDATE', (question_id,)
            )
            question_mode = (await cursor.fetchone())[0]
            if mode != question_mode:
                raise envelope.validation_error(
                    [envelope.ValidationDetail('answerMode', 'must match the question answer mode')]
                )
            if mode == 'choice':
                cursor = await conn.execute(
                    'SELECT option_label FROM question_options WHERE question_id = %s', (question_id,)
                )
                labels = {row[0] for row in await cursor.fetchall()}
                for label in selected_answer_values(answer_payload):
                    if label not in labels:
                        raise envelope.validation_error(
                            [envelope.ValidationDetail('answerPayload', 'must reference existing option labels')]
                        )
            cursor = await conn.execute(
                """
                INSERT INTO question_answer_keys (
                    question_id, answer_mode, version, is_primary,
                    answer_payload, explanation_payload, score_payload
                )
                VALUES (%s, %s, 1, true, %s, %s, %s)
                ON CONFLICT (question_id) WHERE is_primary
                DO UPDATE SET
                    answer_mode = EXCLUDED.answer_mode,
                    answer_payload = EXCLUDED.answer_payload,
                    explanation_payload = EXCLUDED.explanation_payload,
                    score_payload = EXCLUDED.score_payload
                RETURNING id, question_id, answer_mode, version, is_primary,
                          answer_payload, explanation_payload, score_payload, created_at, updated_at
                """,
                (
                    question_id, mode,
                    helpers.json_or_empty_object(answer_payload),
                    helpers.json_or_empty_object(explanation_payload),
                    helpers.json_or_empty_object(score_payload),
                ),
            )
            row = await cursor.fetchone()
            answer_key = {
                'id': row[0],
                'question_id': row[1],
                'answer_mode': row[2],
                'version': row[3],
                'is_primary': row[4],
                'answer_payload': row[5],
                'explanation_payload': row[6],
                'score_payload': row[7],
                'created_at': helpers.format_timestamp(row[8]),
                'updated_at': helpers.format_timestamp(row[9]),
            }
            if mode == 'choice':
                selected = selected_answer_values(answer_payload)
                await conn.execute(
                    """
                    UPDATE question_options
                    SET is_correct = option_label = ANY(%s::text[])
                    WHERE question_id = %s
                    """,
                    (selected, question_id),
                )
            return answer_key


async def create_option(
    pool: AsyncConnectionPool, user: User, question_id: int,
    label: str, content: str, is_correct: bool, sort_order: int | None,
) -> dict:
    label, content = label.strip(), content.strip()
    details: list[envelope.ValidationDetail] = []
    if not label or len(label) > 16:
        details.append(envelope.ValidationDetail('label', 'must be 1-16 characters'))
    if not content:
        details.append(envelope.ValidationDetail('content', 'is required'))
    if sort_order is not None and (sort_order < 1 or sort_order > 32767):
        details.append(envelope.ValidationDetail('sortOrder', 'must be between 1 and 32767'))
    if details:
        raise envelope.validation_error(details)
    await ensure_question_editable(pool, user, question_id)
    async with pool.connection() as conn:
        async with conn.transaction():
            if sort_order is None:
                cursor = await conn.execute(
                    """
                    SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
                    FROM question_options
                    WHERE question_id = %s
                    """,
                    (question_id,),
                )
                sort_order = (await cursor.fetchone())[0]
            cursor = await conn.execute(
                """
                INSERT INTO question_options (question_id, option_label, sort_order, content, is_correct)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id, question_id, option_label, sort_order, content, is_correct, created_at, updated_at
                """,
                (question_id, label, sort_order, content, is_correct),
            )
            option = _scan_option(await cursor.fetchone())
            await _sync_choice_answer_key_from_options(conn, question_id)
            return option


def _scan_option(row: tuple) -> dict:
    return {
        'id': row[0],
        'question_id': row[1],
        'option_label': row[2],
        'sort_order': row[3],
        'content': row[4],
        'is_correct': row[5],
        'created_at': helpers.format_timestamp(row[6]),
        'updated_at': helpers.format_timestamp(row[7]),
    }


async def update_option(
    pool: AsyncConnectionPool, user: User, question_id: int, option_id: int,
    label: str | None, content: str | None, is_correct: bool | None, sort_order: int | None,
) -> dict:
    if label is None and content is None and is_correct is None and sort_order is None:
        raise envelope.validation_error(
            [envelope.ValidationDetail('body', 'must include a field to update')]
        )
    details: list[envelope.ValidationDetail] = []
    if label is not None:
        label = label.strip()
        if not label or len(label) > 16:
            details.append(envelope.ValidationDetail('label', 'must be 1-16 characters'))
    if content is not None:
        content = content.strip()
        if not content:
            details.append(envelope.ValidationDetail('content', 'is required'))
    if sort_order is not None and (sort_order < 1 or sort_order > 32767):
        details.append(envelope.ValidationDetail('sortOrder', 'must be between 1 and 32767'))
    if details:
        raise envelope.validation_error(details)
    await ensure_question_editable(pool, user, question_id)
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                """
                UPDATE question_options
                SET
                    option_label = COALESCE(%s, option_label),
                    content = COALESCE(%s, content),
                    is_correct = COALESCE(%s, is_correct),
                    sort_order = COALESCE(%s, sort_order)
                WHERE id = %s
                  AND question_id = %s
                RETURNING id, question_id, option_label, sort_order, content, is_correct, created_at, updated_at
                """,
                (label, content, is_correct, sort_order, option_id, question_id),
            )
            row = await cursor.fetchone()
            if row is None:
                raise envelope.new_error(404, 'NOT_FOUND', 'Option not found')
            option = _scan_option(row)
            await _sync_choice_answer_key_from_options(conn, question_id)
            return option


async def delete_option(pool: AsyncConnectionPool, user: User, question_id: int, option_id: int) -> None:
    await ensure_question_editable(pool, user, question_id)
    async with pool.connection() as conn:
        async with conn.transaction():
            result = await conn.execute(
                'DELETE FROM question_options WHERE id = %s AND question_id = %s',
                (option_id, question_id),
            )
            if result.rowcount == 0:
                raise envelope.new_error(404, 'NOT_FOUND', 'Option not found')
            await _sync_choice_answer_key_from_options(conn, question_id)


async def replace_question_content_blocks(
    pool: AsyncConnectionPool, user: User, question_id: int, blocks: list[QuestionContentBlockInput]
) -> None:
    await ensure_question_editable(pool, user, question_id)
    for block in blocks:
        if block.media_id is not None:
            from .media import ensure_media_owned  # avoid circular import
            await ensure_media_owned(pool, user, block.media_id)
    async with pool.connection() as conn:
        async with conn.transaction():
            await _replace_question_content_blocks_tx(conn, question_id, blocks)


def _validate_question_content_blocks(blocks: list[QuestionContentBlockInput]) -> None:
    if len(blocks) > 1000:
        raise envelope.validation_error(
            [envelope.ValidationDetail('blocks', 'must contain no more than 1000 items')]
        )
    details: list[envelope.ValidationDetail] = []
    for index, block in enumerate(blocks):
        prefix = f'blocks.{index}.'
        owner_kind = (block.owner_kind or 'question').strip() or 'question'
        block.owner_kind = owner_kind
        if owner_kind not in ('question', 'stem', 'answer_key', 'analysis', 'explanation'):
            details.append(envelope.ValidationDetail(prefix + 'ownerKind', 'is invalid for a question block'))
        block.part_type = block.part_type.strip()
        if block.part_type not in (
            'text', 'formula', 'image', 'table', 'list', 'html', 'markdown', 'chart', 'diagram', 'qr_code'
        ):
            details.append(envelope.ValidationDetail(prefix + 'partType', 'is invalid'))
        if block.sequence is not None and block.sequence <= 0:
            details.append(envelope.ValidationDetail(prefix + 'sequence', 'must be positive'))
        if block.content_mode is not None:
            mode = block.content_mode.strip()
            block.content_mode = mode
            if mode not in ('text_only', 'mixed_media', 'structured_rich'):
                details.append(envelope.ValidationDetail(prefix + 'contentMode', 'is invalid'))
        if block.role is not None and len(block.role) > 64:
            details.append(envelope.ValidationDetail(prefix + 'role', 'must be no more than 64 characters'))
        if block.text_format is not None and len(block.text_format) > 32:
            details.append(envelope.ValidationDetail(prefix + 'textFormat', 'must be no more than 32 characters'))
        if block.media_id is not None and block.media_id <= 0:
            details.append(envelope.ValidationDetail(prefix + 'mediaId', 'must be positive'))
    if details:
        raise envelope.validation_error(details)


async def _replace_question_content_blocks_tx(
    conn, question_id: int, blocks: list[QuestionContentBlockInput]
) -> None:
    _validate_question_content_blocks(blocks)
    await conn.execute('DELETE FROM question_content_blocks WHERE question_id = %s', (question_id,))
    for index, block in enumerate(blocks):
        owner_kind = block.owner_kind or 'question'
        sequence = index + 1
        if block.sequence is not None and block.sequence > 0:
            sequence = block.sequence
        json_value = _normalize_json_value(block.json_value)
        await conn.execute(
            """
            INSERT INTO question_content_blocks (
                question_id, owner_kind, role, part_type, sequence, content_mode,
                text_format, text_value, latex_value, mathml_value, html_value,
                markdown_value, json_value, media_id
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                question_id, owner_kind, block.role, block.part_type, sequence, block.content_mode,
                block.text_format, block.text_value, block.latex_value, block.mathml_value,
                block.html_value, block.markdown_value, json_value, block.media_id,
            ),
        )


def _normalize_json_value(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, separators=(',', ':'))


async def ensure_question_editable(pool: AsyncConnectionPool, user: User, question_id: int) -> None:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT q.id
            FROM questions q
            JOIN bank_question_links bql ON bql.question_id = q.id
            JOIN user_bank_links ubl ON ubl.bank_id = bql.bank_id
            WHERE q.id = %s
              AND ubl.user_id = %s
              AND ubl.is_owner = true
            LIMIT 1
            """,
            (question_id, user.id),
        )
        if await cursor.fetchone() is None:
            raise envelope.new_error(403, 'FORBIDDEN', 'Question editor access required')


async def _assert_question_publishable(pool: AsyncConnectionPool, user: User, question_id: int) -> None:
    await ensure_question_editable(pool, user, question_id)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT
                q.answer_mode,
                (SELECT COUNT(*)::int FROM question_options qo WHERE qo.question_id = q.id) AS option_count,
                (SELECT COUNT(*)::int FROM question_options qo WHERE qo.question_id = q.id AND qo.is_correct = true) AS correct_option_count,
                (SELECT COUNT(*)::int FROM question_answer_keys qak WHERE qak.question_id = q.id AND qak.is_primary = true) AS answer_key_count,
                (SELECT qak.answer_payload FROM question_answer_keys qak WHERE qak.question_id = q.id AND qak.is_primary = true LIMIT 1) AS answer_payload
            FROM questions q
            WHERE q.id = %s
            LIMIT 1
            """,
            (question_id,),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Question not found')
    answer_mode, option_count, correct_option_count, answer_key_count, answer_payload = row
    if answer_key_count < 1:
        raise envelope.new_error(
            409, 'INVALID_STATE', 'Question requires a primary answer key before publishing'
        )
    if answer_mode == 'choice' and (option_count < 2 or correct_option_count < 1):
        raise envelope.new_error(
            409, 'INVALID_STATE', 'Choice question requires at least two options and one correct option'
        )
    payload: dict = {}
    if answer_payload and str(answer_payload).strip():
        try:
            payload = json.loads(answer_payload) if isinstance(answer_payload, str) else answer_payload
        except (TypeError, ValueError):
            payload = {}
    if not has_usable_answer_payload(answer_mode, payload):
        raise envelope.new_error(
            409, 'INVALID_STATE', 'Question requires a usable primary answer payload before publishing'
        )


async def _sync_choice_answer_key_from_options(conn, question_id: int) -> None:
    cursor = await conn.execute(
        """
        SELECT
            q.answer_mode,
            (SELECT answer_payload FROM question_answer_keys WHERE question_id = q.id AND is_primary = true LIMIT 1)
        FROM questions q
        WHERE q.id = %s
        """,
        (question_id,),
    )
    row = await cursor.fetchone()
    if row is None:
        return
    mode, raw = row
    if mode != 'choice' or raw is None:
        return
    cursor = await conn.execute(
        """
        SELECT option_label
        FROM question_options
        WHERE question_id = %s AND is_correct = true
        ORDER BY sort_order, id
        """,
        (question_id,),
    )
    selected = [r[0] for r in await cursor.fetchall()]
    payload: dict = {}
    if str(raw).strip():
        payload = json.loads(raw) if isinstance(raw, str) else raw
    await conn.execute(
        """
        UPDATE question_answer_keys
        SET answer_payload = %s
        WHERE question_id = %s AND is_primary = true
        """,
        (helpers.json_or_empty_object(_canonical_choice_answer_payload(payload, selected)), question_id),
    )
