"""Practice session service. Mirrors backend/internal/services/practice.go + practice_helpers.go."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

from psycopg_pool import AsyncConnectionPool

from .. import envelope, redisx
from ..auth.runtime import User
from . import helpers
from .banks import get_bank
from .pagination import Page, build_page, parse_page_cursor
from .questions import (
    _normalize_question_text,
    _question_fill_blank_values,
    _question_object_value,
    selected_answer_values,
)

PRACTICE_MODE_ALL = 'all'
PRACTICE_MODE_WRONG = 'wrong'
PRACTICE_MODE_BY_TYPE = 'by_type'
PRACTICE_MODE_EXAM = 'exam'
MAX_PRACTICE_QUESTIONS = 500

SESSION_COLUMNS = (
    'id, user_id, bank_id, session_type, status, question_count, answered_count, '
    'correct_count, wrong_count, score, started_at, completed_at'
)


def _scan_session(row: tuple) -> dict:
    return {
        'id': row[0],
        'user_id': row[1],
        'bank_id': row[2],
        'session_type': row[3],
        'status': row[4],
        'question_count': row[5],
        'answered_count': row[6],
        'correct_count': row[7],
        'wrong_count': row[8],
        'score': row[9],
        'started_at': helpers.format_timestamp(row[10]),
        'completed_at': helpers.format_nullable_timestamp(row[11]),
    }


def _scan_answer(row: tuple) -> dict:
    payload = row[6]
    if isinstance(payload, str):
        payload = json.loads(payload) if payload else {}
    return {
        'id': row[0],
        'user_id': row[1],
        'session_id': row[2],
        'bank_id': row[3],
        'question_id': row[4],
        'answer_key_id': row[5],
        'answer_payload': payload or {},
        'is_correct': row[7],
        'score': row[8],
        'max_score': row[9],
        'duration_ms': row[10],
        'answered_at': helpers.format_timestamp(row[11]),
    }


def _normalize_practice_mode(mode: str, session_type: str) -> str:
    if mode:
        return mode
    if session_type == 'review':
        return PRACTICE_MODE_WRONG
    if session_type == 'exam':
        return PRACTICE_MODE_EXAM
    return PRACTICE_MODE_ALL


def _normalize_question_count(question_count: int, all_questions: bool) -> int:
    if all_questions:
        return MAX_PRACTICE_QUESTIONS
    return min(max(question_count, 1), MAX_PRACTICE_QUESTIONS)


def _practice_queue_ttl_seconds() -> int:
    raw = os.environ.get('PRACTICE_QUEUE_TTL_SECONDS', '').strip()
    try:
        value = int(raw)
    except ValueError:
        value = 7 * 24 * 3600
    return value if value > 0 else 7 * 24 * 3600


def _practice_question_queue_key(session_id: int) -> str:
    return redisx.redis_key('practice', session_id, 'question-ids')


@dataclass
class PracticeSessionInput:
    bank_id: int
    session_type: str = ''
    question_count: int = 0
    mode: str = ''
    question_type_id: str | None = None
    all_questions: bool = False


async def start_practice_session(
    pool: AsyncConnectionPool, user: User, input: PracticeSessionInput
) -> dict:
    await get_bank(pool, user, input.bank_id)
    mode = _normalize_practice_mode(input.mode.strip(), input.session_type.strip())
    question_type_id = (input.question_type_id or '').strip()
    if mode == PRACTICE_MODE_BY_TYPE and not question_type_id:
        raise envelope.new_error(
            422, 'VALIDATION_ERROR', 'Question type is required for type-based practice'
        )
    count = _normalize_question_count(
        input.question_count, input.all_questions or (mode == PRACTICE_MODE_ALL and input.question_count < 1)
    )
    question_ids = await _load_practice_question_ids(pool, user, input.bank_id, count, mode, question_type_id)
    if not question_ids:
        message = 'No active questions are available for practice'
        if mode == PRACTICE_MODE_WRONG:
            message = 'No wrong questions are available for review'
        raise envelope.new_error(409, 'INVALID_STATE', message)

    session_type = 'practice'
    if mode == PRACTICE_MODE_EXAM:
        session_type = 'exam'
    elif mode == PRACTICE_MODE_WRONG:
        session_type = 'review'
    elif input.session_type.strip():
        session_type = input.session_type.strip()

    async with pool.connection() as conn:
        cursor = await conn.execute(
            f"""
            INSERT INTO user_practice_sessions (user_id, bank_id, session_type, question_count)
            VALUES (%s, %s, %s, %s)
            RETURNING {SESSION_COLUMNS}
            """,
            (user.id, input.bank_id, session_type, len(question_ids)),
        )
        session = _scan_session(await cursor.fetchone())
    rdb = redisx.client()
    if rdb is not None:
        await redisx.set_json(
            rdb, _practice_question_queue_key(session['id']), question_ids, _practice_queue_ttl_seconds()
        )
    return session


async def get_practice_session(pool: AsyncConnectionPool, user: User, session_id: int) -> dict:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            f"""
            SELECT {SESSION_COLUMNS}
            FROM user_practice_sessions
            WHERE id = %s AND user_id = %s
            LIMIT 1
            """,
            (session_id, user.id),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Practice session not found')
    return _scan_session(row)


async def get_practice_questions(pool: AsyncConnectionPool, user: User, session_id: int) -> list[dict]:
    session = await get_practice_session(pool, user, session_id)
    question_ids = await _ensure_practice_question_queue(pool, session)
    return await _load_practice_question_rows(pool, session, question_ids, 0, len(question_ids))


async def get_practice_question_page(
    pool: AsyncConnectionPool, user: User, session_id: int, index: int | None
) -> dict:
    session = await get_practice_session(pool, user, session_id)
    question_ids = await _ensure_practice_question_queue(pool, session)

    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT question_id, is_correct
            FROM user_question_answers
            WHERE user_id = %s
              AND session_id = %s
            ORDER BY answered_at, id
            """,
            (user.id, session_id),
        )
        answered: dict[int, bool | None] = {}
        for row in await cursor.fetchall():
            answered[row[0]] = row[1]

    fallback_index = 0
    for i, question_id in enumerate(question_ids):
        if question_id not in answered:
            fallback_index = i
            break
    current_index = fallback_index
    if index is not None:
        current_index = max(index, 0)
        if question_ids and current_index > len(question_ids) - 1:
            current_index = len(question_ids) - 1

    items = await _load_practice_question_rows(pool, session, question_ids, current_index, 1)
    question = items[0] if items else None
    result = None
    if question is not None:
        result = await _get_existing_practice_answer(pool, user.id, session_id, question['question_id'])
        result = _practice_answer_for_session(result, session)
        if _should_reveal_practice_feedback(session, result):
            async with pool.connection() as conn:
                cursor = await conn.execute(
                    'SELECT analysis FROM questions WHERE id = %s', (question['question_id'],)
                )
                row = await cursor.fetchone()
                if row is not None and row[0] is not None:
                    question['analysis'] = row[0]

    progress = [
        {
            'index': i,
            'questionId': question_id,
            'isAnswered': question_id in answered,
            'isCorrect': answered.get(question_id),
        }
        for i, question_id in enumerate(question_ids)
    ]
    if session['session_type'] == 'exam' and session['status'] == 'active':
        for item in progress:
            item['isCorrect'] = None

    page: dict[str, Any] = {
        'session': session,
        'question': question,
        'questionIndex': current_index if question is not None else 0,
        'total': len(question_ids),
        'answeredCount': len(answered),
        'progress': progress,
        'result': result,
        'previousIndex': current_index - 1 if question is not None and current_index > 0 else None,
        'nextIndex': current_index + 1 if question is not None and current_index < len(question_ids) - 1 else None,
    }
    return page


