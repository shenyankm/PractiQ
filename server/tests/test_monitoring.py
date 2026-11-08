"""Metrics credentials cannot become customer or administrator sessions."""
import httpx
import pytest
from fastapi import FastAPI

from practiq_ai.account_middleware import AccountMiddleware
from scripts.load_test import login, metrics_token


async def test_metrics_credential_only_authorizes_passive_metrics(monkeypatch):
    token = 'm' * 43
    monkeypatch.setenv('AI_METRICS_TOKEN', token)
    app = FastAPI()
    app.add_middleware(AccountMiddleware)

    @app.get('/api/metrics')
    async def metrics():
        return {'up': 1}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        assert (await client.get('/api/metrics')).status_code == 401
        headers = {'Authorization': 'Bearer ' + token}
        assert (await client.get('/api/metrics', headers=headers)).json() == {'up': 1}
        for method, path in [('POST', '/api/metrics'), ('GET', '/api/admin/users'),
                             ('POST', '/api/document-tasks'), ('GET', '/api/subjective-grades')]:
            assert (await client.request(method, path, headers=headers)).status_code == 401
        monkeypatch.setenv('AI_METRICS_TOKEN', 'n' * 43)
        assert (await client.get('/api/metrics', headers=headers)).status_code == 401
        monkeypatch.setenv('AI_METRICS_TOKEN', 'short')
        assert (await client.get('/api/metrics', headers={'Authorization': 'Bearer short'})).status_code == 401


def test_metrics_file_is_private_regular_and_bounded(tmp_path):
    path = tmp_path / 'metrics'
    path.write_text('m' * 43 + '\n')
    path.chmod(0o600)
    assert metrics_token(path) == 'm' * 43
    link = tmp_path / 'link'
    link.symlink_to(path)
    with pytest.raises(ValueError):
        metrics_token(link)
    path.chmod(0o644)
    with pytest.raises(ValueError):
        metrics_token(path)
    path.chmod(0o600)
    path.write_text('x' * 131)
    with pytest.raises(ValueError):
        metrics_token(path)


async def test_load_login_uses_cookie_and_new_csrf_without_redirects():
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'csrf': 'before'}, headers={'set-cookie': 'practiq_session=anonymous; Path=/'})
        assert request.headers['x-csrf-token'] == 'before'
        assert 'practiq_session=anonymous' in request.headers['cookie']
        return httpx.Response(200, json={'csrf': 'after'}, headers={'set-cookie': 'practiq_session=authenticated; Path=/'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond), base_url='https://test') as client:
        await login(client, 'user@example.test', 'test-password')
        assert client.headers['X-CSRF-Token'] == 'after'
        assert client.cookies['practiq_session'] == 'authenticated'


async def test_load_runner_authenticates_uploads_and_separates_monitoring(monkeypatch, tmp_path):
    from argparse import Namespace

    from scripts import load_test
    path = tmp_path / 'token'
    path.write_text('m' * 43)
    path.chmod(0o600)
    calls = []
    def respond(request):
        calls.append((request.method, request.url.path))
        if request.url.path == '/api/auth/session':
            return httpx.Response(200, json={'csrf': 'anonymous'}, headers={'set-cookie': 'practiq_session=anonymous; Path=/'})
        if request.url.path == '/api/auth/login':
            assert request.headers['x-csrf-token'] == 'anonymous'
            return httpx.Response(200, json={'csrf': 'authenticated'}, headers={'set-cookie': 'practiq_session=authenticated; Path=/'})
        if request.url.path == '/api/metrics':
            assert request.headers['authorization'] == 'Bearer ' + 'm' * 43
            assert not request.headers.get('cookie')
            return httpx.Response(200, text='practiq_running_runs 0\npractiq_workers_max 1\n')
        if request.url.path == '/ok':
            assert not request.headers.get('authorization')
            return httpx.Response(200, text='ok')
        assert 'practiq_session=authenticated' in request.headers['cookie']
        assert request.headers['x-csrf-token'] == 'authenticated'
        assert not request.headers.get('authorization')
        if request.url.path == '/api/uploads':
            return httpx.Response(200, json={'upload': None, 'document': {'sha256': 'a' * 64}})
        if request.url.path == '/api/document-tasks':
            return httpx.Response(202, json={'threadId': 'task', 'runId': 'run'})
        if request.url.path == '/api/document-tasks/task':
            return httpx.Response(200, json={'phase': 'completed', 'state': 'COMPLETED', 'status': 'SUCCEEDED'})
        assert request.url.path == '/api/auth/logout'
        return httpx.Response(200, json={'ok': True})
    original = httpx.AsyncClient
    monkeypatch.setattr(load_test.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs))
    monkeypatch.setattr(load_test.getpass, 'getpass', lambda _: 'private-test-password')
    report = await load_test.run(Namespace(metrics_token_file=path, email='user@example.test', base_url='http://localhost',
        submit_concurrency=1, request_timeout=5, environment='local', input=None, text='source', pid=None,
        total=1, completion_timeout=5, api='document-tasks', max_running=1, graph_concurrency=1,
        allow_rejections=False, image_digest=None))
    assert report['status'] == 'PASSED'
    assert calls[-1] == ('POST', '/api/auth/logout')
    assert ('GET', '/api/metrics') in calls
    assert 'private-test-password' not in str(report) and 'm' * 43 not in str(report)
