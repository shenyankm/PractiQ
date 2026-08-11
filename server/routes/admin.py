"""Admin routes. Mirrors admin_routes.go."""

from __future__ import annotations

from fastapi import APIRouter, Request

from .. import envelope
from ..services import admin as admin_svc
from . import deps

router = APIRouter()


@router.get('/api/v1/admin/overview')
async def overview(request: Request):
    user = await deps.current_user(request)
    return envelope.ok(request, await admin_svc.get_admin_overview(deps.pool(request), user))


@router.get('/api/v1/admin/users')
async def list_users(request: Request):
    user = await deps.current_user(request)
    data = await admin_svc.list_admin_users(
        deps.pool(request), user,
        limit_raw=request.query_params.get('limit', ''),
        cursor_str=request.query_params.get('cursor', ''),
        q=request.query_params.get('q', ''),
        status=request.query_params.get('status', ''),
        role=request.query_params.get('role', ''),
    )
    return envelope.ok(request, data.items, data.page_info.as_meta())


@router.get('/api/v1/admin/knowledge-points')
async def list_knowledge_points(request: Request):
    user = await deps.current_user(request)
    data = await admin_svc.list_admin_knowledge_points(
        deps.pool(request), user,
        limit_raw=request.query_params.get('limit', ''),
        cursor_str=request.query_params.get('cursor', ''),
        subject=request.query_params.get('subject', ''),
        q=request.query_params.get('q', ''),
    )
    return envelope.ok(request, data.items, data.page_info.as_meta())


@router.post('/api/v1/knowledge-points')
async def create_knowledge_point(request: Request):
    body = await deps.decode_json_body(
        request, {'subjectId', 'code', 'displayName', 'parentId', 'metadata'}
    )
    details: list[envelope.ValidationDetail] = []
    subject_id = body.get('subjectId') if isinstance(body.get('subjectId'), str) else ''
    subject_id = subject_id.strip()
    if not subject_id or len(subject_id) > 32:
        details.append(envelope.ValidationDetail('subjectId', 'must be 1-32 characters'))
    code = body.get('code') if isinstance(body.get('code'), str) else ''
    code = code.strip()
    if not code or len(code) > 128:
        details.append(envelope.ValidationDetail('code', 'must be 1-128 characters'))
    display_name = body.get('displayName') if isinstance(body.get('displayName'), str) else ''
    display_name = display_name.strip()
    if not display_name or len(display_name) > 256:
        details.append(envelope.ValidationDetail('displayName', 'must be 1-256 characters'))
    parent_id = body.get('parentId')
    if parent_id is not None and (not isinstance(parent_id, int) or parent_id <= 0):
        details.append(envelope.ValidationDetail('parentId', 'must be a positive integer'))
    if details:
        raise envelope.validation_error(details)
    user = await deps.current_user(request)
    data = await admin_svc.create_knowledge_point(
        deps.pool(request), user, subject_id, code, display_name, parent_id,
        body.get('metadata') if isinstance(body.get('metadata'), dict) else None,
    )
    return envelope.created(request, data)


@router.patch('/api/v1/knowledge-points/{knowledge_point_id}')
async def update_knowledge_point(request: Request, knowledge_point_id: str):
    parsed_id = deps.parse_path_id(knowledge_point_id, 'knowledgePointId')
    body = await deps.decode_json_body(request, {'code', 'displayName', 'parentId', 'metadata'})
    details: list[envelope.ValidationDetail] = []
    code = body.get('code') if isinstance(body.get('code'), str) else None
    if code is not None:
        code = code.strip()
        if not code or len(code) > 128:
            details.append(envelope.ValidationDetail('code', 'must be 1-128 characters'))
    display_name = body.get('displayName') if isinstance(body.get('displayName'), str) else None
    if display_name is not None:
        display_name = display_name.strip()
        if not display_name or len(display_name) > 256:
            details.append(envelope.ValidationDetail('displayName', 'must be 1-256 characters'))
    parent_id_set = 'parentId' in body
    parent_id = body.get('parentId') if isinstance(body.get('parentId'), int) else None
    if parent_id_set and body.get('parentId') is not None and (not isinstance(body.get('parentId'), int) or body['parentId'] <= 0):
        details.append(envelope.ValidationDetail('parentId', 'must be a positive integer'))
    metadata_set = 'metadata' in body and body.get('metadata') is not None
    if code is None and display_name is None and not parent_id_set and 'metadata' not in body:
        details.append(envelope.ValidationDetail('body', 'must include a field to update'))
    if details:
        raise envelope.validation_error(details)
    user = await deps.current_user(request)
    data = await admin_svc.update_knowledge_point(
        deps.pool(request), user, parsed_id,
        code, display_name, parent_id, parent_id_set,
        body.get('metadata') if isinstance(body.get('metadata'), dict) else None, metadata_set,
    )
    return envelope.ok(request, data)


@router.patch('/api/v1/users/{user_id}/status')
async def set_user_status(request: Request, user_id: str):
    parsed_id = deps.parse_path_id(user_id, 'userId')
    body = await deps.decode_json_body(request, {'isActive'})
    if not isinstance(body.get('isActive'), bool):
        raise envelope.validation_error([envelope.ValidationDetail('isActive', 'is required')])
    user = await deps.current_user(request)
    data = await admin_svc.set_user_status(deps.pool(request), user, parsed_id, body['isActive'])
    return envelope.ok(request, data)


@router.patch('/api/v1/users/{user_id}/access')
async def update_user_access(request: Request, user_id: str):
    parsed_id = deps.parse_path_id(user_id, 'userId')
    body = await deps.decode_json_body(request, {'role', 'membership'})
    details: list[envelope.ValidationDetail] = []
    role = body.get('role').strip() if isinstance(body.get('role'), str) and body['role'].strip() else None
    membership = (
        body.get('membership').strip()
        if isinstance(body.get('membership'), str) and body['membership'].strip()
        else None
    )
    if role is None and membership is None:
        details.append(envelope.ValidationDetail('body', 'must include role or membership'))
    if role is not None and role not in ('admin', 'user'):
        details.append(envelope.ValidationDetail('role', 'must be one of admin, user'))
    if membership is not None and membership not in ('free', 'plus', 'enterprise'):
        details.append(envelope.ValidationDetail('membership', 'must be one of free, plus, enterprise'))
    if details:
        raise envelope.validation_error(details)
    user = await deps.current_user(request)
    data = await admin_svc.update_user_access(deps.pool(request), user, parsed_id, role, membership)
    return envelope.ok(request, data)
