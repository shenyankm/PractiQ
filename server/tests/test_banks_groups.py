"""Bank + group service tests with fake pools (no database required)."""

from datetime import datetime, timezone

import pytest

from server import envelope
from server.auth.runtime import User
from server.services import banks as b
from server.services import groups as g
from tests.fakes import FakeConn, FakeCursor, FakePool

TS = datetime(2026, 8, 11, 3, 30, 2, 558000, tzinfo=timezone.utc)


def _user() -> User:
    return User(id=1, username='u', email=None, is_active=True, role='user', membership='free')


def _bank_row(bank_id: int = 1) -> tuple:
    return (bank_id, 'Bank', 'desc', 'math', 3, 1, False, TS, TS)


def _bank_row_with_flags(bank_id: int = 1) -> tuple:
    return _bank_row(bank_id) + (True, False)


# ------------------------------------------------------------------- banks


def test_scan_bank_and_flags():
    assert b._scan_bank(_bank_row())['name'] == 'Bank'
    flagged = b._scan_bank_with_flags(_bank_row_with_flags())
    assert flagged['is_owner'] is True
    assert flagged['is_favorite'] is False


def test_normalize_bank_scope():
    assert b._normalize_bank_scope('public') == 'public'
    assert b._normalize_bank_scope('favorites') == 'favorites'
    assert b._normalize_bank_scope('all') == 'all'
    assert b._normalize_bank_scope('') == 'mine'
    assert b._normalize_bank_scope(' mine ') == 'mine'
    with pytest.raises(envelope.APIError):
        b._normalize_bank_scope('bogus')


async def test_list_banks_page_and_filters():
    pool = FakePool([('FROM question_banks b', FakeCursor([_bank_row_with_flags()]))])
    page = await b.list_banks(pool, _user(), b.ListBanksParams(scope='all', subject='math', query='ba', limit=5))
    assert page.items[0]['is_owner'] is True
    assert page.page_info.has_more is False


