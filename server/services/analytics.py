
import os
from typing import Any, Awaitable, Callable

from psycopg_pool import AsyncConnectionPool

from .. import envelope, redisx
from ..auth.runtime import User
from . import helpers
from .banks import get_bank


def _env_int(key: str, fallback: int) -> int:
    raw = os.environ.get(key, '').strip()
    try:
        return int(raw)
    except ValueError:
        return fallback


def _analytics_cache_ttl() -> int:
    return _env_int('ANALYTICS_CACHE_TTL_SECONDS', 30)


def _leaderboard_cache_ttl() -> int:
    return _env_int('LEADERBOARD_CACHE_TTL_SECONDS', 60)


async def _cache_version(scope: str, id_value: Any) -> str:
    rdb = redisx.client()
    if rdb is None:
        return '0'
    value = await redisx.get_text(rdb, redisx.redis_key('cache-version', scope, id_value))
    return value.strip() if value and value.strip() else '0'


async def _load_cached_json(key: str, ttl: int, loader: Callable[[], Awaitable[Any]]) -> Any:
    rdb = redisx.client()
    if rdb is not None:
        cached = await redisx.get_json(rdb, key)
        if cached is not None:
            return cached
    value = await loader()
    if rdb is not None:
        await redisx.set_json(rdb, key, value, ttl)
    return value


async def get_analytics_summary(pool: AsyncConnectionPool, user: User) -> dict:
    version = await _cache_version('analytics', user.id)

    async def load() -> dict:
        async with pool.connection() as conn:
            cursor = await conn.execute(
                """
                SELECT
                    (SELECT COUNT(*)::int FROM user_bank_links WHERE user_id = %s AND is_owner = true) AS owned_banks,
                    (SELECT COUNT(*)::int FROM user_bank_links WHERE user_id = %s AND is_favorite = true) AS favorite_banks,
                    COALESCE((SELECT SUM(attempt_count)::int FROM user_question_stats WHERE user_id = %s), 0) AS attempts,
                    COALESCE((SELECT SUM(correct_count)::int FROM user_question_stats WHERE user_id = %s), 0) AS correct,
                    COALESCE((SELECT SUM(wrong_count)::int FROM user_question_stats WHERE user_id = %s), 0) AS wrong,
                    (SELECT COUNT(*)::int FROM user_practice_sessions WHERE user_id = %s) AS sessions,
                    (SELECT COUNT(*)::int FROM user_practice_sessions WHERE user_id = %s AND status = 'active') AS active_sessions,
                    (SELECT COUNT(*)::int FROM question_import_jobs WHERE created_by = %s AND status IN ('queued', 'processing')) AS active_imports
                """,
                (user.id,) * 8,
            )
            row = await cursor.fetchone()
        summary = {
            'owned_banks': row[0],
            'favorite_banks': row[1],
            'attempts': row[2],
            'correct': row[3],
            'wrong': row[4],
            'sessions': row[5],
            'active_sessions': row[6],
            'active_imports': row[7],
            'accuracy': round(row[3] / row[2] * 100) if row[2] > 0 else 0,
        }
        return summary

    return await _load_cached_json(
        redisx.redis_key('cache', 'analytics', 'user', user.id, version, 'summary'),
        _analytics_cache_ttl(),
        load,
    )


async def get_bank_analytics(pool: AsyncConnectionPool, user: User, bank_id: int) -> dict:
    await get_bank(pool, user, bank_id)
    version = await _cache_version('bank-analytics', bank_id)

    async def load() -> dict:
        async with pool.connection() as conn:
            cursor = await conn.execute(
                """
                SELECT
                    COALESCE(SUM(completed_count), 0)::int AS completed_count,
                    COALESCE(SUM(wrong_count), 0)::int AS wrong_count,
                    COUNT(*)::int AS practiced_users,
                    (
                        SELECT COUNT(*)::int
                        FROM user_question_answers
                        WHERE bank_id = %s
                    ) AS answer_count
                FROM user_bank_stats
                WHERE bank_id = %s
                """,
                (bank_id, bank_id),
            )
            row = await cursor.fetchone()
        return {
            'completed_count': row[0],
            'wrong_count': row[1],
            'practiced_users': row[2],
            'answer_count': row[3],
        }

    return await _load_cached_json(
        redisx.redis_key('cache', 'bank-analytics', 'bank', bank_id, version),
        _analytics_cache_ttl(),
        load,
    )


