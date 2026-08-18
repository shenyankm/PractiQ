"""Media asset routes."""

from email.message import Message
from typing import Annotated

from fastapi import APIRouter, File, Request, Response, UploadFile
from pydantic import Field, StringConstraints

from .. import envelope
from ..services import media as media_svc
from . import deps

router = APIRouter()

MediaKind = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]


class MediaLinkBody(deps.RequestBody):
    media_id: Annotated[int, Field(gt=0)]
    media_kind: MediaKind
    sort_order: Annotated[int, Field(ge=1, le=32767)] | None = None


@router.post('/api/v1/media')
async def create_media(request: Request, file: UploadFile | None = File(default=None)):
    user = await deps.current_user(request)
    if file is None:
        if 'multipart/form-data' not in request.headers.get('content-type', '').lower():
            raise envelope.new_error(
                400, 'INVALID_MULTIPART', 'A multipart file upload is required'
            )
        raise envelope.new_error(400, 'FILE_REQUIRED', 'Upload file is required')
    data = await media_svc.create_uploaded_media(
        deps.pool(request),
        user,
        media_svc.UploadedMediaFile(name=file.filename or '', content=await file.read()),
    )
    return envelope.created(request, data)


@router.get('/api/v1/media/{media_id}')
async def get_media(request: Request, media_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request, await media_svc.get_media_asset(deps.pool(request), user, media_id)
    )


@router.get('/api/v1/media/{media_id}/content')
async def media_content(request: Request, media_id: deps.PositiveId):
    user = await deps.current_user(request)
    asset, content = await media_svc.read_media_asset_content(
        deps.pool(request), user, media_id
    )
    headers = {'Cache-Control': 'private, max-age=3600'}
    if asset.get('mime_type'):
        headers['Content-Type'] = asset['mime_type']
    if asset.get('original_name'):
        message = Message()
        message.add_header(
            'Content-Disposition', 'inline', filename=asset['original_name']
        )
        headers['Content-Disposition'] = message['Content-Disposition']
    return Response(
        content=content, headers=headers, media_type=asset.get('mime_type')
    )


@router.delete('/api/v1/media/{media_id}')
async def delete_media(request: Request, media_id: deps.PositiveId):
    user = await deps.current_user(request)
    await media_svc.delete_media_asset(deps.pool(request), user, media_id)
    return envelope.no_content(request)


async def _link_media(request: Request, owner_id: int, body: MediaLinkBody, link):
    user = await deps.current_user(request)
    data = await link(
        deps.pool(request),
        user,
        owner_id,
        body.media_id,
        body.media_kind,
        body.sort_order,
    )
    return envelope.created(request, data)


@router.post('/api/v1/questions/{question_id}/media-links')
async def link_question(
    request: Request, question_id: deps.PositiveId, body: MediaLinkBody
):
    return await _link_media(request, question_id, body, media_svc.link_question_media)


@router.post('/api/v1/groups/{group_id}/media-links')
async def link_group(request: Request, group_id: deps.PositiveId, body: MediaLinkBody):
    return await _link_media(request, group_id, body, media_svc.link_group_media)


@router.post('/api/v1/options/{option_id}/media-links')
async def link_option(request: Request, option_id: deps.PositiveId, body: MediaLinkBody):
    return await _link_media(request, option_id, body, media_svc.link_option_media)


@router.delete('/api/v1/questions/{question_id}/media-links/{media_id}')
async def unlink_question(
    request: Request, question_id: deps.PositiveId, media_id: deps.PositiveId
):
    user = await deps.current_user(request)
    await media_svc.unlink_question_media(
        deps.pool(request), user, question_id, media_id
    )
    return envelope.no_content(request)


@router.delete('/api/v1/groups/{group_id}/media-links/{media_id}')
async def unlink_group(
    request: Request, group_id: deps.PositiveId, media_id: deps.PositiveId
):
    user = await deps.current_user(request)
    await media_svc.unlink_group_media(deps.pool(request), user, group_id, media_id)
    return envelope.no_content(request)


@router.delete('/api/v1/options/{option_id}/media-links/{media_id}')
async def unlink_option(
    request: Request, option_id: deps.PositiveId, media_id: deps.PositiveId
):
    user = await deps.current_user(request)
    await media_svc.unlink_option_media(
        deps.pool(request), user, option_id, media_id
    )
    return envelope.no_content(request)
