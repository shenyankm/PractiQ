"""RevenueCat billing and encrypted LLM configuration routes."""

from __future__ import annotations

import hmac

from fastapi import APIRouter, Request

from .. import envelope
from ..services import billing as billing_svc
from ..services import users as users_svc
from . import deps

router = APIRouter()
MAX_WEBHOOK_BYTES = 256 * 1024


@router.post('/api/v1/billing/sync')
async def sync_billing(request: Request):
    user = await deps.current_user(request)
    membership = await billing_svc.sync_user(
        deps.pool(request), request.app.state.config, user.id, user.revenuecat_app_user_id
    )
    return envelope.ok(request, {'membership': membership})


@router.post('/api/v1/billing/revenuecat/webhook')
async def revenuecat_webhook(request: Request):
    expected = request.app.state.config.revenuecat_webhook_authorization
    supplied = request.headers.get('authorization', '')
    if not hmac.compare_digest(supplied, expected):
        raise envelope.new_error(401, 'INVALID_WEBHOOK_AUTH', 'Invalid webhook authorization')
    content_length = request.headers.get('content-length', '')
    if content_length.isdigit() and int(content_length) > MAX_WEBHOOK_BYTES:
        raise envelope.request_too_large()
    body = await request.body()
    if len(body) > MAX_WEBHOOK_BYTES:
        raise envelope.request_too_large()
    import json
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise envelope.invalid_json() from exc
    event = payload.get('event') if isinstance(payload, dict) else None
    if not isinstance(event, dict):
        raise envelope.invalid_json()
    ids: set[str] = set()
    for field in ('app_user_id', 'original_app_user_id'):
        value = event.get(field)
        if isinstance(value, str) and value:
            ids.add(value)
    for field in ('aliases', 'transferred_from', 'transferred_to', 'redeemed_from', 'redeemed_by'):
        values = event.get(field)
        if isinstance(values, list):
            ids.update(value for value in values if isinstance(value, str) and value)
    users = await billing_svc.users_for_app_user_ids(deps.pool(request), list(ids)[:100])
    await billing_svc.sync_users(deps.pool(request), request.app.state.config, users)
    return envelope.ok(request, {'processedUsers': len(users)})


@router.get('/api/v1/users/me/llm-config')
async def get_llm_config(request: Request):
    user = await deps.current_user(request)
    return envelope.ok(request, await users_svc.llm_config_metadata(deps.pool(request), user.id))


@router.put('/api/v1/users/me/llm-config')
async def put_llm_config(request: Request):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'provider', 'apiKey', 'textModel', 'visionModel'})
    provider = body.get('provider') if isinstance(body.get('provider'), str) else ''
    api_key = body.get('apiKey') if isinstance(body.get('apiKey'), str) else ''
    text_model = body.get('textModel') if isinstance(body.get('textModel'), str) else ''
    vision_model = body.get('visionModel') if isinstance(body.get('visionModel'), str) else None
    details: list[envelope.ValidationDetail] = []
    if provider not in users_svc.LLM_PROVIDERS:
        details.append(envelope.ValidationDetail('provider', 'is not supported'))
    if not api_key.strip() or len(api_key) > 2048:
        details.append(envelope.ValidationDetail('apiKey', 'must contain 1 to 2,048 characters'))
    if not text_model.strip() or len(text_model) > 200:
        details.append(envelope.ValidationDetail('textModel', 'must contain 1 to 200 characters'))
    if vision_model is not None and len(vision_model) > 200:
        details.append(envelope.ValidationDetail('visionModel', 'must contain at most 200 characters'))
    if details:
        raise envelope.validation_error(details)
    config = users_svc.LLMConfig(
        provider=provider,
        api_key=api_key.strip(),
        text_model=text_model.strip(),
        vision_model=vision_model.strip() or None if vision_model is not None else None,
    )
    saved = await users_svc.save_llm_config(
        deps.pool(request), user, request.app.state.config.llm_key_encryption_secret, config
    )
    return envelope.ok(request, saved)


@router.delete('/api/v1/users/me/llm-config')
async def delete_llm_config(request: Request):
    user = await deps.current_user(request)
    await users_svc.delete_llm_config(deps.pool(request), user.id)
    return envelope.no_content(request)
