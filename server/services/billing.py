"""RevenueCat entitlement synchronization."""

from urllib.parse import quote

import httpx
from psycopg_pool import AsyncConnectionPool

from .. import config, envelope
from ..auth import runtime as auth_runtime


async def _membership(client: httpx.AsyncClient, cfg: config.Config, app_user_id: str) -> str:
    url = (
        'https://api.revenuecat.com/v2/projects/'
        f'{quote(cfg.revenuecat_project_id, safe="")}/customers/'
        f'{quote(app_user_id, safe="")}/active_entitlements?limit=100'
    )
    try:
        response = await client.get(
            url,
            headers={
                'Accept': 'application/json',
                'Authorization': f'Bearer {cfg.revenuecat_secret_api_key}',
            },
        )
    except httpx.HTTPError as exc:
        raise envelope.new_error(
            502, 'REVENUECAT_UNAVAILABLE', 'Subscription verification is temporarily unavailable'
        ) from exc
    if response.status_code == 404:
        return 'free'
    if response.status_code != 200:
        raise envelope.new_error(
            502, 'REVENUECAT_UNAVAILABLE', 'Subscription verification is temporarily unavailable'
        )
    try:
        items = response.json()['items']
    except (KeyError, TypeError, ValueError) as exc:
        raise envelope.new_error(
            502, 'REVENUECAT_INVALID_RESPONSE', 'Subscription verification returned invalid data'
        ) from exc
    if not isinstance(items, list):
        raise envelope.new_error(
            502, 'REVENUECAT_INVALID_RESPONSE', 'Subscription verification returned invalid data'
        )
    entitlement_ids = {
        item.get('entitlement_id')
        for item in items
        if isinstance(item, dict) and isinstance(item.get('entitlement_id'), str)
    }
    if cfg.revenuecat_organization_entitlement_id in entitlement_ids:
        return 'organization'
    if cfg.revenuecat_pro_entitlement_id in entitlement_ids:
        return 'pro'
    return 'free'


async def sync_user(
    pool: AsyncConnectionPool,
    cfg: config.Config,
    user_id: int,
    app_user_id: str,
    client: httpx.AsyncClient | None = None,
) -> str:
    if client is None:
        async with httpx.AsyncClient(timeout=10) as owned_client:
            membership = await _membership(owned_client, cfg, app_user_id)
    else:
        membership = await _membership(client, cfg, app_user_id)
    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE users SET membership = %s WHERE id = %s AND membership IS DISTINCT FROM %s',
            (membership, user_id, membership),
        )
    await auth_runtime.invalidate_user_cache(user_id)
    return membership


async def users_for_app_user_ids(pool: AsyncConnectionPool, app_user_ids: list[str]) -> list[tuple[int, str]]:
    if not app_user_ids:
        return []
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT id, revenuecat_app_user_id::text
            FROM users
            WHERE revenuecat_app_user_id::text = ANY(%s)
            """,
            (app_user_ids,),
        )
        return [(row[0], row[1]) for row in await cursor.fetchall()]


async def sync_users(
    pool: AsyncConnectionPool, cfg: config.Config, users: list[tuple[int, str]],
) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        for user_id, app_user_id in users:
            await sync_user(pool, cfg, user_id, app_user_id, client)
