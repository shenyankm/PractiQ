"""Question service tests: pure helpers + fake-pool DB paths (no database required)."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from server import envelope
from server.auth.runtime import User
from server.services import questions as q
from tests.fakes import FakeConn, FakeCursor, FakePool

TS = datetime(2026, 8, 11, 3, 30, 2, 558000, tzinfo=timezone.utc)


def _user() -> User:
    return User(id=1, username='u', email=None, is_active=True, role='user', membership='free')


def _question_row(question_id: int = 7) -> tuple:
    return (
        question_id, 'book', 'math', 'type-a', 'choice', 'single', 2, 'p1.2', 'ref',
        'Chapter 1', 1, 'text_only', 'What is 2+2?', 'analysis text', '{"k":"v"}',
        'active', 'manual', 'src-ref', 3, 1, TS, TS,
    )


def _detail_row(question_id: int = 7) -> tuple:
    return _question_row(question_id) + ('[]', '[]', '[]', '[]', True)


# ------------------------------------------------------------------ scanners


def test_scan_question_maps_all_columns():
    row = _question_row()
    detail = q._scan_question(row)
    assert detail['id'] == 7
    assert detail['subject_id'] == 'math'
    assert detail['created_at'].endswith('Z')
    assert detail['updated_at'].endswith('Z')


def test_decode_json_list_variants():
    assert q._decode_json_list(None) == []
    assert q._decode_json_list('') == []
    assert q._decode_json_list('[1,2]') == [1, 2]
    assert q._decode_json_list([1, 2]) == [1, 2]


def test_learner_question_detail_filters_blocks_and_options():
    detail = {
        'id': 7, 'business_type': 'book', 'subject_id': 'math', 'question_type_id': 'type-a',
        'answer_mode': 'choice', 'choice_variant': 'single', 'content_mode': 'text_only',
        'stem': 'S', 'status': 'active',
        'options': [
            {'id': 1, 'question_id': 7, 'option_label': 'A', 'sort_order': 1, 'content': 'x', 'is_correct': True},
        ],
        'content_blocks': [
            {'owner_kind': 'stem', 'part_type': 'text'},
            {'owner_kind': 'answer_key', 'part_type': 'text'},
        ],
        'media_links': [],
    }
    out = q._learner_question_detail(detail)
    assert out['can_edit'] is False
    assert out['options'][0] == {'id': 1, 'question_id': 7, 'option_label': 'A', 'sort_order': 1, 'content': 'x'}
    assert len(out['content_blocks']) == 1


# ------------------------------------------------------------- validation


def test_validate_create_question_input():
    good = q.CreateQuestionInput(question_type_id='t', answer_mode='choice', stem='S')
    q._validate_create_question_input(good)
    with pytest.raises(envelope.APIError) as exc_info:
        q._validate_create_question_input(
            q.CreateQuestionInput(question_type_id='  ', answer_mode='bogus', stem='  ')
        )
    assert exc_info.value.code == 'VALIDATION_ERROR'
    assert {d['field'] for d in exc_info.value.details} == {'questionTypeId', 'answerMode', 'stem'}
    with pytest.raises(envelope.APIError):
        q._validate_create_question_input(
            q.CreateQuestionInput(question_type_id='t', answer_mode='choice', stem='S', choice_variant='weird')
        )


def test_normalize_question_status_or_default():
    assert q._normalize_question_status_or_default('', 'draft') == 'draft'
    assert q._normalize_question_status_or_default(' active ', 'draft') == 'active'
    assert q._normalize_question_status_or_default('archived', 'draft') == 'archived'
    with pytest.raises(envelope.APIError):
        q._normalize_question_status_or_default('bogus', 'draft')


def test_selected_answer_values():
    assert q.selected_answer_values(None) == []
    assert q.selected_answer_values({'selected': ['A', ' B ']}) == ['A', 'B']
    assert q.selected_answer_values({'correctOption': 'A'}) == ['A']
    assert q.selected_answer_values({'correctOptions': ['A']}) == ['A']
    assert q.selected_answer_values({}) == []


def test_canonical_choice_answer_payload():
    out = q._canonical_choice_answer_payload({'correctOption': 'A', 'extra': 1}, ['B', 'A'])
    assert out == {'extra': 1, 'selected': ['B', 'A']}


def test_question_fill_blank_values():
    assert q._question_fill_blank_values(None) == []
    assert q._question_fill_blank_values({'value': [' Paris ', 'France']}) == ['paris', 'france']
    assert q._question_fill_blank_values({'value': 'Paris'}) == ['paris']
    assert q._question_fill_blank_values({'slots': 'nope'}) == []
    assert q._question_fill_blank_values({'slots': [{'value': ['a', ' b']}, {'answers': 'c'}, 'skip']}) == ['a', 'b', 'c']


def test_has_usable_answer_payload():
    assert q.has_usable_answer_payload('choice', {'selected': ['A']}) is True
    assert q.has_usable_answer_payload('choice', {}) is False
    assert q.has_usable_answer_payload('true_false', {'value': True}) is True
    assert q.has_usable_answer_payload('true_false', {'value': 'yes'}) is False
    assert q.has_usable_answer_payload('fill_blank', {'value': ['']}) is False
    assert q.has_usable_answer_payload('fill_blank', {'value': ['x']}) is True
    assert q.has_usable_answer_payload('short_answer', {'value': '  ans  '}) is True
    assert q.has_usable_answer_payload('short_answer', {'value': ''}) is False
    assert q.has_usable_answer_payload('short_answer', None) is False


def test_validate_question_payload():
    opt = lambda label='A', content='x', correct=False: q.QuestionOptionInput(label, content, correct)  # noqa: E731
    with pytest.raises(envelope.APIError) as exc_info:
        q._validate_question_payload('choice', '', [opt('A', 'x')], {'selected': ['B']})
    assert exc_info.value.code == 'VALIDATION_ERROR'
    with pytest.raises(envelope.APIError):
        q._validate_question_payload('short_answer', '', [opt()], {})
    with pytest.raises(envelope.APIError):
        q._validate_question_payload('choice', '', [opt('', 'x')], {})
    with pytest.raises(envelope.APIError):
        q._validate_question_payload('choice', '', [opt('A', 'x'), opt('A', 'y')], {})
    with pytest.raises(envelope.APIError) as exc_info:
        q._validate_question_payload('choice', 'active', [opt('A', 'x')], {})
    assert exc_info.value.code == 'INVALID_STATE'
    # two options with one correct -> publishable even without payload selection
    q._validate_question_payload('choice', 'active', [opt('A', 'x'), opt('B', 'y', True)], {})
    # valid active choice
    q._validate_question_payload('choice', 'active', [opt('A', 'x', True), opt('B', 'y')], {'selected': ['A']})


def test_validate_question_content_blocks():
    block = q.QuestionContentBlockInput(part_type='text', owner_kind='stem', sequence=1)
    q._validate_question_content_blocks([block])
    with pytest.raises(envelope.APIError) as exc_info:
        q._validate_question_content_blocks([
            q.QuestionContentBlockInput(part_type='bogus', owner_kind='bogus', sequence=0, content_mode='bad', role='r' * 65, text_format='f' * 33, media_id=0),
        ])
    assert exc_info.value.code == 'VALIDATION_ERROR'
    with pytest.raises(envelope.APIError):
        q._validate_question_content_blocks([q.QuestionContentBlockInput(part_type='text')] * 1001)


def test_normalize_json_value():
    assert q._normalize_json_value(None) is None
    assert q._normalize_json_value('raw') == 'raw'
    assert q._normalize_json_value({'a': 1}) == '{"a":1}'


# ------------------------------------------------------- DB-backed paths


async def test_get_question_learner_vs_editor(monkeypatch):
    pool = FakePool([('FROM questions q', FakeCursor([_detail_row()]))])
    user = _user()
    detail = await q.get_question(pool, user, 7)
    assert detail['can_edit'] is True  # row says can_edit
    assert detail['stem'] == 'What is 2+2?'

    pool2 = FakePool([('FROM questions q', FakeCursor([_detail_row()]))])
    async def _editable(*_a, **_k):
        pass
    monkeypatch.setattr(q, 'ensure_question_editable', _editable)
    detail2 = await q.get_question_for_editor(pool2, user, 7)
    assert detail2['can_edit'] is True

    pool3 = FakePool([('FROM questions q', FakeCursor([_detail_row()[:26] + (False,)]))])
    detail3 = await q.get_question(pool3, user, 7)
    assert detail3['can_edit'] is False
    assert 'answer_keys' not in detail3  # learner view strips answer data


async def test_get_question_not_found():
    pool = FakePool([('FROM questions q', FakeCursor([]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await q.get_question(pool, _user(), 7)
    assert exc_info.value.code == 'NOT_FOUND'


async def _editable_ok(*_a, **_k):
    return None


async def test_create_question_full_flow(monkeypatch):
    async def fake_owner(_conn, _user, bank_id):
        return bank_id, 'math'

    async def fake_resolve(_conn, subject, _type_id, _mode, _scope):
        return 'type-a'

    monkeypatch.setattr(q, 'require_bank_owner', fake_owner)
    monkeypatch.setattr(q.reference, 'resolve_question_type_id_for_subject', fake_resolve)

    row = _question_row()
    pool = FakePool([
        ('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort', FakeCursor([(3,)])),
        ('INSERT INTO questions', FakeCursor([row])),
    ])
    created = await q.create_question(
        pool, _user(), 1,
        q.CreateQuestionInput(
            question_type_id='type-a', answer_mode='choice', stem=' S ',
            status='active',
            options=[q.QuestionOptionInput('A', 'one', True), q.QuestionOptionInput('B', 'two', False)],
            answer_payload={'correctOption': 'A'},
        ),
    )
    assert created['id'] == 7
    executed = ' '.join(sql for sql, _ in pool.record)
    assert 'question_answer_keys' in executed
    assert 'question_options' in executed
    assert 'bank_question_links' in executed
    assert 'total_count = total_count + 1' in executed


async def test_create_question_validation_fails_first(monkeypatch):
    async def fake_owner(_conn, _user, bank_id):
        return bank_id, 'math'

    monkeypatch.setattr(q, 'require_bank_owner', fake_owner)
    with pytest.raises(envelope.APIError):
        await q.create_question(pool=None, user=None, bank_id=1, input=q.CreateQuestionInput(
            question_type_id='', answer_mode='', stem=''
        ))


async def test_persist_imported_question(monkeypatch):
    async def fake_owner(_conn, _user, bank_id):
        return bank_id, 'math'

    async def fake_resolve(*_args):
        return 'type-a'

    monkeypatch.setattr(q, 'require_bank_owner', fake_owner)
    monkeypatch.setattr(q.reference, 'resolve_question_type_id_for_subject', fake_resolve)

    row = _question_row()
    pool = FakePool([
        ('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort', FakeCursor([(1,)])),
        ('UPDATE question_import_jobs', FakeCursor([(99,)])),
        ('INSERT INTO questions', FakeCursor([row])),
    ])
    result = await q.persist_imported_question(
        pool, _user(), 1,
        q.PersistImportedQuestionInput(
            job_id=99, claim_version=2,
            question=q.CreateQuestionInput(question_type_id='t', answer_mode='short_answer', stem='S'),
            content_blocks=[q.QuestionContentBlockInput(part_type='text', text_value='body')],
            confidence=0.9, output_metadata={'sourceText': 'src'},
        ),
    )
    assert result['source_type'] == 'imported'
    assert result['source_job_id'] == 99


async def test_persist_imported_question_claim_lost(monkeypatch):
    async def fake_owner(_conn, _user, bank_id):
        return bank_id, 'math'

    async def fake_resolve(*_args):
        return 'type-a'

    monkeypatch.setattr(q, 'require_bank_owner', fake_owner)
    monkeypatch.setattr(q.reference, 'resolve_question_type_id_for_subject', fake_resolve)
    pool = FakePool([
        ('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort', FakeCursor([(1,)])),
        ('UPDATE question_import_jobs', FakeCursor([])),
    ])
    with pytest.raises(q.ClaimLostError):
        await q.persist_imported_question(
            pool, _user(), 1,
            q.PersistImportedQuestionInput(
                job_id=99, claim_version=2,
                question=q.CreateQuestionInput(question_type_id='t', answer_mode='short_answer', stem='S'),
                content_blocks=[], confidence=0.9, output_metadata={},
            ),
        )


async def test_update_question(monkeypatch):
    monkeypatch.setattr(q, 'ensure_question_editable', _editable_ok)
    with pytest.raises(envelope.APIError):
        await q.update_question(None, _user(), 7, None, None, False)
    with pytest.raises(envelope.APIError):
        await q.update_question(None, _user(), 7, '   ', None, False)
    pool = FakePool([('UPDATE questions', FakeCursor([_question_row()]))])
    updated = await q.update_question(pool, _user(), 7, 'New stem', 'New analysis', True)
    assert updated['stem'] == 'What is 2+2?'


async def test_delete_question(monkeypatch):
    monkeypatch.setattr(q, 'ensure_question_editable', _editable_ok)
    pool = FakePool([
        ('SELECT DISTINCT bank_id', FakeCursor([(1,), (2,)])),
        ('DELETE FROM questions', FakeCursor()),
    ])
    await q.delete_question(pool, _user(), 7)
    assert 'total_count' in ' '.join(sql for sql, _ in pool.record)


async def test_set_question_status(monkeypatch):
    monkeypatch.setattr(q, 'ensure_question_editable', _editable_ok)
    async def publishable(*_a, **_k):
        return None
    monkeypatch.setattr(q, '_assert_question_publishable', publishable)
    pool = FakePool([('UPDATE questions', FakeCursor([_question_row()]))])
    updated = await q.set_question_status(pool, _user(), 7, 'active')
    assert updated['status'] == 'active'


async def test_upsert_answer_key(monkeypatch):
    monkeypatch.setattr(q, 'ensure_question_editable', _editable_ok)
    row = (1, 7, 'choice', 1, True, '{"selected":["A"]}', '{}', '{}', TS, TS)
    pool = FakePool([
        ('SELECT answer_mode FROM questions', FakeCursor([('choice',)])),
        ('SELECT option_label FROM question_options', FakeCursor([('A',), ('B',)])),
        ('INSERT INTO question_answer_keys', FakeCursor([row])),
    ])
    key = await q.upsert_answer_key(pool, _user(), 7, 'choice', {'selected': ['A']}, {}, {})
    assert key['answer_mode'] == 'choice'
    assert key['id'] == 1

    # answer_mode mismatch
    pool2 = FakePool([('SELECT answer_mode FROM questions', FakeCursor([('choice',)]))])
    with pytest.raises(envelope.APIError):
        await q.upsert_answer_key(pool2, _user(), 7, 'short_answer', {}, {}, {})

    # unknown option label
    pool3 = FakePool([
        ('SELECT answer_mode FROM questions', FakeCursor([('choice',)])),
        ('SELECT option_label FROM question_options', FakeCursor([('A',)])),
    ])
    with pytest.raises(envelope.APIError):
        await q.upsert_answer_key(pool3, _user(), 7, 'choice', {'selected': ['Z']}, {}, {})


def _option_row(option_id: int = 5) -> tuple:
    return (option_id, 7, 'A', 1, 'content', True, TS, TS)


async def test_create_option(monkeypatch):
    monkeypatch.setattr(q, 'ensure_question_editable', _editable_ok)
    with pytest.raises(envelope.APIError):
        await q.create_option(None, _user(), 7, '', '', False, None)
    with pytest.raises(envelope.APIError):
        await q.create_option(None, _user(), 7, 'L', 'c', False, 0)
    pool = FakePool([
        ('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort', FakeCursor([(2,)])),
        ('INSERT INTO question_options', FakeCursor([_option_row()])),
    ])
    option = await q.create_option(pool, _user(), 7, ' A ', 'x', True, None)
    assert option['option_label'] == 'A'
    assert option['is_correct'] is True


async def test_update_option(monkeypatch):
    monkeypatch.setattr(q, 'ensure_question_editable', _editable_ok)
    with pytest.raises(envelope.APIError):
        await q.update_option(None, _user(), 7, 5, None, None, None, None)
    pool = FakePool([('UPDATE question_options', FakeCursor([_option_row()]))])
    option = await q.update_option(pool, _user(), 7, 5, 'A', 'x', None, None)
    assert option['id'] == 5
    pool2 = FakePool([('UPDATE question_options', FakeCursor([]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await q.update_option(pool2, _user(), 7, 5, 'A', 'x', None, None)
    assert exc_info.value.code == 'NOT_FOUND'


async def test_delete_option(monkeypatch):
    monkeypatch.setattr(q, 'ensure_question_editable', _editable_ok)
    pool = FakePool([('DELETE FROM question_options', FakeCursor(rowcount=1))])
    await q.delete_option(pool, _user(), 7, 5)
    pool2 = FakePool([('DELETE FROM question_options', FakeCursor(rowcount=0))])
    with pytest.raises(envelope.APIError) as exc_info:
        await q.delete_option(pool2, _user(), 7, 5)
    assert exc_info.value.code == 'NOT_FOUND'


async def test_replace_question_content_blocks(monkeypatch):
    monkeypatch.setattr(q, 'ensure_question_editable', _editable_ok)
    async def owned(*_a, **_k):
        return None
    # media is imported lazily inside the function, so patch the media module
    monkeypatch.setattr('server.services.media.ensure_media_owned', owned)
    pool = FakePool([('DELETE FROM question_content_blocks', FakeCursor())])
    await q.replace_question_content_blocks(
        pool, _user(), 7, [q.QuestionContentBlockInput(part_type='image', media_id=3)]
    )
    assert any('INSERT INTO question_content_blocks' in sql for sql, _ in pool.record)


async def test_ensure_question_editable_forbidden():
    pool = FakePool([('SELECT q.id', FakeCursor([]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await q.ensure_question_editable(pool, _user(), 7)
    assert exc_info.value.code == 'FORBIDDEN'


async def test_assert_question_publishable(monkeypatch):
    async def editable(*_a, **_k):
        return None
    monkeypatch.setattr(q, 'ensure_question_editable', editable)
    row = ('choice', 2, 1, 1, '{"selected":["A"]}')
    pool = FakePool([('SELECT', FakeCursor([row]))])
    await q._assert_question_publishable(pool, _user(), 7)

    pool2 = FakePool([('SELECT', FakeCursor([('choice', 2, 1, 0, '{"selected":["A"]}')]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await q._assert_question_publishable(pool2, _user(), 7)
    assert exc_info.value.code == 'INVALID_STATE'

    pool3 = FakePool([('SELECT', FakeCursor([('choice', 1, 0, 1, '{"selected":["A"]}')]))])
    with pytest.raises(envelope.APIError):
        await q._assert_question_publishable(pool3, _user(), 7)

    pool4 = FakePool([('SELECT', FakeCursor([('short_answer', 0, 0, 1, '{"value":""}')]))])
    with pytest.raises(envelope.APIError):
        await q._assert_question_publishable(pool4, _user(), 7)

    pool5 = FakePool([('SELECT', FakeCursor([]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await q._assert_question_publishable(pool5, _user(), 7)
    assert exc_info.value.code == 'NOT_FOUND'


async def test_sync_choice_answer_key_from_options():
    conn = FakeConn([
        ('SELECT', FakeCursor([('choice', '{"selected":["A"]}')])),
        ('SELECT option_label', FakeCursor([('B',), ('A',)])),
    ])
    await q._sync_choice_answer_key_from_options(conn, 7)
    assert any('answer_payload = %s' in sql for sql, _ in conn.executed)
    # non-choice mode skips the update
    conn2 = FakeConn([('SELECT', FakeCursor([('short_answer', None)]))])
    await q._sync_choice_answer_key_from_options(conn2, 7)
    assert len(conn2.executed) == 1
