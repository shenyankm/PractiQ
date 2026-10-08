import asyncio
import json
from dataclasses import replace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

from practiq_ai import task_api
from practiq_ai.config import load
from practiq_ai.middleware import DEFAULT_JSON_BODY_BYTES, JsonBodyLimitMiddleware
from practiq_ai.webapp import app


@pytest.mark.parametrize('suffix', ['', '/control', '/reparse'])
@pytest.mark.parametrize('content_length', [None, DEFAULT_JSON_BODY_BYTES + 1, 1])
@pytest.mark.parametrize('authenticated', [False, True])
async def test_task_mutations_reject_large_headers_or_unauthenticated_streams_before_reading(
    monkeypatch, suffix, content_length, authenticated,
):
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'test-token')
    reads = []

    async def chunks():
        for chunk in (b'x' * DEFAULT_JSON_BODY_BYTES, b'x'):
            reads.append(len(chunk))
            yield chunk
        pytest.fail('Oversized request consumed content beyond the limit')

    path = '/api/document-tasks' + (f'/{uuid4()}{suffix}' if suffix else '')
    headers = {'Content-Type': 'application/json'}
    if content_length is not None:
        headers['Content-Length'] = str(content_length)
    if authenticated:
        headers['Authorization'] = 'Bearer test-token'
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        response = await client.post(path, content=chunks(), headers=headers)

    oversized_header = content_length == DEFAULT_JSON_BODY_BYTES + 1
    if authenticated or oversized_header:
        assert response.status_code == 413
        assert response.json()['detail']['code'] == 'REQUEST_TOO_LARGE'
    else:
        assert response.status_code == 401
        assert response.json()['detail']['code'] == 'INVALID_SERVICE_TOKEN'
    assert reads == ([DEFAULT_JSON_BODY_BYTES, 1] if authenticated and not oversized_header else [])


@pytest.mark.parametrize('streamed', [False, True])
@pytest.mark.parametrize('authenticated', [False, True])
async def test_reparse_accepts_limit_sized_json_only_with_auth(monkeypatch, streamed, authenticated):
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'test-token')
    thread_id, request_id = str(uuid4()), str(uuid4())
    receipt = {'threadId': thread_id, 'requestId': request_id, 'runId': str(uuid4()), 'accepted': True}
    reparse = AsyncMock(return_value=receipt)
    monkeypatch.setattr(task_api, 'reparse_task', reparse)
    body = f'{{"requestId":"{request_id}"}}'.encode().ljust(DEFAULT_JSON_BODY_BYTES)

    async def chunks():
        yield body[:100]
        yield body[100:]

    headers = {'Content-Type': 'application/json'}
    if authenticated:
        headers['Authorization'] = 'Bearer test-token'
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        response = await client.post(f'/api/document-tasks/{thread_id}/reparse',
                                     content=chunks() if streamed else body, headers=headers)

    if authenticated:
        assert response.status_code == 202
        assert response.json() == receipt
        reparse.assert_awaited_once()
        assert reparse.call_args.args[0] == thread_id
        assert str(reparse.call_args.args[1].requestId) == request_id
    else:
        assert response.status_code == 401
        reparse.assert_not_awaited()


