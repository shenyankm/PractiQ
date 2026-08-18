"""Public bank clone tests with fake pools (no database required)."""

from datetime import datetime, timedelta, timezone

import pytest

from server import envelope
from server.auth.runtime import User
from server.services import banks as b
from tests.fakes import FakeCursor, FakePool

TS = datetime(2026, 8, 11, 3, 30, 2, 558000, tzinfo=timezone.utc)


def _user(membership: str = 'pro') -> User:
    return User(id=1, username='u', email=None, is_active=True, role='user', membership=membership)


def _membership(membership: str, trial=None):
    return ('SELECT membership, trial_ends_at FROM users', FakeCursor([(membership, trial)]))


def _source_bank(name: str = 'Bank', is_public: bool = True):
    return (
        'SELECT name, description, subject, total_count, is_public',
        FakeCursor([(name, 'desc', 'math', 3, is_public)]),
    )


def _created_bank_row(bank_id: int = 2, name: str = 'Bank（副本）') -> tuple:
    return (bank_id, name, 'desc', 'math', 3, 1, False, TS, TS)


def _group_row(group_id: int, parent_id=None, level: int = 1) -> tuple:
    return (
        group_id, 'book', 'math', 'gt-1', parent_id, level, 'p', 'ref', 'Chapter', 1,
        'Title', 'inst', 'src', 'text_only', '{}',
    )


def _find(pool: FakePool, needle: str):
    return [(sql, params) for sql, params in pool.record if needle in sql]


async def test_clone_free_user_rejected():
    for trial in (None, TS - timedelta(days=1)):
        pool = FakePool([_membership('free', trial)])
        with pytest.raises(envelope.APIError) as exc_info:
            await b.clone_public_bank(pool, _user('free'), 1)
        assert exc_info.value.status == 403
        assert exc_info.value.code == 'PRO_REQUIRED'
        assert not _find(pool, 'INSERT INTO question_banks')


async def test_clone_public_bank_success():
    pool = FakePool([
        _membership('pro'),
        _source_bank(),
        ('INSERT INTO question_banks', FakeCursor([_created_bank_row()])),
        ('FROM bank_group_links bgl', FakeCursor([_group_row(9), _group_row(10, parent_id=9, level=2)])),
        ('INSERT INTO question_groups', FakeCursor([(11,)])),
    ])
    created = await b.clone_public_bank(pool, _user('pro'), 1)
    assert created['id'] == 2
    assert created['name'] == 'Bank（副本）'
    assert created['is_public'] is False
    assert created['total_count'] == 3

    bank_inserts = _find(pool, 'INSERT INTO question_banks')
    assert len(bank_inserts) == 1
    assert bank_inserts[0][1] == ('Bank（副本）', 'desc', 'math', 3, 1)

    owner_links = _find(pool, 'INSERT INTO user_bank_links')
    assert len(owner_links) == 1
    assert owner_links[0][1] == (1, 2)

    question_copies = _find(pool, 'INSERT INTO bank_question_links')
    assert len(question_copies) == 1
    assert question_copies[0][1] == (2, 1, 1)

    group_inserts = _find(pool, 'INSERT INTO question_groups')
    assert len(group_inserts) == 2
    # parent copied first with NULL parent; child's parent remapped to the new parent id
    assert group_inserts[0][1][3] is None
    assert group_inserts[1][1][3] == 11

    group_links = _find(pool, 'INSERT INTO bank_group_links')
    assert [params for _, params in group_links] == [(2, 11, 1, 1, 9), (2, 11, 1, 1, 10)]

    group_questions = _find(pool, 'INSERT INTO group_question_links')
    assert [params for _, params in group_questions] == [(11, 9), (11, 10)]


async def test_clone_private_bank_not_found():
    pool = FakePool([_membership('pro'), _source_bank(is_public=False)])
    with pytest.raises(envelope.APIError) as exc_info:
        await b.clone_public_bank(pool, _user('pro'), 1)
    assert exc_info.value.status == 404
    assert exc_info.value.code == 'BANK_NOT_FOUND'
    assert not _find(pool, 'INSERT INTO question_banks')
    # a missing bank behaves the same
    pool2 = FakePool([
        _membership('pro'),
        ('SELECT name, description, subject, total_count, is_public', FakeCursor([])),
    ])
    with pytest.raises(envelope.APIError) as exc_info2:
        await b.clone_public_bank(pool2, _user('pro'), 1)
    assert exc_info2.value.code == 'BANK_NOT_FOUND'


async def test_clone_truncates_long_bank_name():
    pool = FakePool([
        _membership('pro'),
        _source_bank(name='x' * 100),
        ('INSERT INTO question_banks', FakeCursor([_created_bank_row(name='x' * 96 + '（副本）')])),
        ('FROM bank_group_links bgl', FakeCursor([])),
    ])
    await b.clone_public_bank(pool, _user('pro'), 1)
    params = _find(pool, 'INSERT INTO question_banks')[0][1]
    assert params[0] == 'x' * 96 + '（副本）'
    assert len(params[0]) == 100
