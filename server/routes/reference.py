"""Reference data routes. Mirrors reference_handlers.go."""

from __future__ import annotations

from fastapi import APIRouter, Request

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
async def question_types(request: Request):
    async with deps.pool(request).connection() as conn:
        data = await reference_svc.list_question_types(
            conn,
            request.query_params.get('subject', ''),
            request.query_params.get('scope', ''),
        )
    response = envelope.ok(request, data)
    response.headers['Cache-Control'] = PUBLIC_CACHE_CONTROL
    return response


@router.get('/api/v1/knowledge-points')
async def knowledge_points(request: Request):
    limit = deps.query_page_limit(request, 200)
    parent_id = None
    raw_parent = request.query_params.get('parentId', '')
    if raw_parent:
        try:
            parent_id = int(raw_parent)
        except ValueError as exc:
            raise envelope.new_error(422, 'VALIDATION_ERROR', 'Invalid parentId') from exc
        if parent_id <= 0:
            raise envelope.new_error(422, 'VALIDATION_ERROR', 'Invalid parentId')
    async with deps.pool(request).connection() as conn:
        data = await reference_svc.list_knowledge_points(
            conn,
            request.query_params.get('subject', ''),
            parent_id,
            request.query_params.get('q', ''),
            request.query_params.get('cursor', ''),
            limit,
        )
    response = envelope.ok(request, data.items, data.page_info.as_meta())
    response.headers['Cache-Control'] = PUBLIC_CACHE_CONTROL
    return response
