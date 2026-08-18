"""Practice, analytics, and search routes."""

from typing import Annotated, Any, Literal, Self

from fastapi import APIRouter, Header, Query, Request
from pydantic import Field, StringConstraints, model_validator

from .. import envelope, redisx
from ..middleware import IDEMPOTENCY_TTL_SECONDS
from ..services import analytics as analytics_svc
from ..services import practice as practice_svc
from ..services import search as search_svc
from . import deps

router = APIRouter()

PositiveInt = Annotated[int, Field(gt=0)]
QuestionType = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)
]


class StartSessionBody(deps.RequestBody):
    bank_id: PositiveInt
    session_type: Literal['', 'practice', 'review', 'exam'] = ''
    question_count: Annotated[int, Field(gt=0, le=500)] | None = None
    mode: Literal['', 'all', 'wrong', 'by_type', 'exam'] = ''
    question_type_id: QuestionType | None = None
    all_questions: bool = False


class SubmitAnswerBody(deps.RequestBody):
    question_id: PositiveInt
    answer_payload: Any
    duration_ms: Annotated[int, Field(ge=0)] | None = None


class OfflineAnswerBody(deps.RequestBody):
    question_id: PositiveInt
    answer_payload: dict[str, Any] = Field(default_factory=dict)


class OfflinePracticeBody(deps.RequestBody):
    bank_id: PositiveInt
    answers: list[OfflineAnswerBody] = Field(min_length=1, max_length=500)

    @model_validator(mode='after')
    def unique_questions(self) -> Self:
        question_ids = [answer.question_id for answer in self.answers]
        if len(question_ids) != len(set(question_ids)):
            raise ValueError('questionId values must be unique')
        return self


@router.get('/api/v1/practice-sessions')
async def list_sessions(
    request: Request,
    status: str = '',
    cursor: str = '',
    limit: deps.PageLimit100 = None,
    updated_since: deps.UpdatedSince = None,
):
    user = await deps.current_user(request)
    data = await practice_svc.list_practice_sessions(
        deps.pool(request),
        user,
        limit or 0,
        status,
        cursor,
        updated_since.isoformat() if updated_since else '',
    )
    return envelope.ok(request, data.items, data.page_info.as_meta())


@router.post('/api/v1/practice-sessions')
async def start_session(request: Request, body: StartSessionBody):
    user = await deps.current_user(request)
    data = await practice_svc.start_practice_session(
        deps.pool(request),
        user,
        practice_svc.PracticeSessionInput(
            bank_id=body.bank_id,
            session_type=body.session_type,
            question_count=body.question_count or 0,
            mode=body.mode,
            question_type_id=body.question_type_id,
            all_questions=body.all_questions,
        ),
    )
    return envelope.created(request, data)


@router.get('/api/v1/practice-sessions/{session_id}')
async def get_session(request: Request, session_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request,
        await practice_svc.get_practice_session(
            deps.pool(request), user, session_id
        ),
    )


@router.get('/api/v1/practice-sessions/{session_id}/question-page')
async def question_page(
    request: Request,
    session_id: deps.PositiveId,
    index: Annotated[int | None, Query(ge=0)] = None,
):
    user = await deps.current_user(request)
    data = await practice_svc.get_practice_question_page(
        deps.pool(request), user, session_id, index
    )
    return envelope.ok(request, data)


@router.get('/api/v1/practice-sessions/{session_id}/questions')
async def session_questions(request: Request, session_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request,
        await practice_svc.get_practice_questions(
            deps.pool(request), user, session_id
        ),
    )


@router.get('/api/v1/practice-sessions/{session_id}/results')
async def session_results(request: Request, session_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request,
        await practice_svc.get_practice_results(
            deps.pool(request), user, session_id
        ),
    )


@router.post(
    '/api/v1/practice-sessions/{session_id}/answers',
)
async def submit_answer(
    request: Request, session_id: deps.PositiveId, body: SubmitAnswerBody
):
    user = await deps.current_user(request)
    data = await practice_svc.submit_answer(
        deps.pool(request),
        user,
        session_id,
        practice_svc.PracticeAnswerInput(
            question_id=body.question_id,
            answer_payload=body.answer_payload
            if isinstance(body.answer_payload, dict)
            else {},
            duration_ms=body.duration_ms,
        ),
    )
    return envelope.created(request, data)


