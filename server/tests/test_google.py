"""Google OAuth tests mirroring backend/internal/auth/google_test.go."""

from __future__ import annotations

import time
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlencode, urlparse

import fakeredis.aioredis
import pytest
from fastapi import Request, Response
from httpx import ASGITransport, AsyncClient
from fastapi.responses import RedirectResponse

from server import envelope, redisx
from server.app import create_app
from server.auth import google, handlers, runtime
from server.auth.google import GoogleClaims
from server.routes import auth
from tests.fakes import FakeCursor, FakePool


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
    query = parse_qs(urlparse(location).query)
    assert query['code_challenge_method'] == ['S256']
    assert query['nonce']


async def test_google_callback_rejects_state_mismatch(client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('GOOGLE_CLIENT_ID', 'web-client-id')
    response = await client.get(
        '/api/v1/auth/google/callback?state=forged&code=abc',
        cookies={google.GOOGLE_STATE_COOKIE_NAME: 'expected'},
        follow_redirects=False,
    )
    assert response.status_code == 401
    assert response.json()['error']['code'] == 'GOOGLE_AUTH_FAILED'


def _token_verifier_stub(monkeypatch: pytest.MonkeyPatch, payload: dict):
    monkeypatch.setattr(google.google_id_token, 'verify_oauth2_token', lambda *_args: payload)


def _callback_request(state: str, code: str) -> Request:
    return Request({
        'type': 'http',
        'method': 'GET',
        'path': '/api/v1/auth/google/callback',
        'query_string': urlencode({'state': state, 'code': code}).encode(),
        'headers': [(b'cookie', f'{google.GOOGLE_STATE_COOKIE_NAME}={state}'.encode())],
        'client': ('127.0.0.1', 1),
    })


def _token_response() -> runtime.SessionTokens:
    now = datetime.now(timezone.utc)
    return runtime.SessionTokens('access-token', 'refresh-token', now + timedelta(minutes=10), now + timedelta(days=30))


async def test_google_token_rejects_audience_mismatch(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('GOOGLE_CLIENT_ID', 'web-client-id')
    monkeypatch.setenv('GOOGLE_MOBILE_CLIENT_IDS', 'android-id, ios-id')
    _token_verifier_stub(monkeypatch, {
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
    _token_verifier_stub(monkeypatch, {
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
    def expired(*_args):
        raise ValueError('expired')

    monkeypatch.setattr(google.google_id_token, 'verify_oauth2_token', expired)
    with pytest.raises(envelope.APIError):
        await google.verify_google_id_token('fake')


async def test_google_token_rejects_nonce_mismatch(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('GOOGLE_CLIENT_ID', 'web-client-id')
    _token_verifier_stub(monkeypatch, {
        'aud': 'web-client-id', 'iss': 'accounts.google.com', 'sub': 'google-sub-1',
        'email': 'alice@example.com', 'email_verified': True, 'nonce': 'unexpected',
    })
    with pytest.raises(envelope.APIError) as exc_info:
        await google.verify_google_id_token('fake', 'expected')
    assert exc_info.value.code == 'GOOGLE_AUTH_FAILED'


async def test_google_browser_transaction_is_single_use(monkeypatch: pytest.MonkeyPatch):
    fake = fakeredis.aioredis.FakeRedis()
    monkeypatch.setenv('GOOGLE_CLIENT_ID', 'web-client-id')
    monkeypatch.setattr(redisx, 'client', lambda: fake)
    _, state = await google.google_start_params()
    stored = await fake.get(google._oauth_state_key(state))
    assert stored is not None
    transaction = json.loads(stored)
    assert transaction['nonce'] and transaction['code_verifier']
    assert await google._consume_oauth_transaction(state) == transaction
    with pytest.raises(envelope.APIError) as exc_info:
        await google._consume_oauth_transaction(state)
    assert exc_info.value.code == 'GOOGLE_AUTH_FAILED'


async def test_google_callback_exchanges_code_with_stored_pkce_and_nonce(monkeypatch: pytest.MonkeyPatch):
    fake = fakeredis.aioredis.FakeRedis()
    monkeypatch.setenv('GOOGLE_CLIENT_ID', 'web-client-id')
    monkeypatch.setattr(redisx, 'client', lambda: fake)
    _, state = await google.google_start_params()
    transaction = json.loads(await fake.get(google._oauth_state_key(state)))
    captured: dict[str, str] = {}

    async def exchange(client_id: str, code: str, code_verifier: str, nonce: str):
        captured.update(client_id=client_id, code=code, code_verifier=code_verifier, nonce=nonce)
        return GoogleClaims('google-sub', 'alice@example.com', True)

    expected = runtime.User(1, 'alice', 'alice@example.com', True, 'user', 'free')

    async def find_user(_pool, claims):
        assert claims.sub == 'google-sub'
        return expected

    monkeypatch.setattr(google, '_exchange_google_code', exchange)
    monkeypatch.setattr(google, 'find_or_create_google_user', find_user)
    user = await google.google_callback(
        _callback_request(state, 'authorization-code'), RedirectResponse('/'), FakePool()
    )
    assert user == expected
    assert captured == {
        'client_id': 'web-client-id', 'code': 'authorization-code',
        'code_verifier': transaction['code_verifier'], 'nonce': transaction['nonce'],
    }
    assert await fake.get(google._oauth_state_key(state)) is None


async def test_google_email_collision_requires_explicit_link(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(redisx, 'client', lambda: None)
    pool = FakePool([
        ('WHERE google_sub', FakeCursor([])),
        ('SELECT 1 FROM users', FakeCursor([(1,)])),
    ])
    with pytest.raises(envelope.APIError) as exc_info:
        await google.find_or_create_google_user(
            pool, GoogleClaims('google-sub', 'alice@example.com', True)
        )
    assert exc_info.value.status == 409
    assert exc_info.value.code == 'ACCOUNT_LINK_REQUIRED'


async def test_google_user_creation_and_existing_account_paths(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(redisx, 'client', lambda: None)
    created_pool = FakePool([
        ('WHERE google_sub', FakeCursor([])),
        ('SELECT 1 FROM users', FakeCursor([])),
        ('INSERT INTO users', FakeCursor([(7, 'alice_123456', 'alice@example.com', True, 'user', 'free', 'rc-id')])),
    ])
    created = await google.find_or_create_google_user(
        created_pool, GoogleClaims('new-google-sub', 'alice@example.com', True)
    )
    assert created.id == 7
    insert_params = next(params for sql, params in created_pool.record if 'INSERT INTO users' in sql)
    assert insert_params[1:] == ('alice@example.com', 'new-google-sub')

    existing_pool = FakePool([(
        'WHERE google_sub',
        FakeCursor([(8, 'alice', 'alice@example.com', True, 'user', 'free', 'rc-id')]),
    )])
    existing = await google.find_or_create_google_user(
        existing_pool, GoogleClaims('known-google-sub', 'ignored@example.com', True)
    )
    assert existing.id == 8


async def test_google_user_rejects_unverified_or_inactive_accounts(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(redisx, 'client', lambda: None)
    with pytest.raises(envelope.APIError) as exc_info:
        await google.find_or_create_google_user(FakePool([('WHERE google_sub', FakeCursor([]))]), GoogleClaims('sub', 'a@b.c', False))
    assert exc_info.value.code == 'GOOGLE_EMAIL_UNVERIFIED'

    inactive_pool = FakePool([(
        'WHERE google_sub',
        FakeCursor([(8, 'alice', 'alice@example.com', False, 'user', 'free', 'rc-id')]),
    )])
    with pytest.raises(envelope.APIError) as exc_info:
        await google.find_or_create_google_user(inactive_pool, GoogleClaims('known-sub', 'alice@example.com', True))
    assert exc_info.value.code == 'USER_INACTIVE'


async def test_google_routes_issue_rotating_session_tokens(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('GOOGLE_CLIENT_ID', 'web-client-id')
    pool = FakePool()
    monkeypatch.setattr(auth.deps, 'pool', lambda _request: pool)

    async def no_rate_limit(*_args):
        return None

    user = runtime.User(1, 'alice', 'alice@example.com', True, 'user', 'free')

    async def verified(_id_token):
        return GoogleClaims('google-sub', 'alice@example.com', True)

    async def find_user(_pool, _claims):
        return user

    async def issue_session(_pool, user_id):
        assert user_id == user.id
        return _token_response()

    monkeypatch.setattr(auth.handlers, 'rate_limit_auth', no_rate_limit)
    monkeypatch.setattr(auth.google, 'verify_google_id_token', verified)
    monkeypatch.setattr(auth.google, 'find_or_create_google_user', find_user)
    monkeypatch.setattr(auth.runtime, 'issue_session', issue_session)
    request = Request({
        'type': 'http', 'method': 'POST', 'path': '/api/v1/auth/google/token',
        'headers': [(b'content-type', b'application/json')], 'query_string': b'', 'client': ('127.0.0.1', 1),
    })
    request._body = b'{"idToken":"native-id-token"}'
    response = await auth.google_token(request, Response())
    body = json.loads(response.body)
    assert body['data']['username'] == 'alice'
    assert body['data']['tokens']['accessToken'] == 'access-token'
    cookies = response.headers.getlist('set-cookie')
    assert any(cookie.startswith('session=access-token') for cookie in cookies)
    assert any(cookie.startswith('refresh_token=refresh-token') for cookie in cookies)


async def test_google_callback_route_sets_session_after_verified_callback(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('APP_ORIGIN', 'https://app.example.test')
    user = runtime.User(1, 'alice', 'alice@example.com', True, 'user', 'free')

    async def verified_callback(_request, _response, _pool):
        return user

    async def issue_session(_pool, user_id):
        assert user_id == user.id
        return _token_response()

    monkeypatch.setattr(auth.deps, 'pool', lambda _request: FakePool())
    monkeypatch.setattr(auth.google, 'google_callback', verified_callback)
    monkeypatch.setattr(auth.runtime, 'issue_session', issue_session)
    response = await auth.google_callback(_callback_request('state', 'code'))
    assert response.headers['location'] == 'https://app.example.test'
    assert any(cookie.startswith('session=access-token') for cookie in response.headers.getlist('set-cookie'))


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
