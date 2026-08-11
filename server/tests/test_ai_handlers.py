"""AI route tests mirroring ai/tests/test_routes.py, adapted to /api/v1/ai/*.

Session auth + Plus entitlement replace the old AI_SERVICE_TOKEN bearer check.
"""

from __future__ import annotations

from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from server import envelope
from server.app import create_app
from server.auth.runtime import User
from server.routes import ai as ai_routes
from server.routes import deps

PLUS_USER = User(id=7, username='plus', email=None, is_active=True, role='user', membership='plus')


def document_request() -> dict[str, Any]:
    return {
        'sourceType': 'text',
        'fileName': 'questions.txt',
        'text': '1. What is 2+2?\nA. 4\nB. 5',
        'mimeType': 'text/plain',
    }


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('AUTH_SECRET', 'test-secret')
    monkeypatch.setenv('POSTGRES_URL', 'postgres://localhost:1/nope')
    monkeypatch.delenv('DASHSCOPE_API_KEY', raising=False)

    async def fake_current_user(request):
        return PLUS_USER

    async def fake_require_plus(request, user, feature):
        return None

    monkeypatch.setattr(deps, 'current_user', fake_current_user)
    monkeypatch.setattr(ai_routes, '_require_plus', fake_require_plus)
    return create_app()


@pytest.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://t') as c:
        yield c


@pytest.mark.parametrize(
    ('path', 'payload'),
    (
        ('/api/v1/ai/parse-document', document_request()),
        (
            '/api/v1/ai/generate-answer',
            {
                'stem': 'What is 2 + 2?',
                'answerMode': 'choice',
                'options': [
                    {'label': 'A', 'content': '4'},
                    {'label': 'B', 'content': '5'},
                ],
            },
        ),
        ('/api/v1/ai/learning-report', {'userId': 7, 'stats': {'answers': 3}}),
    ),
)
async def test_ai_routes_return_503_without_provider(client: AsyncClient, path: str, payload: dict):
    # 未配置 DASHSCOPE_API_KEY 时明确返回 503，而不是编造假数据。
    response = await client.post(path, json=payload)
    assert response.status_code == 503


@pytest.mark.parametrize(
    ('path', 'payload'),
    (
        ('/api/v1/ai/generate-answer', {'stem': 'x'}),  # 缺 answerMode
        ('/api/v1/ai/generate-answer', {'stem': 'x', 'answerMode': 'choice', 'extra': 1}),
        ('/api/v1/ai/learning-report', {'scope': 'galaxy'}),
        ('/api/v1/ai/learning-report', {'userId': 7, 'extra': 1}),
    ),
)
async def test_ai_routes_reject_invalid_payloads(client: AsyncClient, path: str, payload: dict):
    response = await client.post(path, json=payload)
    assert response.status_code == 422
    assert response.json()['error']['code'] == 'VALIDATION_ERROR'


async def test_parse_document_requires_text_or_file(client: AsyncClient):
    response = await client.post(
        '/api/v1/ai/parse-document',
        json={'sourceType': 'text', 'fileName': 'q.txt', 'mimeType': 'text/plain'},
    )
    assert response.status_code == 422


async def test_learning_report_forbidden_for_other_user(client: AsyncClient):
    response = await client.post('/api/v1/ai/learning-report', json={'userId': 999})
    assert response.status_code == 403
    assert response.json()['error']['code'] == 'FORBIDDEN'


async def test_ai_routes_require_authentication(app):
    async def no_user(request):
        raise envelope.new_error(401, 'UNAUTHENTICATED', 'Authentication required')

    original = deps.current_user
    deps.current_user = no_user
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://t') as c:
            response = await c.post('/api/v1/ai/generate-answer', json={'stem': 'x', 'answerMode': 'choice'})
            assert response.status_code == 401
    finally:
        deps.current_user = original


async def test_parse_route_rejects_oversized_body(client: AsyncClient):
    response = await client.post(
        '/api/v1/ai/parse-document',
        content=b'x' * (ai_routes.MAX_AI_JSON_BODY_BYTES + 1),
        headers={'Content-Type': 'application/json'},
    )
    assert response.status_code == 413
