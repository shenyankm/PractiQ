"""Route handler tests: content, practice, health, reference, spa.

Handlers are invoked directly with a fake Request; deps + service modules are
patched so no database or real app is needed.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from urllib.parse import urlencode

import fakeredis.aioredis
import pytest
from fastapi import Request
from starlette.responses import JSONResponse

from server import envelope, redisx
from server.auth.runtime import User
from server.routes import content, deps, health, practice, reference, spa
from server.services.pagination import Page, PageInfo
from tests.fakes import FakeConn, FakeCursor, FakePool


def _user() -> User:
    return User(id=1, username='u', email=None, is_active=True, role='user', membership='free')


def _request(body: bytes = b'', path: str = '/api/v1/x', query: dict | None = None, headers=None) -> Request:
    scope = {
        'type': 'http', 'method': 'POST', 'path': path,
        'headers': [(b'content-type', b'application/json')] + list(headers or []),
        'query_string': urlencode(query or {}).encode(),
        'client': ('127.0.0.1', 1),
    }
    request = Request(scope)
    request._body = body
    request.state.request_id = 'rid-1'
    return request


def _json_request(payload: dict, **kwargs) -> Request:
    return _request(body=json.dumps(payload).encode(), **kwargs)


def _page(items=None) -> Page:
    return Page(items=items or [{'id': 1}], page_info=PageInfo('', 10, False))


def _patch_deps(monkeypatch, pool=None):
    async def current_user(_request):
        return _user()

    monkeypatch.setattr(deps, 'current_user', current_user)
    monkeypatch.setattr(deps, 'pool', lambda _request: pool if pool is not None else FakePool())


def _assert_api_error(exc_info, code: str):
    assert exc_info.value.code == code


# ------------------------------------------------------------------ content


async def test_list_banks_route(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(content.banks_svc, 'list_banks', _async(_page()))
    response = await content.list_banks(_request(query={'scope': 'all'}))
    assert response.status_code == 200
    assert json.loads(response.body)['data'] == [{'id': 1}]


async def test_create_bank_route(monkeypatch):
    _patch_deps(monkeypatch)
    captured = []
    monkeypatch.setattr(content.banks_svc, 'create_bank', _async({'id': 1}, captured))
    response = await content.create_bank(_json_request({'name': 'B', 'subject': 'math', 'description': 'd', 'isPublic': True}))
    assert response.status_code == 201
    assert captured[0][2] == 'B'
    with pytest.raises(envelope.APIError) as exc_info:
        await content.create_bank(_json_request({'name': '', 'subject': ''}))
    _assert_api_error(exc_info, 'VALIDATION_ERROR')


async def test_get_update_delete_bank_routes(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(content.banks_svc, 'get_bank', _async({'id': 1}))
    assert (await content.get_bank(_request(), '1')).status_code == 200
    monkeypatch.setattr(content.banks_svc, 'update_bank', _async({'id': 1}))
    response = await content.update_bank(_json_request({'name': 'New'}), '1')
    assert response.status_code == 200
    monkeypatch.setattr(content.banks_svc, 'delete_bank', _async(None))
    assert (await content.delete_bank(_request(), '1')).status_code == 204
    with pytest.raises(envelope.APIError):
        await content.get_bank(_request(), 'abc')


async def test_bank_items_routes(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(content.banks_svc, 'list_bank_items', _async(_page()))
    response = await content.bank_items(_request(query={'includeAnswers': 'true'}), '1')
    assert response.status_code == 200
    monkeypatch.setattr(content.banks_svc, 'reorder_bank_items', _async(None))
    body = {'items': [
        {'questionId': 1, 'sortOrder': 1},
        {'groupId': 2, 'sortOrder': 2},
    ]}
    assert (await content.bank_items_reorder(_json_request(body), '1')).status_code == 204
    with pytest.raises(envelope.APIError):
        await content.bank_items_reorder(_json_request({'items': []}), '1')
    with pytest.raises(envelope.APIError):
        await content.bank_items_reorder(_json_request({'items': ['x']}), '1')
    with pytest.raises(envelope.APIError):
        await content.bank_items_reorder(_json_request({'items': [{'questionId': 1, 'groupId': 2, 'sortOrder': 1}]}), '1')
    with pytest.raises(envelope.APIError):
        await content.bank_items_reorder(_json_request({'items': [{'questionId': 1, 'sortOrder': 1}, {'questionId': 1, 'sortOrder': 2}]}), '1')
    with pytest.raises(envelope.APIError):
        await content.bank_items_reorder(_json_request({'items': [{'questionId': 1, 'sortOrder': 1}, {'questionId': 3, 'sortOrder': 1}]}), '1')


async def test_bank_favorite_routes(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(content.banks_svc, 'set_favorite', _async(None))
    assert (await content.bank_favorite_create(_request(), '1')).status_code == 204
    assert (await content.bank_favorite_delete(_request(), '1')).status_code == 204


async def test_bank_question_create_route(monkeypatch):
    _patch_deps(monkeypatch)
    captured = []
    monkeypatch.setattr(content.questions_svc, 'create_question', _async({'id': 7}, captured))
    body = {'questionTypeId': 't', 'answerMode': 'choice', 'stem': 'S', 'status': 'draft',
            'options': [{'label': 'A', 'content': 'x', 'isCorrect': True}]}
    response = await content.bank_question_create(_json_request(body), '1')
    assert response.status_code == 201
    assert captured[0][3].options[0].label == 'A'
    with pytest.raises(envelope.APIError):
        await content.bank_question_create(_json_request({**body, 'options': ['bad']}), '1')


async def test_bank_groups_routes(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(content.groups_svc, 'list_bank_groups', _async(_page()))
    assert (await content.bank_groups(_request(), '1')).status_code == 200
    monkeypatch.setattr(content.groups_svc, 'create_group', _async({'id': 9}))
    assert (await content.bank_group_create(_json_request({'title': 'G'}), '1')).status_code == 201
    with pytest.raises(envelope.APIError):
        await content.bank_group_create(_json_request({'title': '  '}), '1')


async def test_question_routes(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(content.questions_svc, 'get_question', _async({'id': 7}))
    assert (await content.question_get(_request(), '7')).status_code == 200
    monkeypatch.setattr(content.questions_svc, 'update_question', _async({'id': 7}))
    assert (await content.question_update(_json_request({'stem': 'S'}), '7')).status_code == 200
    monkeypatch.setattr(content.questions_svc, 'delete_question', _async(None))
    assert (await content.question_delete(_request(), '7')).status_code == 204
    monkeypatch.setattr(content.questions_svc, 'set_question_status', _async({'id': 7}))
    assert (await content.question_publish(_request(), '7')).status_code == 200
    assert (await content.question_archive(_request(), '7')).status_code == 200


async def test_question_option_routes(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(content.questions_svc, 'create_option', _async({'id': 5}))
    assert (await content.question_option_create(_json_request({'label': 'A', 'content': 'x'}), '7')).status_code == 201
    with pytest.raises(envelope.APIError):
        await content.question_option_create(_json_request({'label': '', 'content': ''}), '7')
    monkeypatch.setattr(content.questions_svc, 'update_option', _async({'id': 5}))
    assert (await content.question_option_update(_json_request({'label': 'B'}), '7', '5')).status_code == 200
    monkeypatch.setattr(content.questions_svc, 'delete_option', _async(None))
    assert (await content.question_option_delete(_request(), '7', '5')).status_code == 204


async def test_question_answer_key_and_content_blocks_routes(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(content.questions_svc, 'upsert_answer_key', _async({'id': 1}))
    response = await content.question_answer_key_put(
        _json_request({'answerMode': 'choice', 'answerPayload': {'selected': ['A']}}), '7'
    )
    assert response.status_code == 200
    with pytest.raises(envelope.APIError):
        await content.question_answer_key_put(_json_request({'answerMode': '  '}), '7')
    monkeypatch.setattr(content.questions_svc, 'replace_question_content_blocks', _async(None))
    body = {'blocks': [{'partType': 'text', 'textValue': 'body'}, {'partType': 'image', 'mediaId': 3}]}
    assert (await content.question_content_blocks_put(_json_request(body), '7')).status_code == 204
    with pytest.raises(envelope.APIError):
        await content.question_content_blocks_put(_json_request({'blocks': 'bad'}), '7')
    with pytest.raises(envelope.APIError):
        await content.question_content_blocks_put(_json_request({'blocks': [{'partType': ''}]}), '7')


async def test_group_routes(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(content.groups_svc, 'get_group', _async({'id': 9}))
    assert (await content.group_get(_request(), '9')).status_code == 200
    monkeypatch.setattr(content.groups_svc, 'update_group', _async({'id': 9}))
    assert (await content.group_update(_json_request({'title': 'T'}), '9')).status_code == 200
    monkeypatch.setattr(content.groups_svc, 'delete_group', _async(None))
    assert (await content.group_delete(_request(), '9')).status_code == 204
    monkeypatch.setattr(content.groups_svc, 'set_group_status', _async({'id': 9}))
    assert (await content.group_publish(_request(), '9')).status_code == 200
    assert (await content.group_archive(_request(), '9')).status_code == 200
    monkeypatch.setattr(content.groups_svc, 'add_question_to_group', _async({'id': 1}))
    assert (await content.group_question_create(_json_request({'questionId': 7}), '9')).status_code == 201
    with pytest.raises(envelope.APIError):
        await content.group_question_create(_json_request({'questionId': 0}), '9')
    monkeypatch.setattr(content.groups_svc, 'reorder_group_questions', _async(None))
    body = {'items': [{'questionId': 7, 'sortOrder': 1}]}
    assert (await content.group_questions_reorder(_json_request(body), '9')).status_code == 204
    with pytest.raises(envelope.APIError):
        await content.group_questions_reorder(_json_request({'items': []}), '9')
    with pytest.raises(envelope.APIError):
        await content.group_questions_reorder(_json_request({'items': [{'questionId': 0, 'sortOrder': 1}]}), '9')
    monkeypatch.setattr(content.groups_svc, 'remove_question_from_group', _async(None))
    assert (await content.group_question_delete(_request(), '9', '7')).status_code == 204


# ---------------------------------------------------------------- practice


async def test_list_sessions_route(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(practice.practice_svc, 'list_practice_sessions', _async(_page()))
    response = await practice.list_sessions(_request(query={'status': 'active'}))
    assert response.status_code == 200


async def test_start_session_route(monkeypatch):
    _patch_deps(monkeypatch)
    captured = []
    monkeypatch.setattr(practice.practice_svc, 'start_practice_session', _async({'id': 5}, captured))
    response = await practice.start_session(_json_request({'bankId': 1, 'questionCount': 10, 'mode': 'all'}))
    assert response.status_code == 201
    assert captured[0][2].bank_id == 1
    with pytest.raises(envelope.APIError) as exc_info:
        await practice.start_session(_json_request({'bankId': 0, 'mode': 'bogus', 'sessionType': 'bad'}))
    _assert_api_error(exc_info, 'VALIDATION_ERROR')
    with pytest.raises(envelope.APIError):
        await practice.start_session(_json_request({'bankId': 1, 'questionCount': 9999}))
    with pytest.raises(envelope.APIError):
        await practice.start_session(_json_request({'bankId': 1, 'questionTypeId': 'x' * 65}))


async def test_get_session_and_pages_routes(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(practice.practice_svc, 'get_practice_session', _async({'id': 5}))
    assert (await practice.get_session(_request(), '5')).status_code == 200
    monkeypatch.setattr(practice.practice_svc, 'get_practice_question_page', _async({'question': None}))
    assert (await practice.question_page(_request(query={'index': '2'}), '5')).status_code == 200
    assert (await practice.question_page(_request(query={'index': 'x'}), '5')).status_code == 200
    monkeypatch.setattr(practice.practice_svc, 'get_practice_questions', _async([]))
    assert (await practice.session_questions(_request(), '5')).status_code == 200
    monkeypatch.setattr(practice.practice_svc, 'get_practice_results', _async([]))
    assert (await practice.session_results(_request(), '5')).status_code == 200


async def test_submit_answer_route(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(practice.practice_svc, 'submit_answer', _async({'id': 11}))
    body = {'questionId': 7, 'answerPayload': {'selected': ['A']}, 'durationMs': 100}
    assert (await practice.submit_answer(_json_request(body), '5')).status_code == 201
    with pytest.raises(envelope.APIError):
        await practice.submit_answer(_json_request({'questionId': 0}), '5')
    with pytest.raises(envelope.APIError):
        await practice.submit_answer(_json_request({'questionId': 7}), '5')
    with pytest.raises(envelope.APIError):
        await practice.submit_answer(_json_request({'questionId': 7, 'answerPayload': {}, 'durationMs': -1}), '5')


async def test_complete_and_abandon_routes(monkeypatch):
    _patch_deps(monkeypatch)
    captured = []
    monkeypatch.setattr(practice.practice_svc, 'complete_practice_session', _async({'id': 5}, captured))
    assert (await practice.complete_session(_request(), '5')).status_code == 200
    assert captured[0][3] == 'completed'
    assert (await practice.abandon_session(_request(), '5')).status_code == 200
    assert captured[1][3] == 'abandoned'


async def test_offline_practice_route(monkeypatch):
    _patch_deps(monkeypatch)
    fake = fakeredis.aioredis.FakeRedis()
    monkeypatch.setattr(redisx, '_client', fake)
    monkeypatch.setattr(redisx, '_client_url', 'redis://fake')
    monkeypatch.setenv('REDIS_URL', 'redis://fake')
    session_states = [{'id': 5, 'status': 'active'}, {'id': 5, 'status': 'completed'}, {'id': 5, 'status': 'completed'}]
    monkeypatch.setattr(practice.practice_svc, 'get_practice_session', _async_stateful(session_states))
    monkeypatch.setattr(practice.practice_svc, 'start_practice_session', _async({'id': 5}))
    monkeypatch.setattr(practice.practice_svc, 'submit_answer', _async({'id': 11}))
    completed = []
    monkeypatch.setattr(practice.practice_svc, 'complete_practice_session',
                        _async({'id': 5, 'status': 'completed'}, completed))
    body = {'bankId': 1, 'answers': [{'questionId': 7, 'answerPayload': {'selected': ['A']}}]}
    headers = [(b'idempotency-key', b'key-1')]
    response = await practice.offline_practice(_json_request(body, headers=headers))
    assert response.status_code == 200
    assert len(completed) == 1  # active session was completed
    # replay with the same idempotency key: session already completed, no re-complete
    completed.clear()
    response2 = await practice.offline_practice(_json_request(body, headers=headers))
    assert response2.status_code == 200
    assert len(completed) == 0
    # validation branches
    with pytest.raises(envelope.APIError):
        await practice.offline_practice(_json_request({'bankId': 0, 'answers': []}))
    with pytest.raises(envelope.APIError):
        await practice.offline_practice(_json_request({'bankId': 1, 'answers': ['bad']}))
    with pytest.raises(envelope.APIError):
        await practice.offline_practice(_json_request({'bankId': 1, 'answers': [{'questionId': 0}]}))
    with pytest.raises(envelope.APIError):
        await practice.offline_practice(_json_request({'bankId': 1, 'answers': [{'questionId': 1}, {'questionId': 1}]}))
    with pytest.raises(envelope.APIError) as exc_info:
        await practice.offline_practice(_json_request({'bankId': 1, 'answers': [{'questionId': 1}]}))
    assert exc_info.value.code == 'VALIDATION_ERROR'  # missing idempotency key
    redisx._reset()


async def test_offline_practice_without_redis(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.delenv('REDIS_URL', raising=False)
    redisx._reset()
    body = {'bankId': 1, 'answers': [{'questionId': 1}]}
    with pytest.raises(envelope.APIError) as exc_info:
        await practice.offline_practice(_json_request(body, headers=[(b'idempotency-key', b'k')]))
    assert exc_info.value.code == 'IDEMPOTENCY_UNAVAILABLE'


async def test_analytics_routes(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(practice.analytics_svc, 'get_analytics_summary', _async({'accuracy': 50}))
    assert (await practice.analytics_summary(_request())).status_code == 200
    monkeypatch.setattr(practice.analytics_svc, 'get_user_stats_snapshot', _async({'summary': {}}))
    assert (await practice.analytics_snapshot(_request())).status_code == 200
    monkeypatch.setattr(practice.analytics_svc, 'get_bank_analytics', _async({'completed_count': 1}))
    assert (await practice.analytics_bank(_request(), '1')).status_code == 200
    monkeypatch.setattr(practice.analytics_svc, 'get_bank_leaderboard', _async([]))
    assert (await practice.analytics_leaderboard(_request(query={'limit': '5'}), '1')).status_code == 200
    assert (await practice.analytics_leaderboard(_request(query={'limit': 'x'}), '1')).status_code == 200
    monkeypatch.setattr(practice.analytics_svc, 'get_import_analytics', _async({'id': 99}))
    assert (await practice.analytics_import(_request(), '99')).status_code == 200


async def test_search_kind_route(monkeypatch):
    _patch_deps(monkeypatch)
    async def fake_search(conn_arg, user, **kwargs):
        return _page()

    monkeypatch.setattr(practice.search_svc, 'search_questions', fake_search)
    response = await practice.search_kind(_request(query={'q': 'x'}), 'questions')
    assert response.status_code == 200
    with pytest.raises(envelope.APIError):
        await practice.search_kind(_request(), 'banks')


# ------------------------------------------------------------------ health


def _health_request() -> Request:
    request = _request(path='/api/health')
    request.scope['app'] = SimpleNamespace(state=SimpleNamespace(pool=object(), started_at=1000.0))
    return request


async def test_readiness_ok(monkeypatch):
    monkeypatch.setattr(health.db_mod, 'check_postgres', _async(None))
    monkeypatch.setattr(health.redisx, 'check_redis', _async((True, None)))
    data = await health._readiness_data(_health_request())
    assert data['ok'] is True
    assert data['uptimeSeconds'] >= 0


async def test_readiness_degraded(monkeypatch):
    async def boom(_pool):
        raise RuntimeError('db down')

    monkeypatch.setattr(health.db_mod, 'check_postgres', boom)
    monkeypatch.setattr(health.redisx, 'check_redis', _async((False, ValueError('no redis'))))
    data = await health._readiness_data(_health_request())
    assert data['ok'] is False
    assert data['services']['postgres']['ok'] is False
    assert data['services']['redis']['configured'] is False


async def test_health_routes(monkeypatch):
    monkeypatch.setattr(health, '_readiness_data', _async({'ok': True}))
    assert (await health.health(_health_request())).status_code == 200
    monkeypatch.setattr(health, '_readiness_data', _async({'ok': True}))
    assert (await health.health_ready(_health_request())).status_code == 200
    monkeypatch.setattr(health, '_readiness_data', _async({'ok': False}))
    assert (await health.health_ready(_health_request())).status_code == 503
    assert (await health.health_live(_health_request())).status_code == 200


# --------------------------------------------------------------- reference


async def test_subjects_route(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(reference.reference_svc, 'list_subjects', _async([{'subject_id': 'math'}]))
    response = await reference.subjects(_request())
    assert response.status_code == 200
    assert 'Cache-Control' in response.headers


async def test_question_types_route(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(reference.reference_svc, 'list_question_types', _async([]))
    assert (await reference.question_types(_request(query={'subject': 'math'}))).status_code == 200


async def test_knowledge_points_route(monkeypatch):
    _patch_deps(monkeypatch)
    monkeypatch.setattr(reference.reference_svc, 'list_knowledge_points', _async(_page()))
    assert (await reference.knowledge_points(_request(query={'parentId': '3'}))).status_code == 200
    with pytest.raises(envelope.APIError):
        await reference.knowledge_points(_request(query={'parentId': 'x'}), )
    with pytest.raises(envelope.APIError):
        await reference.knowledge_points(_request(query={'parentId': '0'}), )


# -------------------------------------------------------------------- spa


async def test_api_not_found():
    request = _request(path='/api/unknown')
    response = await spa.api_not_found(request, 'unknown')
    assert response.status_code == 404
    assert 'Cache-Control' in response.headers


async def test_serve_spa(tmp_path):
    dist = tmp_path / 'dist'
    dist.mkdir()
    (dist / 'index.html').write_text('<html>index</html>')
    (dist / 'app.js').write_text('js')
    request = _request(path='/')
    request.scope['app'] = SimpleNamespace(state=SimpleNamespace(dist_dir=dist))
    response = await spa.serve_spa(request, '')
    assert response.status_code == 200
    response2 = await spa.serve_spa(request, 'app.js')
    assert response2.status_code == 200
    # path traversal falls back to index
    response3 = await spa.serve_spa(request, '../secret')
    assert response3.status_code == 200


# ------------------------------------------------------------------ helper


def _async(value, sink=None):
    async def _fn(*args, **kwargs):
        if sink is not None:
            sink.append(args)
        return value

    return _fn


def _async_stateful(values):
    async def _fn(*_args, **_kwargs):
        return values.pop(0)

    return _fn
