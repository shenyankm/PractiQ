from uuid import UUID

import pytest
from httpx import ASGITransport, AsyncClient

from practiq_ai.product import envelope, middleware
from practiq_ai.product.ai_schemas import AnswerGenerationResult, ModelCallUsage
from practiq_ai.product.app import create_app
from practiq_ai.product.config import Config
from practiq_ai.product.support import DocumentProcessingError

USAGE = ModelCallUsage(
    callKey=UUID("00000000-0000-0000-0000-000000000001"),
    modelId="test-model",
    inputTokens=10,
    outputTokens=5,
    callKind="answer_generation",
)


class FailingService:
    async def parse_document(self, payload):
        raise envelope.new_error(502, "AI_PROVIDER_UNAVAILABLE", "provider unavailable")

    generate_answer = parse_document
    learning_report = parse_document


class SuccessfulUsageService:
    async def generate_answer(self, payload):
        return AnswerGenerationResult(
            answerPayload={"correctOption": "A"},
            canonicalAnswer="A",
            explanation="Because.",
            steps=["Solve it"],
            confidence=1,
        ), [USAGE]


class UsageFailingService:
    async def generate_answer(self, payload):
        raise DocumentProcessingError(502, "provider failed", usage=[USAGE])


def _config() -> Config:
    return Config(
        "test", "127.0.0.1", 8080, "test-token", "dashscope", "key", "model", None
    )


@pytest.fixture
def app():
    return create_app(_config(), FailingService())


@pytest.fixture
async def client(app):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value


def _headers(token: str = "test-token") -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.parametrize(
    ("path", "payload"),
    (
        (
            "/api/v1/ai/parse-document",
            {"sourceType": "text", "text": "1. What is 2+2?"},
        ),
        (
            "/api/v1/ai/generate-answer",
            {"stem": "What is 2 + 2?", "answerMode": "choice"},
        ),
        (
            "/api/v1/ai/learning-report",
            {
                "scope": "individual",
                "stats": {
                    "attemptCount": 1,
                    "correctCount": 1,
                    "accuracy": 1,
                    "startedAt": "2026-01-01T00:00:00Z",
                    "endedAt": "2026-01-01T01:00:00Z",
                    "mastery": [{"label": "Math", "attempts": 1, "correct": 1}],
                    "accuracyTrend": [{"label": "Today", "accuracy": 1}],
                    "weakKnowledgePoints": ["Math"],
                },
            },
        ),
    ),
)
async def test_ai_routes_map_service_failure(
    client: AsyncClient, path: str, payload: object
):
    response = await client.post(path, json=payload, headers=_headers())
    assert response.status_code == 502


async def test_ai_success_and_terminal_failure_include_usage_meta():
    payload = {"stem": "x", "answerMode": "choice"}
    for service, expected in (
        (SuccessfulUsageService(), 200),
        (UsageFailingService(), 502),
    ):
        app = create_app(_config(), service)
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as local_client:
            response = await local_client.post(
                "/api/v1/ai/generate-answer", json=payload, headers=_headers()
            )
        assert response.status_code == expected
        assert response.json()["meta"]["usage"][0]["callKey"] == str(USAGE.callKey)


async def test_health_route_stays_public(client: AsyncClient):
    response = await client.get("/api/health/live")
    assert response.status_code == 200


async def test_ai_routes_require_service_token(client: AsyncClient):
    response = await client.post(
        "/api/v1/ai/generate-answer", json={"stem": "x", "answerMode": "choice"}
    )
    assert response.status_code == 401
    response = await client.post(
        "/api/v1/ai/generate-answer",
        json={"stem": "x", "answerMode": "choice"},
        headers=_headers("wrong"),
    )
    assert response.status_code == 401


@pytest.mark.parametrize(
    ("path", "payload", "status"),
    (
        ("/api/v1/ai/generate-answer", {"stem": "x"}, 422),
        (
            "/api/v1/ai/generate-answer",
            {"stem": "x", "answerMode": "choice", "extra": 1},
            400,
        ),
        (
            "/api/v1/ai/generate-answer",
            {"stem": "x", "answerMode": "choice", "questionId": 1},
            400,
        ),
        ("/api/v1/ai/learning-report", {"scope": "galaxy"}, 422),
        ("/api/v1/ai/learning-report", {"userId": 7, "extra": 1}, 400),
        ("/api/v1/ai/parse-document", {"sourceType": "text"}, 422),
        ("/api/v1/ai/parse-document", {"sourceType": "md", "text": "# Quiz"}, 422),
        (
            "/api/v1/ai/parse-document",
            {"sourceType": "text", "text": "# Quiz", "fileBase64": "eA=="},
            422,
        ),
        ("/api/v1/ai/parse-document", None, 400),
    ),
)
async def test_ai_routes_reject_invalid_payloads(
    client: AsyncClient,
    path: str,
    payload: object,
    status: int,
):
    response = await client.post(path, json=payload, headers=_headers())
    assert response.status_code == status
    assert response.json()["error"]["code"] == (
        "INVALID_JSON" if status == 400 else "VALIDATION_ERROR"
    )


async def test_parse_route_rejects_oversized_body(client: AsyncClient):
    response = await client.post(
        "/api/v1/ai/parse-document",
        content=b"x" * (middleware.AI_JSON_BODY_BYTES + 1),
        headers={**_headers(), "Content-Type": "application/json"},
    )
    assert response.status_code == 413
