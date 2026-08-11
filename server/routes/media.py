"""Media routes. Mirrors media_routes.go."""

from __future__ import annotations

from email.message import Message

from fastapi import APIRouter, Request, Response
from starlette.datastructures import UploadFile

from .. import envelope
from ..services import media as media_svc
from . import deps

router = APIRouter()


def _validate_media_link(body: dict) -> tuple[int, str, int | None]:
    details: list[envelope.ValidationDetail] = []
    media_id = body.get('mediaId')
    if not isinstance(media_id, int) or media_id <= 0:
        details.append(envelope.ValidationDetail('mediaId', 'must be a positive integer'))
    media_kind = body.get('mediaKind') if isinstance(body.get('mediaKind'), str) else ''
    media_kind = media_kind.strip()
    if not media_kind or len(media_kind) > 64:
        details.append(envelope.ValidationDetail('mediaKind', 'must be 1-64 characters'))
    sort_order = body.get('sortOrder')
    if sort_order is not None and (not isinstance(sort_order, int) or sort_order < 1 or sort_order > 32767):
        details.append(envelope.ValidationDetail('sortOrder', 'must be between 1 and 32767'))
    if details:
        raise envelope.validation_error(details)
    return media_id, media_kind, sort_order


@router.post('/api/v1/media')
async def create_media(request: Request):
    user = await deps.current_user(request)
    content_type = request.headers.get('content-type', '').lower()
    if 'multipart/form-data' not in content_type:
        raise envelope.new_error(400, 'INVALID_MULTIPART', 'A multipart file upload is required')
    form = await request.form()
    upload = form.get('file')
    if not isinstance(upload, UploadFile):
        raise envelope.new_error(400, 'FILE_REQUIRED', 'Upload file is required')
    content = await upload.read()
    data = await media_svc.create_uploaded_media(
        deps.pool(request), user, media_svc.UploadedMediaFile(name=upload.filename or '', content=content)
    )
    return envelope.created(request, data)


@router.get('/api/v1/media/{media_id}')
async def get_media(request: Request, media_id: str):
    user = await deps.current_user(request)
    data = await media_svc.get_media_asset(
        deps.pool(request), user, deps.parse_path_id(media_id, 'mediaId')
    )
    return envelope.ok(request, data)


@router.get('/api/v1/media/{media_id}/content')
async def media_content(request: Request, media_id: str):
    user = await deps.current_user(request)
    asset, content = await media_svc.read_media_asset_content(
        deps.pool(request), user, deps.parse_path_id(media_id, 'mediaId')
    )
    headers = {'Cache-Control': 'private, max-age=3600'}
    if asset.get('mime_type'):
        headers['Content-Type'] = asset['mime_type']
    if asset.get('original_name'):
        message = Message()
        message.add_header('Content-Disposition', 'inline', filename=asset['original_name'])
        headers['Content-Disposition'] = message['Content-Disposition']
    return Response(content=content, headers=headers, media_type=asset.get('mime_type'))


@router.delete('/api/v1/media/{media_id}')
async def delete_media(request: Request, media_id: str):
    user = await deps.current_user(request)
    await media_svc.delete_media_asset(
        deps.pool(request), user, deps.parse_path_id(media_id, 'mediaId')
    )
    return envelope.no_content(request)


@router.post('/api/v1/questions/{question_id}/media-links')
async def link_question(request: Request, question_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'mediaId', 'mediaKind', 'sortOrder'})
    media_id, media_kind, sort_order = _validate_media_link(body)
    data = await media_svc.link_question_media(
        deps.pool(request), user, deps.parse_path_id(question_id, 'questionId'),
        media_id, media_kind, sort_order,
    )
    return envelope.created(request, data)


@router.post('/api/v1/groups/{group_id}/media-links')
async def link_group(request: Request, group_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'mediaId', 'mediaKind', 'sortOrder'})
    media_id, media_kind, sort_order = _validate_media_link(body)
    data = await media_svc.link_group_media(
        deps.pool(request), user, deps.parse_path_id(group_id, 'groupId'),
        media_id, media_kind, sort_order,
    )
    return envelope.created(request, data)


@router.post('/api/v1/options/{option_id}/media-links')
async def link_option(request: Request, option_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'mediaId', 'mediaKind', 'sortOrder'})
    media_id, media_kind, sort_order = _validate_media_link(body)
    data = await media_svc.link_option_media(
        deps.pool(request), user, deps.parse_path_id(option_id, 'optionId'),
        media_id, media_kind, sort_order,
    )
    return envelope.created(request, data)


@router.delete('/api/v1/questions/{question_id}/media-links/{media_id}')
async def unlink_question(request: Request, question_id: str, media_id: str):
    user = await deps.current_user(request)
    await media_svc.unlink_question_media(
        deps.pool(request), user,
        deps.parse_path_id(question_id, 'questionId'), deps.parse_path_id(media_id, 'mediaId'),
    )
    return envelope.no_content(request)


@router.delete('/api/v1/groups/{group_id}/media-links/{media_id}')
async def unlink_group(request: Request, group_id: str, media_id: str):
    user = await deps.current_user(request)
    await media_svc.unlink_group_media(
        deps.pool(request), user,
        deps.parse_path_id(group_id, 'groupId'), deps.parse_path_id(media_id, 'mediaId'),
    )
    return envelope.no_content(request)


@router.delete('/api/v1/options/{option_id}/media-links/{media_id}')
async def unlink_option(request: Request, option_id: str, media_id: str):
    user = await deps.current_user(request)
    await media_svc.unlink_option_media(
        deps.pool(request), user,
        deps.parse_path_id(option_id, 'optionId'), deps.parse_path_id(media_id, 'mediaId'),
    )
    return envelope.no_content(request)
