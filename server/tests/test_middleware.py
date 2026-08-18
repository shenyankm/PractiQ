"""Middleware tests."""

import fakeredis.aioredis
import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient

from server import middleware, redisx


def _app(node_env: str = 'development', app_origin: str = 'http://localhost:8080') -> FastAPI:
    app = FastAPI()

    app.add_middleware(middleware.JsonBodyLimitMiddleware)
    app.add_middleware(middleware.IdempotencyMiddleware)
    app.add_middleware(middleware.SameOriginProtectionMiddleware, app_origin=app_origin)
    app.add_middleware(middleware.RateLimitMiddleware)
    app.add_middleware(middleware.RequestIDMiddleware)
    app.add_middleware(middleware.SecurityHeadersMiddleware, node_env=node_env)

    @app.get('/api/health')
    async def health():
        return {'ok': True}

    @app.get('/api/v1/banks')
    async def banks():
        return {'items': []}

    @app.post('/api/v1/banks')
    async def create_bank():
        return {'id': 1}

    @app.post('/api/v1/auth/login')
    async def login(request: Request):
        await request.body()
        return {'ok': True}

    return app


@pytest.fixture
def fake_redis(monkeypatch):
    fake = fakeredis.aioredis.FakeRedis()
    monkeypatch.setattr(redisx, '_client', fake)
    monkeypatch.setattr(redisx, '_client_url', 'redis://fake')
    monkeypatch.setenv('REDIS_URL', 'redis://fake')
    yield fake
    redisx._reset()


@pytest.fixture
def no_redis(monkeypatch):
    monkeypatch.delenv('REDIS_URL', raising=False)
    redisx._reset()
    yield
    redisx._reset()


async def test_security_headers_development(no_redis):
    async with AsyncClient(transport=ASGITransport(app=_app('development')), base_url='http://localhost:8080') as client:
        response = await client.get('/api/health')
    assert "'unsafe-eval'" in response.headers['content-security-policy']
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert response.headers['x-frame-options'] == 'DENY'
    assert response.headers['referrer-policy'] == 'strict-origin-when-cross-origin'


async def test_security_headers_production_omits_unsafe_eval(no_redis):
    async with AsyncClient(transport=ASGITransport(app=_app('production')), base_url='http://localhost:8080') as client:
        response = await client.get('/api/health')
    assert "'unsafe-eval'" not in response.headers['content-security-policy']


async def test_request_id_passthrough_and_generation(no_redis):
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url='http://localhost:8080') as client:
        response = await client.get('/api/health', headers={'X-Request-ID': 'given-id'})
        assert response.headers['x-request-id'] == 'given-id'
        response = await client.get('/api/health')
        assert response.headers['x-request-id']
        response = await client.get('/api/health', headers={'X-Request-ID': 'x' * 200})
        generated = response.headers['x-request-id']
        assert generated and generated != 'x' * 200


async def test_same_origin_protection(no_redis):
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url='http://localhost:8080') as client:
        # No Origin/Referer: allowed (non-browser clients).
        response = await client.post('/api/v1/banks', json={})
        assert response.status_code == 200
        # Same origin: allowed.
        response = await client.post('/api/v1/banks', json={}, headers={'Origin': 'http://localhost:8080'})
        assert response.status_code == 200
        # Cross origin: rejected.
        response = await client.post('/api/v1/banks', json={}, headers={'Origin': 'https://evil.example'})
        assert response.status_code == 403
        assert response.json()['error']['code'] == 'INVALID_ORIGIN'
        # GET is not protected.
        response = await client.get('/api/v1/banks', headers={'Origin': 'https://evil.example'})
        assert response.status_code == 200


@pytest.mark.parametrize(
    ('path', 'size'),
    [
        ('/api/v1/banks', middleware.DEFAULT_JSON_BODY_BYTES + 1),
        ('/api/v1/auth/login', middleware.AUTH_JSON_BODY_BYTES + 1),
    ],
)
async def test_json_body_size_limit(no_redis, path, size):
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url='http://localhost:8080') as client:
        response = await client.post(
            path,
            content=b'"' + b'x' * size + b'"',
            headers={'content-type': 'application/json'},
        )
    assert response.status_code == 413
    assert response.json()['error']['code'] == 'REQUEST_TOO_LARGE'


async def test_chunked_json_body_size_limit(no_redis):
    async def chunks():
        yield b'"'
        yield b'x' * (middleware.AUTH_JSON_BODY_BYTES + 1)

    async with AsyncClient(transport=ASGITransport(app=_app()), base_url='http://localhost:8080') as client:
        response = await client.post(
            '/api/v1/auth/login',
            content=chunks(),
            headers={'content-type': 'application/problem+json'},
        )
    assert response.status_code == 413
    assert response.json()['error']['code'] == 'REQUEST_TOO_LARGE'


def test_import_artifact_uses_large_json_limit():
    assert (
        middleware.JsonBodyLimitMiddleware.maximum('/api/v1/import-jobs/1/file')
        == middleware.IMPORT_JSON_BODY_BYTES
    )


async def test_api_rate_limit_fail_open_without_redis(no_redis):
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url='http://localhost:8080') as client:
        response = await client.get('/api/v1/banks')
    assert response.status_code == 200


async def test_api_rate_limit_trips_after_300(fake_redis):
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url='http://localhost:8080') as client:
        for _ in range(300):
            response = await client.get('/api/v1/banks')
            assert response.status_code == 200
        response = await client.get('/api/v1/banks')
        assert response.status_code == 429
        assert response.json()['error']['code'] == 'RATE_LIMITED'
        # Health endpoints are exempt.
        response = await client.get('/api/health')
        assert response.status_code == 200


async def test_idempotency_replays_cached_response(fake_redis):
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url='http://localhost:8080') as client:
        first = await client.post('/api/v1/banks', json={}, headers={'Idempotency-Key': 'key-1'})
        assert first.status_code == 200
        second = await client.post('/api/v1/banks', json={}, headers={'Idempotency-Key': 'key-1'})
        assert second.status_code == 200
        assert second.json() == first.json()


async def test_idempotency_requires_redis(no_redis):
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url='http://localhost:8080') as client:
        response = await client.post('/api/v1/banks', json={}, headers={'Idempotency-Key': 'key-1'})
    assert response.status_code == 503
    assert response.json()['error']['code'] == 'IDEMPOTENCY_UNAVAILABLE'


async def test_idempotency_key_validation(fake_redis):
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url='http://localhost:8080') as client:
        response = await client.post('/api/v1/banks', json={}, headers={'Idempotency-Key': 'x' * 129})
    assert response.status_code == 422
    assert response.json()['error']['code'] == 'VALIDATION_ERROR'
