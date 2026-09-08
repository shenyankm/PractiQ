import pytest
from langgraph_sdk import Auth

from practiq_ai.auth import authenticate


async def test_auth_accepts_valid_bearer_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_SERVICE_TOKEN", "secret")
    assert await authenticate("Bearer secret") == {"identity": "practiq-java"}


@pytest.mark.parametrize("authorization", (None, "", "Basic secret", "Bearer wrong"))
async def test_auth_rejects_missing_or_invalid_token(
    monkeypatch: pytest.MonkeyPatch, authorization: str | None
) -> None:
    monkeypatch.setenv("AI_SERVICE_TOKEN", "secret")
    with pytest.raises(Auth.exceptions.HTTPException) as exc:
        await authenticate(authorization)
    assert exc.value.status_code == 401


async def test_only_existing_get_liveness_probe_is_public() -> None:
    assert await authenticate(None, "/api/health/live", "GET") == {"identity": "health-probe"}
    for path, method in [("/api/health/live", "POST"), ("/threads", "GET"), ("/api/uploads", "POST")]:
        with pytest.raises(Auth.exceptions.HTTPException):
            await authenticate(None, path, method)