async def list_practice_sessions(
    pool: AsyncConnectionPool, user: User, limit: int, status: str, cursor_str: str
) -> Page[dict]:
    limit = min(max(limit, 1), 100) if limit >= 1 else 20
    offset = parse_page_cursor(cursor_str)
    status = status.strip()
    if status not in ('', 'active', 'completed', 'abandoned'):
        raise envelope.validation_error(
            [envelope.ValidationDetail('status', 'must be one of active, completed, abandoned')]
        )
    async with pool.connection() as conn:
        cursor = await conn.execute(
            f"""
            SELECT {SESSION_COLUMNS}
            FROM user_practice_sessions
            WHERE user_id = %s
              AND (%s::text = '' OR status = %s)
            ORDER BY started_at DESC, id DESC
            LIMIT %s OFFSET %s
            """,
            (user.id, status, status, limit + 1, offset),
        )
        sessions = [_scan_session(row) for row in await cursor.fetchall()]
    return build_page(sessions, limit, offset)


@dataclass
class PracticeAnswerInput:
    question_id: int
    answer_payload: dict[str, Any]
    duration_ms: int | None = None


async def submit_answer(
    pool: AsyncConnectionPool, user: User, session_id: int, input: PracticeAnswerInput
) -> dict:
    session = await get_practice_session(pool, user, session_id)
    existing = await _get_existing_practice_answer(pool, user.id, session_id, input.question_id)
    if existing is not None:
        return _practice_answer_for_session(existing, session)
    if session['status'] != 'active':
        raise envelope.new_error(409, 'INVALID_STATE', 'Practice session is not active')
    rdb = redisx.client()
    if rdb is not None:
        queued = await redisx.get_json(rdb, _practice_question_queue_key(session_id))
        if queued and input.question_id not in queued:
            raise envelope.new_error(404, 'NOT_FOUND', 'Question is not part of this practice session')

    answer_key = await _load_primary_answer_key(pool, input.question_id)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT answer_mode
            FROM v_bank_question_items
            WHERE question_id = %s
              AND bank_id = %s
              AND question_status = 'active'
              AND bank_link_status = 'active'
            LIMIT 1
            """,
            (input.question_id, session['bank_id']),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Question is not part of this active practice session')
    answer_mode = row[0]
    _validate_submitted_practice_answer(answer_mode, input.answer_payload)

    is_correct = grade_practice_answer(answer_mode, answer_key, input.answer_payload)
    score = max_score = None
    if answer_key is not None:
        max_score = 1.0
        if is_correct is not None:
            score = 1.0 if is_correct else 0.0
    payload_json = json.dumps(input.answer_payload or {}, separators=(',', ':'))
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            INSERT INTO user_question_answers (
                user_id, session_id, bank_id, question_id, answer_key_id,
                answer_payload, is_correct, score, max_score, duration_ms
            )
            VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s)
            ON CONFLICT (user_id, session_id, question_id) DO NOTHING
            RETURNING id, user_id, session_id, bank_id, question_id, answer_key_id,
                      answer_payload, is_correct, score, max_score, duration_ms, answered_at
            """,
            (
                user.id, session_id, session['bank_id'], input.question_id,
                answer_key['id'] if answer_key else None,
                payload_json, is_correct, score, max_score, input.duration_ms,
            ),
        )
        row = await cursor.fetchone()
    if row is None:
        existing = await _get_existing_practice_answer(pool, user.id, session_id, input.question_id)
        if existing is not None:
            return _practice_answer_for_session(existing, session)
        raise envelope.new_error(500, 'INTERNAL_ERROR', 'Unexpected server error')
    answer = _scan_answer(row)
    await helpers.bump_slice_cache_version('analytics', user.id)
    if session['bank_id'] is not None:
        await helpers.bump_slice_cache_version('bank-analytics', session['bank_id'])
        await helpers.bump_slice_cache_version('leaderboard', session['bank_id'])
    return _practice_answer_for_session(answer, session)


