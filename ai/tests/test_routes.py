from __future__ import annotations

import sys
from importlib import import_module
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel
import pytest


AI_ROOT = Path(__file__).resolve().parents[1]
if str(AI_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_ROOT))


TOKEN = "test-ai-token"


@pytest.fixture(autouse=True)
def clear_ai_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AI_SERVICE_TOKEN", raising=False)


def clear_ai_modules() -> None:
    sys.modules.pop("openwook_ai.main", None)


def require_module(name: str) -> Any:
    try:
        return import_module(name)
    except ModuleNotFoundError as exc:
        pytest.fail(f"Migration contract missing module {name}: {exc}")


def require_fastapi_app(
    monkeypatch: pytest.MonkeyPatch, *, token: str | None
) -> FastAPI:
    if token is None:
        monkeypatch.delenv("AI_SERVICE_TOKEN", raising=False)
    else:
        monkeypatch.setenv("AI_SERVICE_TOKEN", token)

    clear_ai_modules()
    module = require_module("openwook_ai.main")

    try:
        app = module.app
    except AttributeError:
        pytest.fail(
            "Migration contract missing FastAPI app named app in openwook_ai.main"
        )

    assert isinstance(app, FastAPI), (
        "openwook_ai.main.app must be a FastAPI application"
    )
    return app


def make_client(
    monkeypatch: pytest.MonkeyPatch, *, token: str | None = None
) -> TestClient:
    return TestClient(require_fastapi_app(monkeypatch, token=token))


def require_schema_model(name: str) -> type[BaseModel]:
    module = require_module("openwook_ai.schemas")
    try:
        model = getattr(module, name)
    except AttributeError:
        pytest.fail(
            f"Migration contract missing schema model {name} in openwook_ai.schemas"
        )

    assert isinstance(model, type) and issubclass(model, BaseModel), (
        f"{name} must be a Pydantic model"
    )
    return model


def make_document_parse_request() -> dict[str, Any]:
    return {
        "importJobId": 12,
        "bankId": 34,
        "sourceType": "text",
        "fileName": "questions.txt",
        "text": "1. What is 2+2?\nA. 4\nB. 5\n答案: A",
        "mimeType": "text/plain",
    }


def make_answer_generation_request() -> dict[str, Any]:
    return {
        "questionId": 91,
        "stem": "What is 2 + 2?",
        "answerMode": "choice",
        "options": [
            {"label": "A", "content": "4"},
            {"label": "B", "content": "5"},
        ],
        "analysis": "Basic arithmetic",
    }


def make_learning_report_request() -> dict[str, Any]:
    return {
        "userId": 7,
        "bankId": 21,
        "practiceSessionId": 35,
        "scope": "individual",
    }


@pytest.mark.parametrize("path", ("/internal/health/live", "/internal/health/ready"))
def test_health_routes_return_ok_json(
    monkeypatch: pytest.MonkeyPatch, path: str
) -> None:
    client = make_client(monkeypatch)

    response = client.get(path)

    assert response.status_code == 200
    assert response.json() == {"ok": True}


@pytest.mark.parametrize(
    ("path", "payload"),
    (
        ("/internal/ai/parse-document", make_document_parse_request()),
        ("/internal/ai/generate-answer", make_answer_generation_request()),
        ("/internal/ai/learning-report", make_learning_report_request()),
    ),
)
def test_internal_ai_routes_require_bearer_token_when_configured(
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    payload: dict[str, Any],
) -> None:
    client = make_client(monkeypatch, token=TOKEN)

    missing = client.post(path, json=payload)
    wrong = client.post(
        path, json=payload, headers={"Authorization": "Bearer wrong-token"}
    )

    assert missing.status_code == 401
    assert wrong.status_code == 401


@pytest.mark.parametrize(
    ("path", "payload", "result_model_name"),
    (
        (
            "/internal/ai/parse-document",
            make_document_parse_request(),
            "DocumentParseResult",
        ),
        (
            "/internal/ai/generate-answer",
            make_answer_generation_request(),
            "AnswerGenerationResult",
        ),
        (
            "/internal/ai/learning-report",
            make_learning_report_request(),
            "LearningReportResult",
        ),
    ),
)
def test_internal_ai_routes_accept_authorized_schema_payloads(
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    payload: dict[str, Any],
    result_model_name: str,
) -> None:
    client = make_client(monkeypatch, token=TOKEN)
    result_model = require_schema_model(result_model_name)

    response = client.post(
        path, json=payload, headers={"Authorization": f"Bearer {TOKEN}"}
    )

    assert response.status_code == 200
    result_model.model_validate(response.json())
