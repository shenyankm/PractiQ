"""Google OAuth tests mirroring backend/internal/auth/google_test.go."""

from __future__ import annotations

import time

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient

from server import envelope, redisx
from server.app import create_app
from server.auth import google, handlers, runtime
from server.auth.google import GoogleClaims


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('AUTH_SECRET', 'test-secret')
    monkeypatch.setenv('POSTGRES_URL', 'postgres://localhost:1/nope')
    monkeypatch.setenv('APP_ORIGIN', 'https://app.example.test')
    fake = fakeredis.aioredis.FakeRedis()
    monkeypatch.setattr(redisx, 'client', lambda: fake)
    return create_app()


@pytest.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://t') as c:
        yield c


async def test_google_start_disabled(client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv('GOOGLE_CLIENT_ID', raising=False)
    response = await client.get('/api/v1/auth/google/start', follow_redirects=False)
    assert response.status_code == 404
    assert response.json()['error']['code'] == 'GOOGLE_AUTH_DISABLED'


async def test_google_start_redirects_with_state_cookie(client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('GOOGLE_CLIENT_ID', 'web-client-id')
    response = await client.get('/api/v1/auth/google/start', follow_redirects=False)
    assert response.status_code == 302
    location = response.headers['location']
    assert 'client_id=web-client-id' in location
    assert 'redirect_uri=https%3A%2F%2Fapp.example.test%2Fapi%2Fv1%2Fauth%2Fgoogle%2Fcallback' in location
    state_cookie = next(
        (h.split(';', 1)[0].split('=', 1)[1] for h in response.headers.get_list('set-cookie')
         if h.startswith(f'{google.GOOGLE_STATE_COOKIE_NAME}=')),
        None,
    )
    assert state_cookie
    assert f'state={state_cookie}' in location


async def test_google_callback_rejects_state_mismatch(client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('GOOGLE_CLIENT_ID', 'web-client-id')
    response = await client.get(
        '/api/v1/auth/google/callback?state=forged&code=abc',
        cookies={google.GOOGLE_STATE_COOKIE_NAME: 'expected'},
        follow_redirects=False,
    )
    assert response.status_code == 401
    assert response.json()['error']['code'] == 'GOOGLE_AUTH_FAILED'


def _tokeninfo_stub(monkeypatch: pytest.MonkeyPatch, payload: dict):
    class _Resp:
        status_code = 200

        def json(self):
            return payload

    class _Client:
        async def get(self, url, **kwargs):
            return _Resp()

    monkeypatch.setattr(google, '_http', lambda: _Client())


async def test_google_token_rejects_audience_mismatch(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('GOOGLE_CLIENT_ID', 'web-client-id')
    monkeypatch.setenv('GOOGLE_MOBILE_CLIENT_IDS', 'android-id, ios-id')
    _tokeninfo_stub(monkeypatch, {
        'aud': 'attacker-client-id',
        'iss': 'https://accounts.google.com',
        'sub': 'google-sub-1',
        'email': 'alice@example.com',
        'email_verified': 'true',
        'exp': str(int(time.time()) + 3600),
    })
    with pytest.raises(envelope.APIError) as exc_info:
        await google.verify_google_id_token('fake')
    assert exc_info.value.code == 'GOOGLE_AUTH_FAILED'


async def test_google_token_verifies_mobile_user(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('GOOGLE_CLIENT_ID', 'web-client-id')
    monkeypatch.setenv('GOOGLE_MOBILE_CLIENT_IDS', 'android-id')
    _tokeninfo_stub(monkeypatch, {
        'aud': 'android-id',
        'iss': 'accounts.google.com',
        'sub': 'google-sub-1',
        'email': 'alice@example.com',
        'email_verified': 'true',
        'exp': str(int(time.time()) + 3600),
    })
    claims = await google.verify_google_id_token('fake')
    assert claims == GoogleClaims(sub='google-sub-1', email='alice@example.com', email_verified=True)


async def test_google_token_rejects_expired(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('GOOGLE_CLIENT_ID', 'web-client-id')
    _tokeninfo_stub(monkeypatch, {
        'aud': 'web-client-id',
        'iss': 'accounts.google.com',
        'sub': 'google-sub-1',
        'email': 'alice@example.com',
        'email_verified': 'true',
        'exp': str(int(time.time()) - 10),
    })
    with pytest.raises(envelope.APIError):
        await google.verify_google_id_token('fake')


def test_google_username_produces_valid_usernames():
    for email in (
        'alice@example.com',
        'a.b-c+tag@example.com',
        '北京用户@example.com',
        'verylongaddresslocalpart@example.com',
    ):
        username = google._google_username(email)
        assert handlers.username_validation_detail(username) is None, username


async def test_email_code_stores_and_sends(monkeypatch: pytest.MonkeyPatch):
    fake = fakeredis.aioredis.FakeRedis()
    monkeypatch.setattr(redisx, 'client', lambda: fake)
    sent: dict[str, str] = {}

    from server.auth import email_code

    def fake_deliver(email: str, code: str) -> None:
        sent['email'], sent['code'] = email, code

    monkeypatch.setattr(email_code, 'deliver_email_code', fake_deliver)
    await email_code.send_code('alice@example.com')
    assert sent['email'] == 'alice@example.com'
    assert len(sent['code']) == 6
    stored = await fake.get(email_code._email_code_key('alice@example.com'))
    assert stored.decode() == sent['code']
    ttl = await fake.ttl(email_code._email_code_key('alice@example.com'))
    assert 0 < ttl <= email_code.EMAIL_CODE_TTL_SECONDS


async def test_verify_email_code_single_use(monkeypatch: pytest.MonkeyPatch):
    fake = fakeredis.aioredis.FakeRedis()
    monkeypatch.setattr(redisx, 'client', lambda: fake)
    from server.auth import email_code

    key = email_code._email_code_key('alice@example.com')
    await fake.set(key, '123456', ex=600)

    with pytest.raises(envelope.APIError):
        await email_code.verify_email_code('alice@example.com', '000000')

    await email_code.verify_email_code('alice@example.com', '123456')
    assert await fake.get(key) is None  # consumed

    with pytest.raises(envelope.APIError):
        await email_code.verify_email_code('alice@example.com', '123456')