async def complete_practice_session(
    pool: AsyncConnectionPool, user: User, session_id: int, status: str
) -> dict:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            f"""
            UPDATE user_practice_sessions
            SET status = %s, completed_at = NOW()
            WHERE id = %s
              AND user_id = %s
              AND status = 'active'
            RETURNING {SESSION_COLUMNS}
            """,
            (status, session_id, user.id),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Active practice session not found')
    await helpers.bump_slice_cache_version('analytics', user.id)
    return _scan_session(row)


async def get_practice_results(pool: AsyncConnectionPool, user: User, session_id: int) -> list[dict]:
    session = await get_practice_session(pool, user, session_id)
    if session['status'] == 'active':
        raise envelope.new_error(
            409, 'INVALID_STATE', 'Complete the practice session before viewing results'
        )
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT
                uqa.id, uqa.user_id, uqa.session_id, uqa.bank_id, uqa.question_id,
                uqa.answer_key_id, uqa.answer_payload, uqa.is_correct, uqa.score,
                uqa.max_score, uqa.duration_ms, uqa.answered_at,
                q.stem, q.answer_mode, q.analysis,
                COALESCE(
                    (
                        SELECT json_agg(qak.* ORDER BY qak.version)
                        FROM question_answer_keys qak
                        WHERE qak.question_id = q.id
                    ),
                    '[]'::json
                ) AS answer_keys
            FROM user_question_answers uqa
            JOIN questions q ON q.id = uqa.question_id
            WHERE uqa.user_id = %s
              AND uqa.session_id = %s
            ORDER BY uqa.answered_at, uqa.id
            """,
            (user.id, session_id),
        )
        results = []
        for row in await cursor.fetchall():
            result = _scan_answer(row[:12])
            result['stem'] = row[12]
            result['answer_mode'] = row[13]
            result['analysis'] = row[14]
            answer_keys = row[15]
            result['answer_keys'] = (
                json.loads(answer_keys) if isinstance(answer_keys, str) else (answer_keys or [])
            )
            results.append(result)
    return results


def _practice_answer_for_session(answer: dict | None, session: dict) -> dict | None:
    if answer is None or session['session_type'] != 'exam' or session['status'] != 'active':
        return answer
    safe = dict(answer)
    safe['answer_key_id'] = None
    safe['is_correct'] = None
    safe['score'] = None
    safe['max_score'] = None
    return safe


def _should_reveal_practice_feedback(session: dict, answer: dict | None) -> bool:
    return answer is not None and (session['session_type'] != 'exam' or session['status'] != 'active')


async def _ensure_practice_question_queue(pool: AsyncConnectionPool, session: dict) -> list[int]:
    if session['bank_id'] is None:
        return []
    key = _practice_question_queue_key(session['id'])
    rdb = redisx.client()
    if rdb is not None:
        cached = await redisx.get_json(rdb, key)
        if cached:
            return cached[: session['question_count']]
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT question_id
            FROM v_bank_question_items
            WHERE bank_id = %s
              AND bank_link_status = 'active'
              AND question_status = 'active'
            ORDER BY bank_sort_order, group_sort_order NULLS FIRST, question_id
            LIMIT %s
            """,
            (session['bank_id'], session['question_count']),
        )
        question_ids = [row[0] for row in await cursor.fetchall()]
    if rdb is not None:
        await redisx.set_json(rdb, key, question_ids, _practice_queue_ttl_seconds())
    return question_ids


