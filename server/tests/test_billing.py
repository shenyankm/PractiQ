from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from server import config, envelope
from server.app import create_app
from server.routes import billing as billing_routes
from server.services import billing


def _config() -> config.Config:
    return config.Config(
        node_env='test', host='127.0.0.1', port=8080, app_origin='http://test',
        revenuecat_project_id='proj_test', revenuecat_secret_api_key='sk_test',
        revenuecat_pro_entitlement_id='entl_pro',
        revenuecat_webhook_authorization='Bearer webhook-test',
        llm_key_encryption_secret='encrypt-test',
    )


class _Response:
    def __init__(self, status_code: int, payload: object):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _Client:
    def __init__(self, response: _Response):
        self.response = response

    async def get(self, *args, **kwargs):
        return self.response


async def test_revenuecat_active_entitlement_maps_to_pro():
    membership = await billing._membership(
        _Client(_Response(200, {'items': [{'entitlement_id': 'entl_pro'}]})),
        _config(),
        'user-id',
    )
    assert membership == 'pro'


async def test_revenuecat_missing_customer_maps_to_free():
    assert await billing._membership(
        _Client(_Response(404, {})), _config(), 'missing-user'
    ) == 'free'


async def test_revenuecat_failure_does_not_become_free():
    with pytest.raises(envelope.APIError) as exc_info:
        await billing._membership(_Client(_Response(503, {})), _config(), 'user-id')
    assert exc_info.value.code == 'REVENUECAT_UNAVAILABLE'


async def test_webhook_requires_auth_and_refreshes_aliases(monkeypatch: pytest.MonkeyPatch):
    seen: list[str] = []

    async def users_for_ids(pool, ids):
        seen.extend(ids)
        return [(1, '11111111-1111-4111-8111-111111111111')]

    async def sync_users(pool, cfg, users):
        assert users == [(1, '11111111-1111-4111-8111-111111111111')]

    monkeypatch.setattr(billing_routes.billing_svc, 'users_for_app_user_ids', users_for_ids)
    monkeypatch.setattr(billing_routes.billing_svc, 'sync_users', sync_users)
    app = create_app(cfg=_config(), pool=object())
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        denied = await client.post('/api/v1/billing/revenuecat/webhook', json={'event': {}})
        assert denied.status_code == 401
        response = await client.post(
            '/api/v1/billing/revenuecat/webhook',
            headers={'Authorization': 'Bearer webhook-test'},
            json={'event': {
                'app_user_id': 'current',
                'original_app_user_id': 'original',
                'aliases': ['alias'],
                'transferred_from': ['source'],
                'transferred_to': ['destination'],
                'redeemed_from': ['web-source'],
                'redeemed_by': ['redeemer'],
            }},
        )
    assert response.status_code == 200
    assert set(seen) == {
        'current', 'original', 'alias', 'source', 'destination', 'web-source', 'redeemer',
    }
