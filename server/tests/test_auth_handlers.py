"""Auth handler validation + rate limit tests."""

import fakeredis.aioredis
import pytest
from starlette.requests import Request

from server import envelope, redisx
from server.auth import handlers, runtime
from server.routes import auth as auth_routes


def _request(body: bytes = b'', path: str = '/api/v1/auth/login') -> Request:
    scope = {
        'type': 'http',
        'method': 'POST',
        'path': path,
        'headers': [(b'content-type', b'application/json')],
        'query_string': b'',
        'client': ('127.0.0.1', 12345),
        'state': {},
    }
    request = Request(scope)
    request._body = body
    return request


# ---------------------------------------------------------------- passwords


def test_bcrypt_roundtrip():
    password_hash = runtime.hash_password('correct horse battery staple')
    assert runtime.compare_password('correct horse battery staple', password_hash)
    assert not runtime.compare_password('wrong', password_hash)


def test_compare_password_rejects_malformed_hash():
    assert not runtime.compare_password('anything', 'not-a-bcrypt-hash')


def test_dummy_hash_is_valid_bcrypt():
    assert runtime.compare_password('x', runtime.DUMMY_PASSWORD_HASH) is False


# -------------------------------------------------------------- validation


def test_username_validation():
    assert handlers.username_validation_detail('ab') is not None
    assert handlers.username_validation_detail('a' * 21) is not None
    assert handlers.username_validation_detail('has space') is not None
    assert handlers.username_validation_detail('with-dash') is not None
    assert handlers.username_validation_detail('valid_name99') is None


def test_normalize_email():
    _, detail = handlers.normalize_email(None, True)
    assert detail is not None
    _, detail = handlers.normalize_email(None, False)
    assert detail is None
    email, detail = handlers.normalize_email('  user@example.com ', True)
    assert detail is None and email == 'user@example.com'
    _, detail = handlers.normalize_email('not-an-email', True)
    assert detail is not None
    _, detail = handlers.normalize_email('a@b.c' + 'x' * 300, True)
    assert detail is not None


def test_password_validation():
    assert handlers.password_validation_detail('password', 'short') is not None
    assert handlers.password_validation_detail('password', 'x' * 73) is not None
    assert handlers.password_validation_detail('password', 'eight+chars') is None


def test_validate_register_request():
    body = {'username': 'valid_name', 'email': 'u@example.com', 'password': 'password123', 'code': '123456'}
    parsed = auth_routes.RegisterBody.model_validate(body)
    assert parsed.username == 'valid_name'
    with pytest.raises(ValueError):
        auth_routes.RegisterBody.model_validate({**body, 'extra': 1})
    with pytest.raises(ValueError):
        auth_routes.RegisterBody.model_validate({**body, 'username': 'no'})


def test_validate_update_me_request():
    with pytest.raises(ValueError):
        auth_routes.UpdateProfileBody.model_validate({})
    input = auth_routes.UpdateProfileBody.model_validate({'username': 'new_name'}).as_input()
    assert input.username == 'new_name'
    with pytest.raises(ValueError):
        auth_routes.UpdateProfileBody.model_validate({'newPassword': 'password123'})
    input = auth_routes.UpdateProfileBody.model_validate({'email': None}).as_input()
    assert input.email_set is True and input.email is None


# -------------------------------------------------------------- rate limit


@pytest.fixture
def fake_redis(monkeypatch):
    fake = fakeredis.aioredis.FakeRedis()
    monkeypatch.setattr(redisx, '_client', fake)
    monkeypatch.setattr(redisx, '_client_url', 'redis://fake')
    monkeypatch.setenv('REDIS_URL', 'redis://fake')
    yield fake
    redisx._reset()


async def test_auth_rate_limit_fail_closed_without_redis(monkeypatch):
    monkeypatch.delenv('REDIS_URL', raising=False)
    redisx._reset()
    with pytest.raises(envelope.APIError) as exc_info:
        await handlers.rate_limit_auth(_request(), 'user@example.com')
    assert exc_info.value.status == 503
    assert exc_info.value.code == 'AUTH_RATE_LIMIT_UNAVAILABLE'
    redisx._reset()


async def test_auth_rate_limit_identity_dimension(fake_redis):
    request = _request()
    for _ in range(10):
        await handlers.rate_limit_auth(request, 'user@example.com')
    with pytest.raises(envelope.APIError) as exc_info:
        await handlers.rate_limit_auth(request, 'user@example.com')
    assert exc_info.value.status == 429
    assert exc_info.value.code == 'RATE_LIMITED'


async def test_auth_rate_limit_ip_only_when_no_identity(fake_redis):
    request = _request()
    for _ in range(10):
        await handlers.rate_limit_auth(request, '')
    with pytest.raises(envelope.APIError):
        await handlers.rate_limit_auth(request, '')