async def _load_practice_question_rows(
    pool: AsyncConnectionPool, session: dict, question_ids: list[int], offset: int, limit: int
) -> list[dict]:
    if session['bank_id'] is None or not question_ids:
        return []
    offset = max(offset, 0)
    if limit < 1:
        limit = len(question_ids)
    if offset >= len(question_ids):
        return []
    slice_ids = question_ids[offset : offset + limit]
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            WITH requested_ids AS (
                SELECT id, ord
                FROM unnest(%s::bigint[]) WITH ORDINALITY AS requested(id, ord)
            )
            SELECT
                item.bank_id, item.group_id, item.question_id, item.item_scope,
                item.bank_sort_order, item.group_sort_order, item.question_no,
                item.bank_link_status, item.business_type, item.subject_id,
                item.question_type_id, item.answer_mode, item.choice_variant,
                item.content_mode, item.stem, NULL::text AS analysis,
                item.question_status, item.group_title, item.group_instructions,
                COALESCE(
                    (
                        SELECT jsonb_agg(
                            jsonb_build_object(
                                'id', qo.id,
                                'question_id', qo.question_id,
                                'option_label', qo.option_label,
                                'sort_order', qo.sort_order,
                                'content', qo.content,
                                'created_at', qo.created_at,
                                'updated_at', qo.updated_at
                            )
                            ORDER BY qo.sort_order
                        )
                        FROM question_options qo
                        WHERE qo.question_id = item.question_id
                    ),
                    '[]'::json
                ) AS options
            FROM requested_ids
            JOIN v_bank_question_items item ON item.question_id = requested_ids.id
            WHERE item.bank_id = %s
              AND item.bank_link_status = 'active'
              AND item.question_status = 'active'
            ORDER BY requested_ids.ord
            """,
            (slice_ids, session['bank_id']),
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
    return items


async def _load_practice_question_ids(
    pool: AsyncConnectionPool, user: User, bank_id: int, count: int, mode: str, question_type_id: str
) -> list[int]:
    type_filter = helpers.trimmed_or_none(question_type_id) if mode == PRACTICE_MODE_BY_TYPE else None
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT item.question_id
            FROM v_bank_question_items item
            LEFT JOIN user_question_stats uqs
              ON uqs.question_id = item.question_id
             AND uqs.user_id = %s
            WHERE item.bank_id = %s
              AND item.bank_link_status = 'active'
              AND item.question_status = 'active'
              AND (%s::text IS NULL OR item.question_type_id = %s)
              AND (
                %s <> 'wrong'
                OR COALESCE(uqs.wrong_count, 0) > 0
                OR uqs.last_is_correct IS FALSE
              )
            GROUP BY item.question_id, item.bank_sort_order, item.group_sort_order, uqs.wrong_count, uqs.last_is_correct
            ORDER BY
                CASE WHEN %s = 'wrong' THEN COALESCE(uqs.wrong_count, 0) ELSE 0 END DESC,
                CASE WHEN %s = 'exam' THEN md5(item.question_id::text || %s::text || CURRENT_DATE::text) ELSE NULL END,
                item.bank_sort_order,
                item.group_sort_order NULLS FIRST,
                item.question_id
            LIMIT %s
            """,
            (user.id, bank_id, type_filter, type_filter, mode, mode, mode, user.id, count),
        )
        return [row[0] for row in await cursor.fetchall()]


