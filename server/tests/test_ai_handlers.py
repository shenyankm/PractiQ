from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from server import envelope, middleware
from server.app import create_app
from server.config import Config


class FailingService:
    async def parse_document(self, payload):
        raise envelope.new_error(502, 'AI_PROVIDER_UNAVAILABLE', 'provider unavailable')

    generate_answer = parse_document
    learning_report = parse_document


def _config() -> Config:
    return Config('test', '127.0.0.1', 8080, 'test-token', 'dashscope', 'key', 'model', None)


@pytest.fixture
def app():
    return create_app(_config(), FailingService())


@pytest.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as value:
        yield value


def _headers(token: str = 'test-token') -> dict[str, str]:
    return {'Authorization': f'Bearer {token}'}


@pytest.mark.parametrize(('path', 'payload'), (
    ('/api/v1/ai/parse-document', {'sourceType': 'text', 'text': '1. What is 2+2?'}),
    ('/api/v1/ai/generate-answer', {'stem': 'What is 2 + 2?', 'answerMode': 'choice'}),
    ('/api/v1/ai/learning-report', {'stats': {'answers': 3}}),
))
async def test_ai_routes_map_service_failure(client: AsyncClient, path: str, payload: dict[str, Any]):
    response = await client.post(path, json=payload, headers=_headers())
    assert response.status_code == 502


async def test_health_route_stays_public(client: AsyncClient):
    response = await client.get('/api/health/live')
    assert response.status_code == 200


async def test_ai_routes_require_service_token(client: AsyncClient):
    response = await client.post('/api/v1/ai/generate-answer', json={'stem': 'x', 'answerMode': 'choice'})
    assert response.status_code == 401
    response = await client.post('/api/v1/ai/generate-answer', json={'stem': 'x', 'answerMode': 'choice'}, headers=_headers('wrong'))
    assert response.status_code == 401


@pytest.mark.parametrize(
    ('path', 'payload', 'status'),
    (
        ('/api/v1/ai/generate-answer', {'stem': 'x'}, 422),
        ('/api/v1/ai/generate-answer', {'stem': 'x', 'answerMode': 'choice', 'extra': 1}, 400),
        ('/api/v1/ai/generate-answer', {'stem': 'x', 'answerMode': 'choice', 'questionId': 1}, 400),
        ('/api/v1/ai/learning-report', {'scope': 'galaxy'}, 422),
        ('/api/v1/ai/learning-report', {'userId': 7, 'extra': 1}, 400),
        ('/api/v1/ai/parse-document', {'sourceType': 'text'}, 422),
        ('/api/v1/ai/parse-document', None, 400),
    ),
)
async def test_ai_routes_reject_invalid_payloads(
    client: AsyncClient, path: str, payload: dict[str, Any], status: int,
):
    response = await client.post(path, json=payload, headers=_headers())
    assert response.status_code == status
    assert response.json()['error']['code'] == (
        'INVALID_JSON' if status == 400 else 'VALIDATION_ERROR'
    )


async def test_parse_route_rejects_oversized_body(client: AsyncClient):
    response = await client.post('/api/v1/ai/parse-document', content=b'x' * (middleware.AI_JSON_BODY_BYTES + 1), headers={**_headers(), 'Content-Type': 'application/json'})
    assert response.status_code == 413
