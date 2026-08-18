import json

import pytest
from httpx import ASGITransport, AsyncClient

from server import config
from server.app import create_app
from server.auth.runtime import User
from server.routes import content, deps


def _config() -> config.Config:
    return config.Config(
        node_env='test',
        host='127.0.0.1',
        port=8080,
        app_origin='http://test',
        revenuecat_project_id='project',
        revenuecat_secret_api_key='secret',
        revenuecat_pro_entitlement_id='pro',
        revenuecat_organization_entitlement_id='organization',
        revenuecat_webhook_authorization='webhook',
        llm_key_encryption_secret='encryption',
    )


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch):
    async def current_user(_request):
        return User(1, 'alice', None, True, 'user', 'free')

    async def create_bank(_pool, _user, name, description, subject, is_public):
        return {
            'id': 1,
            'name': name,
            'description': description,
            'subject': subject,
            'is_public': is_public,
        }

    async def get_bank(_pool, _user, bank_id):
        return {'id': bank_id}

    monkeypatch.setattr(deps, 'current_user', current_user)
    monkeypatch.setattr(content.banks_svc, 'create_bank', create_bank)
    monkeypatch.setattr(content.banks_svc, 'get_bank', get_bank)
    return create_app(cfg=_config(), pool=object())


async def test_request_validation_keeps_the_api_error_contract(app):
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        valid = await client.post(
            '/api/v1/banks',
            json={'name': 'Bank', 'subject': 'math', 'isPublic': True},
        )
        malformed = await client.post(
            '/api/v1/banks',
            content=b'{bad json',
            headers={'Content-Type': 'application/json'},
        )
        unknown = await client.post(
            '/api/v1/banks',
            json={'name': 'Bank', 'subject': 'math', 'extra': True},
        )
        invalid = await client.post('/api/v1/banks', json={'name': '', 'subject': ''})
        bad_path = await client.get('/api/v1/banks/0')
        bad_query = await client.get('/api/v1/banks?limit=0')
        oversized = await client.post(
            '/api/v1/banks',
            content=json.dumps({'name': 'x' * (1024 * 1024), 'subject': 'math'}),
            headers={'Content-Type': 'application/json'},
        )

    assert valid.status_code == 201
    assert malformed.status_code == 400
    assert malformed.json()['error']['code'] == 'INVALID_JSON'
    assert unknown.status_code == 400
    assert unknown.json()['error']['code'] == 'INVALID_JSON'
    for response in (invalid, bad_path, bad_query):
        assert response.status_code == 422
        assert response.json()['error']['code'] == 'VALIDATION_ERROR'
    assert oversized.status_code == 413
    assert oversized.json()['error']['code'] == 'REQUEST_TOO_LARGE'


async def test_unhandled_errors_use_the_api_envelope(app, monkeypatch: pytest.MonkeyPatch):
    async def fail(*_args, **_kwargs):
        raise RuntimeError('boom')

    monkeypatch.setattr(content.banks_svc, 'create_bank', fail)
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        response = await client.post('/api/v1/banks', json={'name': 'Bank', 'subject': 'math'})

    assert response.status_code == 500
    assert response.json()['error']['code'] == 'INTERNAL_ERROR'