async def _load_primary_answer_key(pool: AsyncConnectionPool, question_id: int) -> dict | None:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT id, question_id, answer_mode, version, is_primary,
                   answer_payload, explanation_payload, score_payload, created_at, updated_at
            FROM question_answer_keys
            WHERE question_id = %s
              AND is_primary = true
            LIMIT 1
            """,
            (question_id,),
        )
        row = await cursor.fetchone()
    if row is None:
        return None
    return {
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


async def _get_existing_practice_answer(
    pool: AsyncConnectionPool, user_id: int, session_id: int, question_id: int
) -> dict | None:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT id, user_id, session_id, bank_id, question_id, answer_key_id,
                   answer_payload, is_correct, score, max_score, duration_ms, answered_at
            FROM user_question_answers
            WHERE user_id = %s
              AND session_id = %s
              AND question_id = %s
            ORDER BY answered_at ASC, id ASC
            LIMIT 1
            """,
            (user_id, session_id, question_id),
        )
        row = await cursor.fetchone()
    return _scan_answer(row) if row is not None else None


def _validate_submitted_practice_answer(mode: str, payload: dict | None) -> None:
    if mode == 'choice':
        if not selected_answer_values(payload):
            raise envelope.new_error(422, 'VALIDATION_ERROR', 'Select at least one option before submitting')
    elif mode == 'true_false':
        if not isinstance((payload or {}).get('value'), bool):
            raise envelope.new_error(422, 'VALIDATION_ERROR', 'Select true or false before submitting')
    elif mode == 'fill_blank':
        if not _question_fill_blank_values(payload):
            raise envelope.new_error(422, 'VALIDATION_ERROR', 'Fill at least one blank before submitting')
    elif mode == 'short_answer':
        if _normalize_question_text((payload or {}).get('value')) == '':
            raise envelope.new_error(422, 'VALIDATION_ERROR', 'Answer text is required before submitting')


def grade_practice_answer(mode: str, answer_key: dict | None, payload: dict | None) -> bool | None:
    if answer_key is None:
        return None
    raw = answer_key['answer_payload']
    try:
        expected = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return None
    if not isinstance(expected, dict):
        return None
    if mode == 'choice':
        expected_values = sorted(selected_answer_values(expected))
        actual_values = sorted(selected_answer_values(payload))
        return expected_values == actual_values
    if mode == 'true_false':
        expected_value = _question_object_value(expected, 'value')
        actual_value = (payload or {}).get('value')
        if not isinstance(expected_value, bool) or not isinstance(actual_value, bool):
            return None
        return expected_value == actual_value
    if mode == 'fill_blank':
        expected_values = _question_fill_blank_values(expected)
        actual_values = _question_fill_blank_values(payload)
        matched = len(expected_values) > 0 and len(actual_values) >= len(expected_values)
        if matched:
            for index, expected_value in enumerate(expected_values):
                if expected_value != actual_values[index]:
                    matched = False
                    break
        return matched
    return None