@router.post('/api/v1/practice-sessions/{session_id}/complete')
async def complete_session(request: Request, session_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request,
        await practice_svc.complete_practice_session(
            deps.pool(request), user, session_id, 'completed'
        ),
    )


@router.post('/api/v1/practice-sessions/{session_id}/abandon')
async def abandon_session(request: Request, session_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request,
        await practice_svc.complete_practice_session(
            deps.pool(request), user, session_id, 'abandoned'
        ),
    )


@router.post('/api/v1/offline-practice')
async def offline_practice(
    request: Request,
    body: OfflinePracticeBody,
    idempotency_key: Annotated[str, Header(alias='Idempotency-Key', min_length=1)],
):
    user = await deps.current_user(request)
    rdb = redisx.client()
    if rdb is None:
        raise envelope.new_error(
            503,
            'IDEMPOTENCY_UNAVAILABLE',
            'Offline practice upload is temporarily unavailable',
        )
    session_key = redisx.redis_key(
        'offline-practice', user.id, idempotency_key.strip()
    )
    pool = deps.pool(request)
    try:
        raw = await rdb.get(session_key)
        session_id = int(raw) if raw else 0
    except Exception:
        session_id = 0
    if session_id > 0:
        session = await practice_svc.get_practice_session(pool, user, session_id)
    else:
        session = await practice_svc.start_practice_session(
            pool,
            user,
            practice_svc.PracticeSessionInput(
                bank_id=body.bank_id,
                session_type='practice',
                question_count=len(body.answers),
                mode='all',
            ),
        )
        session_id = session['id']
        try:
            await rdb.set(
                session_key, session_id, ex=IDEMPOTENCY_TTL_SECONDS
            )
        except Exception:
            pass
    for answer in body.answers:
        await practice_svc.submit_answer(
            pool,
            user,
            session_id,
            practice_svc.PracticeAnswerInput(
                question_id=answer.question_id,
                answer_payload=answer.answer_payload,
            ),
        )
    session = await practice_svc.get_practice_session(pool, user, session_id)
    if session['status'] == 'active':
        session = await practice_svc.complete_practice_session(
            pool, user, session_id, 'completed'
        )
    return envelope.ok(request, session)


@router.get('/api/v1/analytics/me/summary')
async def analytics_summary(request: Request):
    user = await deps.current_user(request)
    return envelope.ok(
        request, await analytics_svc.get_analytics_summary(deps.pool(request), user)
    )


@router.get('/api/v1/analytics/me/snapshot')
async def analytics_snapshot(request: Request):
    user = await deps.current_user(request)
    return envelope.ok(
        request, await analytics_svc.get_user_stats_snapshot(deps.pool(request), user)
    )


@router.get('/api/v1/analytics/banks/{bank_id}')
async def analytics_bank(request: Request, bank_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request,
        await analytics_svc.get_bank_analytics(
            deps.pool(request), user, bank_id
        ),
    )


@router.get('/api/v1/analytics/banks/{bank_id}/leaderboard')
async def analytics_leaderboard(
    request: Request,
    bank_id: deps.PositiveId,
    limit: Annotated[int, Query(gt=0, le=100)] = 20,
):
    user = await deps.current_user(request)
    return envelope.ok(
        request,
        await analytics_svc.get_bank_leaderboard(
            deps.pool(request), user, bank_id, limit
        ),
    )


@router.get('/api/v1/analytics/imports/{job_id}')
async def analytics_import(request: Request, job_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request,
        await analytics_svc.get_import_analytics(
            deps.pool(request), user, job_id
        ),
    )


@router.get('/api/v1/search/{kind}')
async def search_kind(
    request: Request,
    kind: Literal['questions'],
    bank_id: Annotated[int | None, Query(alias='bankId', gt=0)] = None,
    type: str = '',
    status: str = '',
    limit: deps.PageLimit100 = None,
    cursor: str = '',
    q: str = '',
):
    user = await deps.current_user(request)
    async with deps.pool(request).connection() as conn:
        data = await search_svc.search_questions(
            conn,
            user,
            bank_id_raw=str(bank_id or ''),
            type_raw=type,
            status_raw=status,
            limit_raw=str(limit or ''),
            cursor_str=cursor,
            query=q,
        )
    return envelope.ok(request, data.items, data.page_info.as_meta())