@pytest.mark.parametrize('outcome', ['timeout', 'cancel', 'disconnect', 'too_large', 'complete'])
async def test_json_reception_bounds_capacity_and_releases_it_on_every_exit(monkeypatch, outcome):
    settings = replace(load(), upload_concurrency=1, upload_timeout_seconds=0.03 if outcome == 'timeout' else 5)
    monkeypatch.setattr('practiq_ai.middleware.load', lambda: settings)
    entered, release, downstream = asyncio.Event(), asyncio.Event(), asyncio.Event()
    messages = []
    scope = {'type': 'http', 'method': 'POST', 'path': '/api/subjective-grades',
             'headers': [(b'authorization', b'Bearer test-token')]}

    async def receive():
        entered.set()
        await release.wait()
        if outcome == 'disconnect':
            return {'type': 'http.disconnect'}
        return {'type': 'http.request', 'body': b'12345' if outcome == 'too_large' else b'{}', 'more_body': False}

    async def handler(scope, receive, send):
        body = await receive()
        assert body['body'] == b'{}'
        downstream.set()

    async def send(message):
        messages.append(message)

    middleware = JsonBodyLimitMiddleware(handler, maximum=4)
    # Use the ordinary JSON route to exercise the small byte limit too.
    scope['path'] = '/api/document-tasks'
    task = asyncio.create_task(middleware(scope, receive, send))
    try:
        await entered.wait()
        rejected_read = AsyncMock()
        await middleware(scope, rejected_read, send)
        rejected_read.assert_not_awaited()
        assert messages[0]['status'] == 429
        assert (b'retry-after', b'1') in messages[0]['headers']
        messages.clear()
        if outcome == 'cancel':
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            if outcome != 'timeout':
                release.set()
            await asyncio.wait_for(task, 1)
        assert middleware.receiving[asyncio.get_running_loop()] == 0
        assert downstream.is_set() == (outcome == 'complete')
        if outcome in {'timeout', 'too_large', 'disconnect'}:
            status, code = {'timeout': (408, 'REQUEST_BODY_TIMEOUT'),
                            'too_large': (413, 'REQUEST_TOO_LARGE'),
                            'disconnect': (400, 'REQUEST_BODY_DISCONNECTED')}[outcome]
            assert messages[0]['status'] == status
            assert json.loads(messages[1]['body'])['detail']['code'] == code
        # A failed/disconnected request must not consume the next request's slot.
        await middleware(scope, AsyncMock(return_value={'type': 'http.request', 'body': b'{}'}), send)
        assert downstream.is_set()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize('partial_body', [False, True])
@pytest.mark.parametrize('spec_version', ['2.3', '2.4'])
async def test_body_disconnect_completes_response_through_the_real_middleware_stack(monkeypatch, partial_body, spec_version):
    create = AsyncMock()
    monkeypatch.setattr(task_api, 'create_task', create)
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'test-token')
    scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': spec_version},
             'http_version': '1.1', 'scheme': 'http', 'method': 'POST',
             'path': '/api/document-tasks', 'root_path': '', 'query_string': b'',
             'server': ('test', 80), 'client': ('127.0.0.1', 1234),
             'headers': [(b'authorization', b'Bearer test-token'), (b'content-type', b'application/json')]}
    messages = []
    incoming = [{'type': 'http.request', 'body': b'{', 'more_body': True}] if partial_body else []
    incoming.append({'type': 'http.disconnect'})

    async def receive():
        if incoming:
            return incoming.pop(0)
        await asyncio.Event().wait()
        return {'type': 'http.disconnect'}

    async def send(message):
        messages.append(message)

    await asyncio.wait_for(app(scope, receive, send), 1)
    start = next(message for message in messages if message['type'] == 'http.response.start')
    assert start['status'] == 400
    assert (b'x-content-type-options', b'nosniff') in start['headers']
    body = b''.join(message.get('body', b'') for message in messages if message['type'] == 'http.response.body')
    assert json.loads(body)['detail']['code'] == 'REQUEST_BODY_DISCONNECTED'
    assert messages[-1]['type'] == 'http.response.body' and not messages[-1].get('more_body', False)
    create.assert_not_awaited()


async def test_completed_body_does_not_hold_reception_capacity_during_downstream_work(monkeypatch):
    monkeypatch.setattr('practiq_ai.middleware.load', lambda: replace(load(), upload_concurrency=1))
    entered, release = asyncio.Event(), asyncio.Event()

    async def handler(scope, receive, send):
        await receive()
        entered.set()
        await release.wait()

    middleware = JsonBodyLimitMiddleware(handler)
    scope = {'type': 'http', 'method': 'POST', 'path': '/api/subjective-grades',
             'headers': [(b'authorization', b'Bearer test-token')]}
    task = asyncio.create_task(middleware(scope, AsyncMock(return_value={'type': 'http.request', 'body': b'{}'}), AsyncMock()))
    try:
        await entered.wait()
        assert not task.done()
        assert middleware.receiving[asyncio.get_running_loop()] == 0
    finally:
        release.set()
        await task
