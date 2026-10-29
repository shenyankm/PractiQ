import httpx
import pytest
from fastapi import HTTPException
from fastapi.routing import APIRoute

from practiq_ai.auth import authenticate


def test_auth_accepts_valid_bearer_token(monkeypatch):
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'secret')
    authenticate('Bearer secret')


async def test_authenticated_metrics_bind_only_non_secret_model_configuration(monkeypatch):
    from practiq_ai import runtime, webapp
    from practiq_ai.config import evaluation_configuration, load
    from practiq_ai.execution import fingerprint

    monkeypatch.setattr(runtime, "current", None)
    monkeypatch.setenv("LLM_API_KEY", "private-model-fixture-key")
    monkeypatch.setenv("LLM_BASE_URL", "https://private-fixture.example/v1")
    expected = fingerprint(evaluation_configuration(load()))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url="http://test",
                                 headers={"Authorization": "Bearer test-token"}) as client:
        response = await client.get("/api/metrics")
    assert response.status_code == 200 and f'configuration_hash="{expected}"' in response.text
    assert all(value not in response.text for value in ("private-model-fixture-key", "private-fixture.example", "test-token"))


@pytest.mark.parametrize('authorization', [None, '', 'Basic secret', 'Bearer wrong'])
def test_auth_rejects_missing_or_invalid_token(monkeypatch, authorization):
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'secret')
    with pytest.raises(HTTPException) as error:
        authenticate(authorization)
    assert error.value.status_code == 401
    assert error.value.detail == {
        "code": "INVALID_SERVICE_TOKEN",
        "message": "Invalid service token",
        "params": {},
    }


@pytest.mark.parametrize('authorization', ['', 'Bearer wrong', 'Account retired-token'])
async def test_every_personal_api_rejects_invalid_credentials_before_work(monkeypatch, authorization):
    from practiq_ai import task_api, webapp

    monkeypatch.setenv('AI_SERVICE_TOKEN', 'secret')

    def forbidden(*args, **kwargs):
        pytest.fail('Unauthorized request reached runtime or storage')

    monkeypatch.setattr(task_api, 'client', forbidden)
    monkeypatch.setattr(webapp, 'get_object_store', forbidden)
    checked = 0
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as client:
        for route in webapp.app.routes:
            if not isinstance(route, APIRoute) or not route.path.startswith('/api/'):
                continue
            path = route.path.replace('{thread_id}', '00000000-0000-4000-8000-000000000000')
            for method in (route.methods or set()) - {'OPTIONS', 'HEAD'}:
                response = await client.request(method, path, headers={'Authorization': authorization}, json={})
                assert response.status_code == 401, (method, path, response.text)
                checked += 1
    assert checked
