from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from main import app
from schemas import (
    AnswerGenerationResult,
    DocumentParseResult,
    LearningReportResult,
)


TOKEN = 'test-ai-token'


def document_request() -> dict[str, Any]:
    return {
        'sourceType': 'text',
        'fileName': 'questions.txt',
        'text': '1. What is 2+2?\nA. 4\nB. 5',
        'mimeType': 'text/plain',
    }


@pytest.mark.parametrize(
    ('path', 'payload', 'result_model'),
    (
        ('/internal/ai/parse-document', document_request(), DocumentParseResult),
        (
            '/internal/ai/generate-answer',
            {
                'stem': 'What is 2 + 2?',
                'answerMode': 'choice',
                'options': [
                    {'label': 'A', 'content': '4'},
                    {'label': 'B', 'content': '5'},
                ],
            },
            AnswerGenerationResult,
        ),
        ('/internal/ai/learning-report', {'userId': 7, 'stats': {'answers': 3}}, LearningReportResult),
    ),
)
def test_json_route_requires_auth_and_returns_its_contract(
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    payload: dict[str, Any],
    result_model: type[BaseModel],
) -> None:
    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)
    monkeypatch.delenv('DASHSCOPE_API_KEY', raising=False)
    client = TestClient(app)

    assert client.post(path, json=payload).status_code == 401

    response = client.post(
        path,
        json=payload,
        headers={'Authorization': f'Bearer {TOKEN}'},
    )

    assert response.status_code == 200
    result_model.model_validate(response.json())


@pytest.mark.parametrize(
    ('path', 'payload'),
    (
        ('/internal/ai/generate-answer', {'stem': 'x'}),  # 缺 answerMode
        ('/internal/ai/generate-answer', {'stem': 'x', 'answerMode': 'choice', 'extra': 1}),
        ('/internal/ai/learning-report', {'scope': 'galaxy'}),
        ('/internal/ai/learning-report', {'userId': 7, 'extra': 1}),
    ),
)
def test_answer_and_report_routes_reject_invalid_payloads(
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    payload: dict[str, Any],
) -> None:
    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)

    response = TestClient(app).post(
        path,
        json=payload,
        headers={'Authorization': f'Bearer {TOKEN}'},
    )

    assert response.status_code == 422


def test_health_routes_report_liveness_and_readiness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv('AI_SERVICE_TOKEN', raising=False)
    client = TestClient(app)

    assert client.get('/internal/health/live').json() == {'ok': True}
    assert client.get('/internal/health/ready').status_code == 503

    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)
    assert client.get('/internal/health/ready').json() == {'ok': True}


def test_parse_route_rejects_an_oversized_streamed_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)
    monkeypatch.setenv('IMPORT_SOURCE_MAX_BYTES', '4')

    response = TestClient(app).post(
        '/internal/ai/parse-document',
        content=iter((b'x' * (512 * 1024), b'x' * (512 * 1024 + 17))),
        headers={
            'Authorization': f'Bearer {TOKEN}',
            'Content-Type': 'application/json',
        },
    )

    assert response.status_code == 413


@pytest.mark.parametrize(
    'path',
    ('/internal/ai/generate-answer', '/internal/ai/learning-report'),
)
def test_other_ai_routes_reject_oversized_streamed_bodies(
    monkeypatch: pytest.MonkeyPatch,
    path: str,
) -> None:
    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)

    response = TestClient(app).post(
        path,
        content=iter((b'x' * (512 * 1024), b'x' * (512 * 1024 + 17))),
        headers={
            'Authorization': f'Bearer {TOKEN}',
            'Content-Type': 'application/json',
        },
    )

    assert response.status_code == 413
