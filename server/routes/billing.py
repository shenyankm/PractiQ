"""RevenueCat billing and encrypted LLM configuration routes."""

import hmac
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, StringConstraints

from .. import envelope
from ..auth import runtime as auth_runtime
from ..services import billing as billing_svc
from ..services import users as users_svc
from . import deps

router = APIRouter()
Provider = Literal['dashscope', 'deepseek', 'moonshot']
APIKey = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2048)]
ModelName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
OptionalModelName = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]


class RevenueCatWebhookBody(BaseModel):
    event: dict[str, Any]


class LLMConfigBody(deps.RequestBody):
    provider: Provider
    api_key: APIKey
    text_model: ModelName
    vision_model: OptionalModelName | None = None


@router.post('/api/v1/billing/sync')
async def sync_billing(request: Request):
    user = await deps.current_user(request)
    membership = await billing_svc.sync_user(
        deps.pool(request),
        request.app.state.config,
        user.id,
        user.revenuecat_app_user_id,
    )
    fresh = await auth_runtime.current_user_by_id(deps.pool(request), user.id)
    return envelope.ok(
        request, fresh.as_dict() if fresh is not None else {'membership': membership}
    )


@router.post('/api/v1/billing/revenuecat/webhook')
async def revenuecat_webhook(request: Request, body: RevenueCatWebhookBody):
    expected = request.app.state.config.revenuecat_webhook_authorization
    supplied = request.headers.get('authorization', '')
    if not hmac.compare_digest(supplied, expected):
        raise envelope.new_error(
            401, 'INVALID_WEBHOOK_AUTH', 'Invalid webhook authorization'
        )
    ids: set[str] = set()
    for field in ('app_user_id', 'original_app_user_id'):
        value = body.event.get(field)
        if isinstance(value, str) and value:
            ids.add(value)
    for field in (
        'aliases',
        'transferred_from',
        'transferred_to',
        'redeemed_from',
        'redeemed_by',
    ):
        values = body.event.get(field)
        if isinstance(values, list):
            ids.update(value for value in values if isinstance(value, str) and value)
    users = await billing_svc.users_for_app_user_ids(
        deps.pool(request), list(ids)[:100]
    )
    await billing_svc.sync_users(
        deps.pool(request), request.app.state.config, users
    )
    return envelope.ok(request, {'processedUsers': len(users)})


@router.get('/api/v1/users/me/llm-config')
async def get_llm_config(request: Request):
    user = await deps.current_user(request)
    return envelope.ok(
        request, await users_svc.llm_config_metadata(deps.pool(request), user.id)
    )


@router.put('/api/v1/users/me/llm-config')
async def put_llm_config(request: Request, body: LLMConfigBody):
    user = await deps.current_user(request)
    saved = await users_svc.save_llm_config(
        deps.pool(request),
        user,
        request.app.state.config.llm_key_encryption_secret,
        users_svc.LLMConfig(
            provider=body.provider,
            api_key=body.api_key,
            text_model=body.text_model,
            vision_model=body.vision_model or None,
        ),
    )
    return envelope.ok(request, saved)


@router.delete('/api/v1/users/me/llm-config')
async def delete_llm_config(request: Request):
    user = await deps.current_user(request)
    await users_svc.delete_llm_config(deps.pool(request), user.id)
    return envelope.no_content(request)