async def get_bank_leaderboard(pool: AsyncConnectionPool, user: User, bank_id: int, limit: int) -> list[dict]:
    await get_bank(pool, user, bank_id)
    safe_limit = min(max(limit, 1), 100)
    version = await _cache_version('leaderboard', bank_id)

    async def load() -> list[dict]:
        async with pool.connection() as conn:
            cursor = await conn.execute(
                """
                SELECT
                    u.id AS user_id,
                    u.username,
                    ubs.completed_count,
                    ubs.wrong_count,
                    ubs.last_practiced_at,
                    CASE
                        WHEN ubs.completed_count > 0
                        THEN ROUND(((ubs.completed_count - ubs.wrong_count)::numeric / ubs.completed_count) * 100, 2)
                        ELSE 0
                    END AS accuracy_percent
                FROM user_bank_stats ubs
                JOIN users u ON u.id = ubs.user_id
                WHERE ubs.bank_id = %s
                ORDER BY ubs.completed_count DESC, accuracy_percent DESC, ubs.last_practiced_at DESC NULLS LAST
                LIMIT %s
                """,
                (bank_id, safe_limit),
            )
            return [
                {
                    'user_id': row[0],
                    'username': row[1],
                    'completed_count': row[2],
                    'wrong_count': row[3],
                    'last_practiced_at': helpers.format_nullable_timestamp(row[4]),
                    'accuracy_percent': float(row[5]),
                }
                for row in await cursor.fetchall()
            ]

    return await _load_cached_json(
        redisx.redis_key('cache', 'leaderboard', 'bank', bank_id, version, 'limit', safe_limit),
        _leaderboard_cache_ttl(),
        load,
    )


async def get_user_stats_snapshot(pool: AsyncConnectionPool, user: User) -> dict:
    version = await _cache_version('analytics', user.id)

    async def load() -> dict:
        summary = await get_analytics_summary(pool, user)
        async with pool.connection() as conn:
            cursor = await conn.execute(
                """
                SELECT id, user_id, bank_id, session_type, status, question_count,
                       answered_count, correct_count, wrong_count, score, started_at, completed_at
                FROM user_practice_sessions
                WHERE user_id = %s
                ORDER BY started_at DESC, id DESC
                LIMIT 10
                """,
                (user.id,),
            )
            from .practice import _scan_session  # reuse scanner

            recent_sessions = [_scan_session(row) for row in await cursor.fetchall()]

            cursor = await conn.execute(
                """
                SELECT
                    uqs.question_id,
                    uqs.attempt_count,
                    uqs.correct_count,
                    uqs.wrong_count,
                    uqs.mastery_score,
                    q.stem,
                    q.question_type_id
                FROM user_question_stats uqs
                JOIN questions q ON q.id = uqs.question_id
                WHERE uqs.user_id = %s
                  AND uqs.attempt_count > 0
                ORDER BY uqs.mastery_score ASC NULLS FIRST, uqs.wrong_count DESC, uqs.last_answered_at DESC NULLS LAST
                LIMIT 10
                """,
                (user.id,),
            )
            weak_questions = [
                {
                    'question_id': row[0],
                    'attempt_count': row[1],
                    'correct_count': row[2],
                    'wrong_count': row[3],
                    'mastery_score': row[4],
                    'stem': row[5],
                    'question_type_id': row[6],
                }
                for row in await cursor.fetchall()
            ]
        return {
            'summary': summary,
            'recentSessions': recent_sessions,
            'weakQuestions': weak_questions,
        }

    return await _load_cached_json(
        redisx.redis_key('cache', 'analytics', 'user', user.id, version, 'snapshot'),
        _analytics_cache_ttl(),
        load,
    )


async def get_import_analytics(pool: AsyncConnectionPool, user: User, job_id: int) -> dict:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT
                qij.id, qij.created_by, qij.bank_id, qij.status, qij.stage,
                qij.available_at, qij.persist_questions, qij.request_payload,
                qij.raw_result_json, qij.warning_messages, qij.total_questions,
                qij.imported_questions, qij.file_name, qij.source_type,
                qij.retry_count, qij.quality_score, qij.last_error_code, qij.last_error,
                qij.overall_progress_percent, qij.step_progress_percent,
                qij.last_event_id, qij.last_event_at,
                qij.created_at, qij.updated_at, qij.completed_at,
                (SELECT COUNT(*)::int FROM question_import_job_events WHERE job_id = qij.id) AS events,
                (SELECT COUNT(*)::int FROM question_import_job_outputs WHERE job_id = qij.id) AS outputs
            FROM question_import_jobs qij
            WHERE qij.id = %s AND qij.created_by = %s
            LIMIT 1
            """,
            (job_id, user.id),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Import job not found')
    return {
        'id': row[0],
        'created_by': row[1],
        'bank_id': row[2],
        'status': row[3],
        'stage': row[4],
        'available_at': helpers.format_nullable_timestamp(row[5]),
        'persist_questions': row[6],
        'request_payload': row[7],
        'raw_result_json': row[8],
        'warning_messages': row[9],
        'total_questions': row[10],
        'imported_questions': row[11],
        'file_name': row[12],
        'source_type': row[13],
        'retry_count': row[14],
        'quality_score': row[15],
        'last_error_code': row[16],
        'last_error': row[17],
        'overall_progress_percent': row[18],
        'step_progress_percent': row[19],
        'last_event_id': row[20],
        'last_event_at': helpers.format_nullable_timestamp(row[21]),
        'created_at': helpers.format_timestamp(row[22]),
        'updated_at': helpers.format_timestamp(row[23]),
        'completed_at': helpers.format_nullable_timestamp(row[24]),
        'events': row[25],
        'outputs': row[26],
    }
