"""helpers + search + reference service tests (no database required)."""

from __future__ import annotations

import pytest
from datetime import datetime, timezone

from server import envelope
from server.auth.runtime import User
from server.services import helpers, reference, search
from tests.fakes import FakeConn, FakeCursor


def _user() -> User:
    return User(id=1, username='u', email='u@example.com', is_active=True, role='user', membership='free')


# ------------------------------------------------------------------ helpers


def test_require_admin_role():
    helpers.require_admin_role(User(id=1, username='a', email=None, is_active=True, role='admin', membership='free'))
    with pytest.raises(envelope.APIError) as exc_info:
        helpers.require_admin_role(_user())
    assert exc_info.value.code == 'ADMIN_REQUIRED'


def test_trimmed_or_none():
    assert helpers.trimmed_or_none(None) is None
    assert helpers.trimmed_or_none('  ') is None
    assert helpers.trimmed_or_none('  x  ') == 'x'


def test_ilike_or_none():
    assert helpers.ilike_or_none(None) is None
    assert helpers.ilike_or_none('   ') is None
    assert helpers.ilike_or_none('term') == '%term%'


async def test_bump_slice_cache_version_unknown_scope(monkeypatch):
    async def boom(*_args):
        raise AssertionError('must not touch redis for unknown scope')

    monkeypatch.setattr('server.redisx.client', boom)
    await helpers.bump_slice_cache_version('bogus', 1)


async def test_bump_slice_cache_version_swallows_redis_errors(monkeypatch):
    class _Boom:
        async def incr(self, *_args):
            raise RuntimeError('redis down')

    monkeypatch.setattr('server.redisx.client', lambda: _Boom())
    await helpers.bump_slice_cache_version('analytics', 1)


def test_format_timestamp():
    value = datetime(2026, 8, 11, 3, 30, 2, 558000, tzinfo=timezone.utc)
    assert helpers.format_timestamp(value) == '2026-08-11T03:30:02.558Z'
    assert helpers.format_nullable_timestamp(None) is None
    assert helpers.format_nullable_timestamp(value) == '2026-08-11T03:30:02.558Z'


def test_json_or_empty_object():
    assert helpers.json_or_empty_object(None) == '{}'
    assert helpers.json_or_empty_object('') == '{}'
    assert helpers.json_or_empty_object({'a': 1}) == '{"a":1}'
    assert helpers.json_or_empty_object(object()) == '{}'


# ----------------------------------------------------------------- search


async def test_search_questions_bank_id_validation():
    conn = FakeConn()
    with pytest.raises(envelope.APIError) as exc_info:
        await search.search_questions(conn, _user(), 'abc', '', '', '', '', '')
    assert exc_info.value.code == 'VALIDATION_ERROR'
    with pytest.raises(envelope.APIError) as exc_info:
        await search.search_questions(conn, _user(), '0', '', '', '', '', '')
    assert exc_info.value.code == 'VALIDATION_ERROR'


async def test_search_questions_status_and_limit_validation():
    conn = FakeConn()
    with pytest.raises(envelope.APIError) as exc_info:
        await search.search_questions(conn, _user(), '', 'type', 'bogus', '', '', '')
    assert exc_info.value.code == 'VALIDATION_ERROR'
    with pytest.raises(envelope.APIError) as exc_info:
        await search.search_questions(conn, _user(), '', '', '', 'x', '', '')
    assert exc_info.value.code == 'VALIDATION_ERROR'
    with pytest.raises(envelope.APIError) as exc_info:
        await search.search_questions(conn, _user(), '', '', '', '200', '', '')
    assert exc_info.value.code == 'VALIDATION_ERROR'


async def test_search_questions_returns_page():
    conn = FakeConn([
        (
            'WITH visible_question_ids',
            FakeCursor([
                (5, 'book', 'math', 'type-a', 'choice', None, 'What is 2+2?', None, 'active', True),
            ]),
        ),
    ])
    page = await search.search_questions(conn, _user(), '3', 'type-a', 'active', '50', '', '2+2')
    assert page.items[0]['id'] == 5
    assert page.items[0]['can_edit'] is True
    assert page.page_info.has_more is False
    assert conn.executed[0][1][1] == 3  # bank_id passed through


# --------------------------------------------------------------- reference


async def test_resolve_question_type_exact_match():
    conn = FakeConn([('SELECT type_id', FakeCursor([('exact-type',)]))])
    result = await reference.resolve_question_type_id_for_subject(conn, 'math', 'exact-type', None, 'question')
    assert result == 'exact-type'


async def test_resolve_question_type_falls_back_and_errors():
    # requested type not found and fallback also empty -> error
    conn = FakeConn([('SELECT type_id', FakeCursor([]))] * 2)
    with pytest.raises(envelope.APIError) as exc_info:
        await reference.resolve_question_type_id_for_subject(conn, 'math', 'missing', 'choice', 'question')
    assert exc_info.value.code == 'INVALID_QUESTION_TYPE'


async def test_resolve_question_type_empty_subject_not_needed():
    # blank requested type also runs the fallback ordering query
    conn = FakeConn([('SELECT type_id', FakeCursor([('fallback-type',)]))])
    result = await reference.resolve_question_type_id_for_subject(conn, 'math', '', None, 'question')
    assert result == 'fallback-type'


async def test_list_subjects():
    conn = FakeConn([('SELECT subject_id', FakeCursor([('math', 'Math'), ('eng', 'English')]))])
    assert await reference.list_subjects(conn) == [
        {'subject_id': 'math', 'display_name': 'Math'},
        {'subject_id': 'eng', 'display_name': 'English'},
    ]


async def test_list_question_types_filters_and_maps():
    conn = FakeConn([
        ('SELECT type_id', FakeCursor([('t1', 'math', 'Choice', 'exam', 'choice')])),
    ])
    assert await reference.list_question_types(conn, 'math', 'exam') == [
        {'type_id': 't1', 'subject_id': 'math', 'display_name': 'Choice', 'scope': 'exam', 'default_answer_mode': 'choice'},
    ]


async def test_list_knowledge_points():
    conn = FakeConn([
        ('SELECT id, subject_id', FakeCursor([
            (1, 'math', 'KP1', 'Point one', None, '{}', datetime(2026, 1, 1, tzinfo=timezone.utc), datetime(2026, 1, 1, tzinfo=timezone.utc)),
        ])),
    ])
    page = await reference.list_knowledge_points(conn, 'math', None, '', '', 0)
    assert page.items[0]['display_name'] == 'Point one'
    assert page.items[0]['parent_id'] is None
