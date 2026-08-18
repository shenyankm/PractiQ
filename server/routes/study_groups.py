"""Organization-tier study-group routes."""

from typing import Annotated

from fastapi import APIRouter, Request
from pydantic import StringConstraints

from .. import envelope
from ..services import study_groups as study_groups_svc
from . import deps

router = APIRouter()

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
Username = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class CreateStudyGroupBody(deps.RequestBody):
    name: Name
    description: Description | None = None


class UpdateStudyGroupBody(deps.RequestBody):
    name: Name | None = None
    description: Description | None = None


class AddMemberBody(deps.RequestBody):
    username: Username


@router.get('/api/v1/study-groups')
async def list_study_groups(request: Request):
    user = await deps.current_user(request)
    return envelope.ok(
        request, await study_groups_svc.list_my_groups(deps.pool(request), user)
    )


@router.post('/api/v1/study-groups')
async def create_study_group(request: Request, body: CreateStudyGroupBody):
    user = await deps.current_user(request)
    data = await study_groups_svc.create_group(
        deps.pool(request), user, body.name, body.description
    )
    return envelope.created(request, data)


@router.get('/api/v1/study-groups/{group_id}')
async def get_study_group(request: Request, group_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request, await study_groups_svc.get_group(deps.pool(request), user, group_id)
    )


@router.patch('/api/v1/study-groups/{group_id}')
async def update_study_group(
    request: Request, group_id: deps.PositiveId, body: UpdateStudyGroupBody
):
    user = await deps.current_user(request)
    data = await study_groups_svc.update_group(
        deps.pool(request), user, group_id, body.name, body.description
    )
    return envelope.ok(request, data)


@router.delete('/api/v1/study-groups/{group_id}')
async def delete_study_group(request: Request, group_id: deps.PositiveId):
    user = await deps.current_user(request)
    await study_groups_svc.delete_group(deps.pool(request), user, group_id)
    return envelope.no_content(request)


@router.post(
    '/api/v1/study-groups/{group_id}/members',
)
async def add_study_group_member(
    request: Request, group_id: deps.PositiveId, body: AddMemberBody
):
    user = await deps.current_user(request)
    data = await study_groups_svc.add_member(
        deps.pool(request), user, group_id, body.username
    )
    return envelope.created(request, data)


@router.delete('/api/v1/study-groups/{group_id}/members/{user_id}')
async def remove_study_group_member(
    request: Request, group_id: deps.PositiveId, user_id: deps.PositiveId
):
    user = await deps.current_user(request)
    await study_groups_svc.remove_member(
        deps.pool(request), user, group_id, user_id
    )
    return envelope.no_content(request)


@router.get('/api/v1/study-groups/{group_id}/members/{user_id}/stats')
async def get_study_group_member_stats(
    request: Request, group_id: deps.PositiveId, user_id: deps.PositiveId
):
    user = await deps.current_user(request)
    data = await study_groups_svc.get_member_stats(
        deps.pool(request), user, group_id, user_id
    )
    return envelope.ok(request, data)


@router.put('/api/v1/study-groups/{group_id}/banks/{bank_id}')
async def link_study_group_bank(
    request: Request, group_id: deps.PositiveId, bank_id: deps.PositiveId
):
    user = await deps.current_user(request)
    data = await study_groups_svc.link_bank(
        deps.pool(request), user, group_id, bank_id
    )
    return envelope.created(request, data)


@router.delete('/api/v1/study-groups/{group_id}/banks/{bank_id}')
async def unlink_study_group_bank(
    request: Request, group_id: deps.PositiveId, bank_id: deps.PositiveId
):
    user = await deps.current_user(request)
    await study_groups_svc.unlink_bank(
        deps.pool(request), user, group_id, bank_id
    )
    return envelope.no_content(request)
