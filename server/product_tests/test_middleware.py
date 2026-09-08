from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from practiq_ai.product import middleware
from practiq_ai.product.app import create_app
from practiq_ai.product.config import Config


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(middleware.JsonBodyLimitMiddleware)
    app.add_middleware(middleware.RequestIDMiddleware)
    app.add_middleware(middleware.SecurityHeadersMiddleware)

    @app.api_route('/api/v1/ai/test', methods=['POST', 'PUT', 'PATCH'])
    async def ai_test():
        return {'ok': True}

    @app.post('/api/v1/ai/parse-document')
    async def parse_document():
        return {'ok': True}

    @app.post('/api/v1/ai/value-error')
    async def value_error():
        raise ValueError('downstream failure')

    @app.get('/api/health/live')
    async def live():
        return {'ok': True}

    return app


def test_ai_body_limit_covers_worst_case_json_escaping():
    assert 6 * middleware.get_upload_max_bytes() <= middleware.AI_JSON_BODY_BYTES


def _assert_security_headers(response):
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert response.headers['x-frame-options'] == 'DENY'
    assert response.headers['referrer-policy'] == 'no-referrer'
    assert response.headers['content-security-policy'] == "default-src 'none'; frame-ancestors 'none'"


async def test_security_headers_and_request_id():
    async with AsyncClient(transport=ASGITransport(_app()), base_url='http://test') as client:
        response = await client.get('/api/health/live', headers={'X-Request-ID': 'given-id'})
    assert response.headers['x-request-id'] == 'given-id'
    _assert_security_headers(response)


async def test_unhandled_errors_keep_security_headers():
    class ValueErrorService:
        async def generate_answer(self, payload):
            raise ValueError('downstream failure')

    app = create_app(
        Config('test', 'host', 8080, 'token', 'dashscope', 'key', 'model', None),
        ValueErrorService(),
    )
    async with AsyncClient(transport=ASGITransport(app, raise_app_exceptions=False), base_url='http://test') as client:
        response = await client.post(
            '/api/v1/ai/generate-answer',
            json={'stem': 'x', 'answerMode': 'choice'},
            headers={'Authorization': 'Bearer token'},
        )
    assert response.status_code == 500
    _assert_security_headers(response)


async def test_body_limits_apply_to_every_mutation_content_type():
    default_oversized = b'x' * (middleware.DEFAULT_JSON_BODY_BYTES + 1)
    async with AsyncClient(transport=ASGITransport(_app()), base_url='http://test') as client:
        for method in ('post', 'put', 'patch'):
            response = await getattr(client, method)(
                '/api/v1/ai/test',
                content=default_oversized,
                headers={'Content-Type': 'text/plain'},
            )
            assert response.status_code == 413
        response = await client.post(
            '/api/v1/ai/test',
            content=default_oversized,
            headers={'Content-Type': 'application/problem+json'},
        )
        assert response.status_code == 413
        response = await client.post('/api/v1/ai/parse-document', content=default_oversized)
        assert response.status_code == 200
        response = await client.post('/api/v1/ai/parse-document/', content=default_oversized)
        assert response.status_code == 307
        response = await client.post(
            '/api/v1/ai/parse-document',
            content=b'x' * (middleware.AI_JSON_BODY_BYTES + 1),
        )
    assert response.status_code == 413


async def test_native_graph_stream_receive_is_not_buffered():
    async def receive():
        return {"type": "http.disconnect"}

    async def downstream(scope, incoming, send):
        assert incoming is receive
        assert await incoming() == {"type": "http.disconnect"}

    await middleware.JsonBodyLimitMiddleware(downstream)(
        {"type": "http", "method": "POST", "path": "/runs/stream"}, receive, None
    )