async def test_get_bank_found_and_missing():
    pool = FakePool([('FROM question_banks b', FakeCursor([_bank_row_with_flags()]))])
    bank = await b.get_bank(pool, _user(), 1)
    assert bank['id'] == 1
    pool2 = FakePool([('FROM question_banks b', FakeCursor([]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await b.get_bank(pool2, _user(), 1)
    assert exc_info.value.code == 'NOT_FOUND'


async def test_require_bank_owner():
    conn = FakeConn([('SELECT b.id, b.subject', FakeCursor([(1, 'math')]))])
    assert await b.require_bank_owner(conn, _user(), 1) == (1, 'math')
    conn2 = FakeConn([('SELECT b.id, b.subject', FakeCursor([]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await b.require_bank_owner(conn2, _user(), 1)
    assert exc_info.value.code == 'FORBIDDEN'


async def test_create_bank():
    pool = FakePool([('INSERT INTO question_banks', FakeCursor([_bank_row()]))])
    created = await b.create_bank(pool, _user(), '  Bank  ', 'desc', 'math', True)
    assert created['id'] == 1
    executed = ' '.join(sql for sql, _ in pool.record)
    assert 'INSERT INTO user_bank_links' in executed
    assert pool.record[0][1][0] == 'Bank'  # name stripped


async def test_update_bank_validation_and_flow():
    with pytest.raises(envelope.APIError):
        await b.update_bank(None, _user(), 1, None, None, False, None)
    pool = FakePool([
        ('SELECT b.id, b.subject', FakeCursor([(1, 'math')])),
        ('UPDATE question_banks', FakeCursor([_bank_row()])),
    ])
    updated = await b.update_bank(pool, _user(), 1, 'New', None, False, True)
    assert updated['name'] == 'Bank'


async def test_delete_bank():
    pool = FakePool([
        ('SELECT b.id, b.subject', FakeCursor([(1, 'math')])),
        ('DELETE FROM question_banks', FakeCursor()),
    ])
    await b.delete_bank(pool, _user(), 1)


async def test_set_favorite_on_and_off():
    pool = FakePool([
        ('FROM question_banks b', FakeCursor([_bank_row_with_flags()])),
        ('INSERT INTO user_bank_links', FakeCursor()),
    ])
    await b.set_favorite(pool, _user(), 1, True)
    pool2 = FakePool([
        ('FROM question_banks b', FakeCursor([_bank_row_with_flags()])),
        ('DELETE FROM user_bank_links', FakeCursor()),
        ('UPDATE user_bank_links', FakeCursor()),
    ])
    await b.set_favorite(pool2, _user(), 1, False)
    assert len(pool2.record) == 3


async def test_list_bank_items_validation_and_mapping():
    pool = FakePool([
        ('FROM question_banks b', FakeCursor([_bank_row_with_flags()])),
        ('FROM v_bank_question_items item', FakeCursor([
            (1, None, 7, 'question', 1, None, 'Q1', 'active', 'book', 'math',
             'type-a', 'choice', 'single', 'text_only', 'stem', 'analysis', 'active',
             'Group', 'inst', '[{"id":5,"is_correct":true}]'),
        ])),
    ])
    page = await b.list_bank_items(pool, _user(), 1, b.ListBankItemsParams(include_answers=True))
    item = page.items[0]
    assert item['question_id'] == 7
    assert item['options'] == [{'id': 5, 'is_correct': True}]
    with pytest.raises(envelope.APIError):
        await b.list_bank_items(pool, _user(), 1, b.ListBankItemsParams(status='bogus'))


async def test_reorder_bank_items():
    ok_responses = [
        ('SELECT b.id, b.subject', FakeCursor([(1, 'math')])),
        ('COUNT(*) FROM bank_question_links', FakeCursor([(2,)])),
        ('COALESCE(MAX(sort_order), 0) + 1000', FakeCursor([(1002,)])),
        ('UPDATE bank_question_links', FakeCursor(rowcount=1)),
        ('UPDATE bank_group_links', FakeCursor(rowcount=1)),
    ]
    pool = FakePool(ok_responses)
    await b.reorder_bank_items(
        pool, _user(), 1,
        [b.ReorderBankItem(question_id=7, group_id=None, sort_order=1),
         b.ReorderBankItem(question_id=None, group_id=3, sort_order=2)],
    )
    # count mismatch -> validation error
    pool2 = FakePool([
        ('SELECT b.id, b.subject', FakeCursor([(1, 'math')])),
        ('COUNT(*) FROM bank_question_links', FakeCursor([(2,)])),
    ])
    with pytest.raises(envelope.APIError):
        await b.reorder_bank_items(pool2, _user(), 1, [b.ReorderBankItem(question_id=7, group_id=None, sort_order=1)])
    # unknown item -> validation error
    pool3 = FakePool([
        ('SELECT b.id, b.subject', FakeCursor([(1, 'math')])),
        ('COUNT(*) FROM bank_question_links', FakeCursor([(1,)])),
        ('COALESCE(MAX(sort_order), 0) + 1000', FakeCursor([(1001,)])),
        ('UPDATE bank_question_links', FakeCursor(rowcount=0)),
    ])
    with pytest.raises(envelope.APIError):
        await b.reorder_bank_items(pool3, _user(), 1, [b.ReorderBankItem(question_id=7, group_id=None, sort_order=1)])
    # unknown group -> validation error
    pool4 = FakePool([
        ('SELECT b.id, b.subject', FakeCursor([(1, 'math')])),
        ('COUNT(*) FROM bank_question_links', FakeCursor([(1,)])),
        ('COALESCE(MAX(sort_order), 0) + 1000', FakeCursor([(1001,)])),
        ('UPDATE bank_question_links', FakeCursor(rowcount=1)),
        ('UPDATE bank_group_links', FakeCursor(rowcount=0)),
    ])
    with pytest.raises(envelope.APIError):
        await b.reorder_bank_items(pool4, _user(), 1, [b.ReorderBankItem(question_id=None, group_id=3, sort_order=1)])


# ------------------------------------------------------------------ groups


def _group_row(group_id: int = 9) -> tuple:
    return (
        group_id, 'book', 'math', 'gt-1', None, 1, 'p', 'ref', 'Chapter', 1,
        'Title', 'inst', 'src', 'text_only', '{}', 1, TS, TS, None,
    )


async def _editable_ok(*_a, **_k):
    return None


def test_validate_group_content_mode():
    assert g._validate_group_content_mode(None) is None
    assert g._validate_group_content_mode('mixed_media') is None
    assert g._validate_group_content_mode('bogus').field == 'contentMode'


async def test_ensure_group_editable():
    pool = FakePool([('SELECT g.id', FakeCursor([(9,)]))])
    await g.ensure_group_editable(pool, _user(), 9)
    pool2 = FakePool([('SELECT g.id', FakeCursor([]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await g.ensure_group_editable(pool2, _user(), 9)
    assert exc_info.value.code == 'FORBIDDEN'


async def test_list_bank_groups(monkeypatch):
    async def fake_get_bank(_pool, _user, _bank_id):
        return {'is_owner': True, 'id': 1}

    monkeypatch.setattr(g, 'get_bank', fake_get_bank)
    pool = FakePool([('FROM bank_group_links bgl', FakeCursor([
        (9, 'gt-1', 'Title', 'inst', 'text_only', 'active', 1, 2),
    ]))])
    page = await g.list_bank_groups(pool, _user(), 1, 30, '')
    item = page.items[0]
    assert item['id'] == 9
    assert item['question_count'] == 2
    assert item['can_edit'] is True


async def test_create_group(monkeypatch):
    async def fake_owner(_conn, _user, bank_id):
        return bank_id, 'math'

    async def fake_resolve(*_args):
        return 'gt-1'

    monkeypatch.setattr(g, 'require_bank_owner', fake_owner)
    monkeypatch.setattr(g.reference, 'resolve_question_type_id_for_subject', fake_resolve)
    with pytest.raises(envelope.APIError):
        await g.create_group(None, _user(), 1, g.CreateGroupInput(title='  '))
    with pytest.raises(envelope.APIError):
        await g.create_group(None, _user(), 1, g.CreateGroupInput(title='T', content_mode='bogus'))
    pool = FakePool([
        ('SELECT id FROM question_banks', FakeCursor()),
        ('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort', FakeCursor([(4,)])),
        ('INSERT INTO question_groups', FakeCursor([_group_row()])),
    ])
    created = await g.create_group(pool, _user(), 1, g.CreateGroupInput(title=' Title ', status='active'))
    assert created['id'] == 9
    executed = ' '.join(sql for sql, _ in pool.record)
    assert 'INSERT INTO bank_group_links' in executed


async def test_get_group_found_and_missing():
    row = _group_row() + (True, '[{"id":7,"stem":"S"}]')
    pool = FakePool([('WITH access AS', FakeCursor([row]))])
    detail = await g.get_group(pool, _user(), 9)
    assert detail['can_edit'] is True
    assert detail['questions'] == [{'id': 7, 'stem': 'S'}]
    pool2 = FakePool([('WITH access AS', FakeCursor([]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await g.get_group(pool2, _user(), 9)
    assert exc_info.value.code == 'NOT_FOUND'


async def test_update_group(monkeypatch):
    monkeypatch.setattr(g, 'ensure_group_editable', _editable_ok)
    with pytest.raises(envelope.APIError):
        await g.update_group(None, _user(), 9, None, None, False, None)
    pool = FakePool([('UPDATE question_groups', FakeCursor([_group_row()]))])
    updated = await g.update_group(pool, _user(), 9, 'New', 'inst', True, 'mixed_media')
    assert updated['id'] == 9


async def test_set_group_status(monkeypatch):
    monkeypatch.setattr(g, 'ensure_group_editable', _editable_ok)
    async def fake_get_group(_pool, _user, _group_id):
        return {'id': 9, 'status': 'active'}

    monkeypatch.setattr(g, 'get_group', fake_get_group)
    # non-active status skips the publishability check
    pool = FakePool([('UPDATE bank_group_links', FakeCursor(rowcount=1))])
    result = await g.set_group_status(pool, _user(), 9, 'archived')
    assert result['id'] == 9
    # active with all questions active
    pool2 = FakePool([
        ('SELECT COUNT(*)::int', FakeCursor([(3, 3)])),
        ('UPDATE bank_group_links', FakeCursor(rowcount=1)),
    ])
    result2 = await g.set_group_status(pool2, _user(), 9, 'active')
    assert result2['id'] == 9
    # active but some questions not active
    pool3 = FakePool([('SELECT COUNT(*)::int', FakeCursor([(3, 2)]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await g.set_group_status(pool3, _user(), 9, 'active')
    assert exc_info.value.code == 'GROUP_NOT_PUBLISHABLE'
    # rowcount 0 -> not found
    pool4 = FakePool([('UPDATE bank_group_links', FakeCursor(rowcount=0))])
    with pytest.raises(envelope.APIError) as exc_info:
        await g.set_group_status(pool4, _user(), 9, 'draft')
    assert exc_info.value.code == 'NOT_FOUND'


async def test_delete_group(monkeypatch):
    monkeypatch.setattr(g, 'ensure_group_editable', _editable_ok)
    pool = FakePool([
        ('WITH owner_banks AS', FakeCursor()),
        ('DELETE FROM bank_group_links', FakeCursor()),
        ('DELETE FROM question_groups g', FakeCursor()),
    ])
    await g.delete_group(pool, _user(), 9)
    assert len(pool.record) == 3


async def test_add_question_to_group(monkeypatch):
    monkeypatch.setattr(g, 'ensure_group_editable', _editable_ok)
    monkeypatch.setattr(g, 'ensure_question_editable', _editable_ok)
    with pytest.raises(envelope.APIError):
        await g.add_question_to_group(None, _user(), 9, 7, 0)
    link_row = (1, 9, 7, 'math', 'math', 1, 'Q1', TS, TS)
    pool = FakePool([
        ('SELECT', FakeCursor([(1, False), (2, True)])),
        ('SELECT COALESCE(MAX(sort_order), 0) + 1', FakeCursor([(2,)])),
        ('INSERT INTO group_question_links', FakeCursor([link_row])),
    ])
    link = await g.add_question_to_group(pool, _user(), 9, 7, None)
    assert link['question_id'] == 7
    executed = ' '.join(sql for sql, _ in pool.record)
    assert 'DELETE FROM bank_question_links' in executed
    assert 'total_count = total_count + 1' in executed  # bank 1 lacked the question


async def test_reorder_group_questions(monkeypatch):
    monkeypatch.setattr(g, 'ensure_group_editable', _editable_ok)
    pool = FakePool([
        ('SELECT COUNT(*) FROM group_question_links', FakeCursor([(2,)])),
        ('SELECT COALESCE(MAX(sort_order), 0) + 1000', FakeCursor([(1002,)])),
        ('UPDATE group_question_links', FakeCursor(rowcount=1)),
    ])
    await g.reorder_group_questions(
        pool, _user(), 9,
        [g.ReorderGroupQuestionItem(question_id=7, sort_order=1),
         g.ReorderGroupQuestionItem(question_id=8, sort_order=2)],
    )
    # count mismatch
    pool2 = FakePool([('SELECT COUNT(*) FROM group_question_links', FakeCursor([(3,)]))])
    with pytest.raises(envelope.APIError):
        await g.reorder_group_questions(pool2, _user(), 9, [g.ReorderGroupQuestionItem(question_id=7, sort_order=1)])
    # unknown question
    pool3 = FakePool([
        ('SELECT COUNT(*) FROM group_question_links', FakeCursor([(1,)])),
        ('SELECT COALESCE(MAX(sort_order), 0) + 1000', FakeCursor([(1001,)])),
        ('UPDATE group_question_links', FakeCursor(rowcount=0)),
    ])
    with pytest.raises(envelope.APIError):
        await g.reorder_group_questions(pool3, _user(), 9, [g.ReorderGroupQuestionItem(question_id=7, sort_order=1)])


async def test_remove_question_from_group(monkeypatch):
    monkeypatch.setattr(g, 'ensure_group_editable', _editable_ok)
    pool = FakePool([
        ('DELETE FROM group_question_links', FakeCursor(rowcount=1)),
        ('INSERT INTO bank_question_links', FakeCursor()),
    ])
    await g.remove_question_from_group(pool, _user(), 9, 7)
    pool2 = FakePool([('DELETE FROM group_question_links', FakeCursor(rowcount=0))])
    with pytest.raises(envelope.APIError) as exc_info:
        await g.remove_question_from_group(pool2, _user(), 9, 7)
    assert exc_info.value.code == 'NOT_FOUND'
