"""Practice, analytics, and search routes.

Mirrors practice.go / analytics.go / search.go handlers.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from .. import envelope, redisx
from ..middleware import IDEMPOTENCY_TTL_SECONDS
from ..services import analytics as analytics_svc
from ..services import practice as practice_svc
from ..services import search as search_svc
from . import deps

router = APIRouter()


# --------------------------------------------------------------- practice


@router.get('/api/v1/practice-sessions')
async def list_sessions(request: Request):
    user = await deps.current_user(request)
    limit = deps.query_page_limit(request, 100)
    data = await practice_svc.list_practice_sessions(
        deps.pool(request), user, limit,
        request.query_params.get('status', ''), request.query_params.get('cursor', ''),
        deps.query_updated_since(request),
    )
    return envelope.ok(request, data.items, data.page_info.as_meta())


def _parse_optional_enum(body: dict, key: str, allowed: tuple[str, ...], details: list) -> str:
    value = body.get(key)
    if value is None:
        return ''
    if not isinstance(value, str):
        details.append(envelope.ValidationDetail(key, 'has an invalid value'))
        return ''
    trimmed = value.strip()
    if trimmed in allowed:
        return trimmed
    details.append(envelope.ValidationDetail(key, 'has an invalid value'))
    return ''


@router.post('/api/v1/practice-sessions')
async def start_session(request: Request):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(
        request, {'bankId', 'sessionType', 'questionCount', 'mode', 'questionTypeId', 'allQuestions'}
    )
    details: list[envelope.ValidationDetail] = []
    bank_id = body.get('bankId')
    if bank_id is None:
        details.append(envelope.ValidationDetail('bankId', 'is required'))
        bank_id = 0
    elif not isinstance(bank_id, int) or bank_id <= 0:
        details.append(envelope.ValidationDetail('bankId', 'must be a positive integer'))
        bank_id = 0
    session_type = _parse_optional_enum(body, 'sessionType', ('practice', 'review', 'exam'), details)
    question_count = 0
    if body.get('questionCount') is not None:
        raw_count = body['questionCount']
        if not isinstance(raw_count, int) or raw_count <= 0 or raw_count > 500:
            details.append(
                envelope.ValidationDetail('questionCount', 'must be a positive integer no greater than 500')
            )
        else:
            question_count = raw_count
    mode = _parse_optional_enum(body, 'mode', ('all', 'wrong', 'by_type', 'exam'), details)
    question_type_id = None
    if body.get('questionTypeId') is not None:
        if not isinstance(body['questionTypeId'], str):
            details.append(envelope.ValidationDetail('questionTypeId', 'must be a non-empty string'))
        else:
            question_type_id = body['questionTypeId'].strip()
            if not question_type_id or len(question_type_id) > 64:
                details.append(envelope.ValidationDetail('questionTypeId', 'must be a non-empty string'))
                question_type_id = None
    if details:
        raise envelope.validation_error(details)
    data = await practice_svc.start_practice_session(
        deps.pool(request), user,
        practice_svc.PracticeSessionInput(
            bank_id=bank_id,
            session_type=session_type,
            question_count=question_count,
            mode=mode,
            question_type_id=question_type_id,
            all_questions=bool(body.get('allQuestions')),
        ),
    )
    return envelope.created(request, data)


@router.get('/api/v1/practice-sessions/{session_id}')
async def get_session(request: Request, session_id: str):
    user = await deps.current_user(request)
    data = await practice_svc.get_practice_session(
        deps.pool(request), user, deps.parse_path_id(session_id, 'sessionId')
    )
    return envelope.ok(request, data)


@router.get('/api/v1/practice-sessions/{session_id}/question-page')
async def question_page(request: Request, session_id: str):
    user = await deps.current_user(request)
    index = None
    raw = request.query_params.get('index', '').strip()
    if raw:
        try:
            index = int(raw)
        except ValueError:
            index = None
    data = await practice_svc.get_practice_question_page(
        deps.pool(request), user, deps.parse_path_id(session_id, 'sessionId'), index
    )
    return envelope.ok(request, data)


@router.get('/api/v1/practice-sessions/{session_id}/questions')
async def session_questions(request: Request, session_id: str):
    user = await deps.current_user(request)
    data = await practice_svc.get_practice_questions(
        deps.pool(request), user, deps.parse_path_id(session_id, 'sessionId')
    )
    return envelope.ok(request, data)


@router.get('/api/v1/practice-sessions/{session_id}/results')
async def session_results(request: Request, session_id: str):
    user = await deps.current_user(request)
    data = await practice_svc.get_practice_results(
        deps.pool(request), user, deps.parse_path_id(session_id, 'sessionId')
    )
    return envelope.ok(request, data)


@router.post('/api/v1/practice-sessions/{session_id}/answers')
async def submit_answer(request: Request, session_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'questionId', 'answerPayload', 'durationMs'})
    details: list[envelope.ValidationDetail] = []
    question_id = body.get('questionId')
    if question_id is None:
        details.append(envelope.ValidationDetail('questionId', 'is required'))
    elif not isinstance(question_id, int) or question_id <= 0:
        details.append(envelope.ValidationDetail('questionId', 'must be a positive integer'))
    answer_payload = body.get('answerPayload')
    if answer_payload is None:
        details.append(envelope.ValidationDetail('answerPayload', 'is required'))
    duration_ms = body.get('durationMs')
    if duration_ms is not None and (not isinstance(duration_ms, int) or duration_ms < 0):
        details.append(envelope.ValidationDetail('durationMs', 'must be a non-negative integer'))
    if details:
        raise envelope.validation_error(details)
    data = await practice_svc.submit_answer(
        deps.pool(request), user, deps.parse_path_id(session_id, 'sessionId'),
        practice_svc.PracticeAnswerInput(
            question_id=question_id,
            answer_payload=answer_payload if isinstance(answer_payload, dict) else {},
            duration_ms=duration_ms,
        ),
    )
    return envelope.created(request, data)


@router.post('/api/v1/practice-sessions/{session_id}/complete')
async def complete_session(request: Request, session_id: str):
    user = await deps.current_user(request)
    data = await practice_svc.complete_practice_session(
        deps.pool(request), user, deps.parse_path_id(session_id, 'sessionId'), 'completed'
    )
    return envelope.ok(request, data)


@router.post('/api/v1/practice-sessions/{session_id}/abandon')
async def abandon_session(request: Request, session_id: str):
    user = await deps.current_user(request)
    data = await practice_svc.complete_practice_session(
        deps.pool(request), user, deps.parse_path_id(session_id, 'sessionId'), 'abandoned'
    )
    return envelope.ok(request, data)


@router.post('/api/v1/offline-practice')
async def offline_practice(request: Request):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'bankId', 'answers'})
    bank_id = body.get('bankId') if isinstance(body.get('bankId'), int) else 0
    answers = body.get('answers')
    if bank_id < 1 or not isinstance(answers, list) or not 1 <= len(answers) <= 500:
        raise envelope.validation_error(
            [envelope.ValidationDetail('answers', 'bankId and 1-500 answers are required')]
        )
    question_ids: set[int] = set()
    for index, answer in enumerate(answers):
        if not isinstance(answer, dict):
            raise envelope.invalid_json()
        question_id = answer.get('questionId') if isinstance(answer.get('questionId'), int) else 0
        if question_id < 1:
            raise envelope.validation_error(
                [envelope.ValidationDetail(f'answers.{index}.questionId', 'must be positive')]
            )
        if question_id in question_ids:
            raise envelope.validation_error(
                [envelope.ValidationDetail(f'answers.{index}.questionId', 'must be unique')]
            )
        question_ids.add(question_id)
    idempotency_key = request.headers.get('idempotency-key', '').strip()
    if not idempotency_key:
        raise envelope.validation_error(
            [envelope.ValidationDetail('Idempotency-Key', 'is required')]
        )
    rdb = redisx.client()
    if rdb is None:
        raise envelope.new_error(
            503, 'IDEMPOTENCY_UNAVAILABLE', 'Offline practice upload is temporarily unavailable'
        )
    session_key = redisx.redis_key('offline-practice', user.id, idempotency_key)
    pool = deps.pool(request)
    session_id = 0
    try:
        raw = await rdb.get(session_key)
        session_id = int(raw) if raw else 0
    except Exception:
        session_id = 0
    if session_id > 0:
        session = await practice_svc.get_practice_session(pool, user, session_id)
    else:
        session = await practice_svc.start_practice_session(
            pool, user,
            practice_svc.PracticeSessionInput(
                bank_id=bank_id, session_type='practice',
                question_count=len(answers), mode='all',
            ),
        )
        session_id = session['id']
        try:
            await rdb.set(session_key, session_id, ex=IDEMPOTENCY_TTL_SECONDS)
        except Exception:
            pass
    for answer in answers:
        await practice_svc.submit_answer(
            pool, user, session_id,
            practice_svc.PracticeAnswerInput(
                question_id=answer['questionId'],
                answer_payload=answer.get('answerPayload') if isinstance(answer.get('answerPayload'), dict) else {},
            ),
        )
    session = await practice_svc.get_practice_session(pool, user, session_id)
    if session['status'] == 'active':
        session = await practice_svc.complete_practice_session(pool, user, session_id, 'completed')
    return envelope.ok(request, session)


# -------------------------------------------------------------- analytics


@router.get('/api/v1/analytics/me/summary')
async def analytics_summary(request: Request):
    user = await deps.current_user(request)
    return envelope.ok(request, await analytics_svc.get_analytics_summary(deps.pool(request), user))


@router.get('/api/v1/analytics/me/snapshot')
async def analytics_snapshot(request: Request):
    user = await deps.current_user(request)
    return envelope.ok(request, await analytics_svc.get_user_stats_snapshot(deps.pool(request), user))


@router.get('/api/v1/analytics/banks/{bank_id}')
async def analytics_bank(request: Request, bank_id: str):
    user = await deps.current_user(request)
    data = await analytics_svc.get_bank_analytics(
        deps.pool(request), user, deps.parse_path_id(bank_id, 'bankId')
    )
    return envelope.ok(request, data)


@router.get('/api/v1/analytics/banks/{bank_id}/leaderboard')
async def analytics_leaderboard(request: Request, bank_id: str):
    user = await deps.current_user(request)
    limit = 20
    raw = request.query_params.get('limit', '').strip()
    if raw:
        try:
            limit = int(raw)
        except ValueError:
            limit = 20
    data = await analytics_svc.get_bank_leaderboard(
        deps.pool(request), user, deps.parse_path_id(bank_id, 'bankId'), limit
    )
    return envelope.ok(request, data)


@router.get('/api/v1/analytics/imports/{job_id}')
async def analytics_import(request: Request, job_id: str):
    user = await deps.current_user(request)
    data = await analytics_svc.get_import_analytics(
        deps.pool(request), user, deps.parse_path_id(job_id, 'jobId')
    )
    return envelope.ok(request, data)


# ----------------------------------------------------------------- search


@router.get('/api/v1/search/{kind}')
async def search_kind(request: Request, kind: str):
    user = await deps.current_user(request)
    if kind != 'questions':
        raise envelope.new_error(422, 'VALIDATION_ERROR', 'Search kind must be questions')
    async with deps.pool(request).connection() as conn:
        data = await search_svc.search_questions(
            conn, user,
            bank_id_raw=request.query_params.get('bankId', ''),
            type_raw=request.query_params.get('type', ''),
            status_raw=request.query_params.get('status', ''),
            limit_raw=request.query_params.get('limit', ''),
            cursor_str=request.query_params.get('cursor', ''),
            query=request.query_params.get('q', ''),
        )
    return envelope.ok(request, data.items, data.page_info.as_meta())
