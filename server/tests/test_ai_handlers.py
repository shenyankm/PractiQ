"""AI route tests mirroring ai/tests/test_routes.py, adapted to /api/v1/ai/*.

Session auth + PRO entitlement replace the old AI_SERVICE_TOKEN bearer check.
"""

from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from server import envelope, middleware
from server.app import create_app
from server.auth.runtime import User
from server.routes import ai as ai_routes
from server.routes import deps

PRO_USER = User(
    id=7, username='pro', email=None, is_active=True, role='user', membership='pro',
    revenuecat_app_user_id='e9758391-ca02-4c51-a543-858b536e3f74',
)


class FailingModel:
    async def generate_structured_output(self, messages, structured_model):
        raise RuntimeError('provider unavailable')


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

    async def fake_current_user(request):
        return PRO_USER

    async def fake_models(request, user, feature):
        return FailingModel(), None

    monkeypatch.setattr(deps, 'current_user', fake_current_user)
    monkeypatch.setattr(ai_routes, '_models', fake_models)
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
async def test_ai_routes_map_provider_failure(client: AsyncClient, path: str, payload: dict):
    response = await client.post(path, json=payload)
    assert response.status_code == 502


@pytest.mark.parametrize(
    ('path', 'payload', 'status'),
    (
        ('/api/v1/ai/generate-answer', {'stem': 'x'}, 422),  # 缺 answerMode
        ('/api/v1/ai/generate-answer', {'stem': 'x', 'answerMode': 'choice', 'extra': 1}, 400),
        ('/api/v1/ai/learning-report', {'scope': 'galaxy'}, 422),
        ('/api/v1/ai/learning-report', {'userId': 7, 'extra': 1}, 400),
    ),
)
async def test_ai_routes_reject_invalid_payloads(
    client: AsyncClient, path: str, payload: dict, status: int
):
    response = await client.post(path, json=payload)
    assert response.status_code == status
    assert response.json()['error']['code'] == (
        'INVALID_JSON' if status == 400 else 'VALIDATION_ERROR'
    )


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
        content=b'x' * (middleware.AI_JSON_BODY_BYTES + 1),
        headers={'Content-Type': 'application/json'},
    )
    assert response.status_code == 413
