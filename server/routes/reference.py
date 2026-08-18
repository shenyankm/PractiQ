"""Reference-data routes."""

from typing import Annotated

from fastapi import APIRouter, Query, Request

from .. import envelope
from ..services import reference as reference_svc
from . import deps

router = APIRouter()

PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=60'


@router.get('/api/v1/subjects')
async def subjects(request: Request):
    async with deps.pool(request).connection() as conn:
        data = await reference_svc.list_subjects(conn)
    response = envelope.ok(request, data)
    response.headers['Cache-Control'] = PUBLIC_CACHE_CONTROL
    return response


@router.get('/api/v1/question-types')
async def question_types(request: Request, subject: str = '', scope: str = ''):
    async with deps.pool(request).connection() as conn:
        data = await reference_svc.list_question_types(conn, subject, scope)
    response = envelope.ok(request, data)
    response.headers['Cache-Control'] = PUBLIC_CACHE_CONTROL
    return response


@router.get('/api/v1/knowledge-points')
async def knowledge_points(
    request: Request,
    subject: str = '',
    parent_id: Annotated[int | None, Query(alias='parentId', gt=0)] = None,
    q: str = '',
    cursor: str = '',
    limit: deps.PageLimit200 = None,
):
    async with deps.pool(request).connection() as conn:
        data = await reference_svc.list_knowledge_points(
            conn, subject, parent_id, q, cursor, limit or 0
        )
    response = envelope.ok(request, data.items, data.page_info.as_meta())
    response.headers['Cache-Control'] = PUBLIC_CACHE_CONTROL
    return response
