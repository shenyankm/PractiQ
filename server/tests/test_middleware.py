from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

from practiq_ai import task_api
from practiq_ai.middleware import DEFAULT_JSON_BODY_BYTES
from practiq_ai.webapp import app


@pytest.mark.parametrize('suffix', ['', '/control', '/reparse'])
@pytest.mark.parametrize('content_length', [None, DEFAULT_JSON_BODY_BYTES + 1, 1])
@pytest.mark.parametrize('authenticated', [False, True])
async def test_task_mutations_reject_oversized_bodies_before_auth_or_json(
    suffix, content_length, authenticated,
):
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

    assert response.status_code == 413
    assert response.json()['error']['code'] == 'REQUEST_TOO_LARGE'
    assert reads == ([] if content_length == DEFAULT_JSON_BODY_BYTES + 1 else [DEFAULT_JSON_BODY_BYTES, 1])


@pytest.mark.parametrize('streamed', [False, True])
@pytest.mark.parametrize('authenticated', [False, True])
async def test_reparse_accepts_limit_sized_json_only_with_auth(monkeypatch, streamed, authenticated):
    thread_id, request_id = str(uuid4()), str(uuid4())
    reparse = AsyncMock(return_value={'threadId': thread_id})
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
        assert response.json() == {'threadId': thread_id}
        reparse.assert_awaited_once()
        assert reparse.call_args.args[0] == thread_id
        assert str(reparse.call_args.args[1].requestId) == request_id
    else:
        assert response.status_code == 401
        reparse.assert_not_awaited()
