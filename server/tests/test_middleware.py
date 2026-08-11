"""Middleware tests mirroring backend/internal/httpserver/middleware_test.go."""

from __future__ import annotations

import fakeredis.aioredis
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from server import middleware, redisx


def _app(node_env: str = 'development', app_origin: str = 'http://localhost:8080') -> FastAPI:
    app = FastAPI()

    async def verify_session(token: str) -> bool:
        return token == 'valid'

    app.add_middleware(middleware.SPAGuardMiddleware, app_origin=app_origin, verify_session=verify_session)
    app.add_middleware(middleware.IdempotencyMiddleware)
    app.add_middleware(middleware.SameOriginProtectionMiddleware, app_origin=app_origin)
    app.add_middleware(middleware.RateLimitMiddleware)
    app.add_middleware(middleware.RecoveryMiddleware)
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

    @app.get('/banks/1')
    async def bank_page():
        return {'page': True}

    @app.get('/boom')
    async def boom():
        raise RuntimeError('boom')

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


async def test_recovery_returns_internal_error_envelope(no_redis):
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url='http://localhost:8080') as client:
        response = await client.get('/boom')
    assert response.status_code == 500
    assert response.json()['error']['code'] == 'INTERNAL_ERROR'


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


async def test_spa_guard_redirects_unauthenticated(no_redis):
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url='http://localhost:8080') as client:
        response = await client.get('/banks/1', follow_redirects=False)
        assert response.status_code == 307
        assert response.headers['location'].startswith('http://localhost:8080/sign-in?redirect=')
        # With a valid session cookie the page is served.
        response = await client.get('/banks/1', cookies={'session': 'valid'})
        assert response.status_code == 200
        # API paths are never redirected.
        response = await client.get('/api/v1/banks')
        assert response.status_code == 200
