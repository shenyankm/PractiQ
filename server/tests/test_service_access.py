"""The personal service opens without an application access token."""

import httpx
import pytest
from fastapi.routing import APIRoute

from practiq_ai import runtime, task_api, webapp
from practiq_ai.config import load


@pytest.mark.usefixtures("business_http")
async def test_local_metadata_needs_no_token_or_model_work(monkeypatch):
    monkeypatch.delenv('AI_SERVICE_TOKEN', raising=False)
    monkeypatch.setattr(runtime, 'current', None)
    load()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as client:
        for path in ('/api/import-capabilities', '/api/metrics', '/api/maintenance'):
            response = await client.get(path)
            assert response.status_code == 200, response.text


@pytest.mark.usefixtures("business_http")
@pytest.mark.parametrize('headers', [
    {'Origin': 'https://unrelated.example'}, {'Origin': 'null'}, {'Sec-Fetch-Site': 'cross-site'},
])
async def test_cross_site_browser_requests_stop_before_work(monkeypatch, headers):
    def forbidden():
        pytest.fail('A cross-site request reached service configuration')

    monkeypatch.setattr(webapp, 'load', forbidden)
    monkeypatch.setattr(task_api, 'client', forbidden)
    monkeypatch.setattr(webapp, 'get_object_store', forbidden)
    monkeypatch.setattr(webapp, 'grade', forbidden)
    checked = 0
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as client:
        for route in webapp.app.routes:
            if not isinstance(route, APIRoute) or not route.path.startswith('/api/'):
                continue
            path = route.path.replace('{thread_id}', '00000000-0000-4000-8000-000000000000')
            for method in (route.methods or set()) - {'OPTIONS', 'HEAD'}:
                response = await client.request(method, path, headers=headers, json={})
                assert response.status_code == 403, (method, path, response.text)
                assert response.json()['detail']['code'] == 'CROSS_ORIGIN_REQUEST'
                checked += 1
    assert checked


@pytest.mark.usefixtures("business_http")
async def test_same_origin_browser_reads_do_not_need_a_token():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as client:
        response = await client.get('/api/import-capabilities', headers={'Origin': 'http://test', 'Sec-Fetch-Site': 'same-origin'})
    assert response.status_code == 200


@pytest.mark.usefixtures("business_http")
async def test_metrics_bind_only_non_secret_model_configuration(monkeypatch):
    from practiq_ai import runtime, webapp
    from practiq_ai.config import evaluation_configuration, load
    from practiq_ai.execution import fingerprint

    monkeypatch.setattr(runtime, "current", None)
    monkeypatch.setenv("LLM_API_KEY", "private-model-fixture-key")
    monkeypatch.setenv("LLM_BASE_URL", "https://private-fixture.example/v1")
    expected = fingerprint(evaluation_configuration(load()))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url="http://test",
                                 headers={}) as client:
        response = await client.get("/api/metrics")
    assert response.status_code == 200 and f'configuration_hash="{expected}"' in response.text
    assert all(value not in response.text for value in ("private-model-fixture-key", "private-fixture.example", "test-token"))
