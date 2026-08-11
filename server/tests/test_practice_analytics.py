"""Practice session + analytics service tests with fake pools (no database required)."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import fakeredis.aioredis
import pytest

from server import envelope, redisx
from server.auth.runtime import User
from server.services import analytics as a
from server.services import practice as p
from tests.fakes import FakeCursor, FakePool

TS = datetime(2026, 8, 11, 3, 30, 2, 558000, tzinfo=timezone.utc)


def _user() -> User:
    return User(id=1, username='u', email=None, is_active=True, role='user', membership='free')


def _session_row(session_id: int = 5) -> tuple:
    return (session_id, 1, 1, 'practice', 'active', 3, 1, 1, 0, 50, TS, None)


def _answer_row(answer_id: int = 11) -> tuple:
    return (answer_id, 1, 5, 1, 7, 3, '{"selected":["A"]}', True, 1.0, 1.0, 2000, TS)


def _item_row() -> tuple:
    return (
        1, None, 7, 'question', 1, None, 'Q1', 'active', 'book', 'math',
        'type-a', 'choice', 'single', 'text_only', 'stem', None, 'active',
        'Group', 'inst', '[{"id":5,"content":"x"}]',
    )


def _key_row(key_id: int = 3) -> tuple:
    return (key_id, 7, 'choice', 1, True, '{"selected":["A"]}', '{}', '{}', TS, TS)


# --------------------------------------------------------------- helpers


def test_scan_session_and_answer():
    session = p._scan_session(_session_row())
    assert session['id'] == 5
    assert session['completed_at'] is None
    answer = p._scan_answer(_answer_row())
    assert answer['answer_payload'] == {'selected': ['A']}
    assert answer['is_correct'] is True
    answer_str = p._scan_answer(_answer_row()[:6] + ('{"selected":["B"]}',) + _answer_row()[7:])
    assert answer_str['answer_payload'] == {'selected': ['B']}


def test_normalize_practice_mode():
    assert p._normalize_practice_mode('', 'review') == 'wrong'
    assert p._normalize_practice_mode('', 'exam') == 'exam'
    assert p._normalize_practice_mode('', 'practice') == 'all'
    assert p._normalize_practice_mode('by_type', 'exam') == 'by_type'


def test_normalize_question_count():
    assert p._normalize_question_count(10, True) == 500
    assert p._normalize_question_count(0, False) == 1
    assert p._normalize_question_count(10, False) == 10
    assert p._normalize_question_count(9999, False) == 500


def test_practice_queue_ttl_seconds(monkeypatch):
    monkeypatch.delenv('PRACTICE_QUEUE_TTL_SECONDS', raising=False)
    assert p._practice_queue_ttl_seconds() == 7 * 24 * 3600
    monkeypatch.setenv('PRACTICE_QUEUE_TTL_SECONDS', '100')
    assert p._practice_queue_ttl_seconds() == 100
    monkeypatch.setenv('PRACTICE_QUEUE_TTL_SECONDS', 'bogus')
    assert p._practice_queue_ttl_seconds() == 7 * 24 * 3600
    monkeypatch.setenv('PRACTICE_QUEUE_TTL_SECONDS', '-5')
    assert p._practice_queue_ttl_seconds() == 7 * 24 * 3600


def test_practice_answer_for_session():
    session_active_exam = {'session_type': 'exam', 'status': 'active'}
    safe = p._practice_answer_for_session({'answer_key_id': 3, 'is_correct': True, 'score': 1.0, 'max_score': 1.0}, session_active_exam)
    assert safe['answer_key_id'] is None
    assert safe['is_correct'] is None
    assert p._should_reveal_practice_feedback(session_active_exam, None) is False
    assert p._should_reveal_practice_feedback({'session_type': 'practice', 'status': 'active'}, {'x': 1}) is True
    assert p._practice_answer_for_session({'answer_key_id': 3}, {'session_type': 'practice', 'status': 'active'}) == {'answer_key_id': 3}


def test_validate_submitted_practice_answer():
    p._validate_submitted_practice_answer('choice', {'selected': ['A']})
    p._validate_submitted_practice_answer('true_false', {'value': True})
    p._validate_submitted_practice_answer('fill_blank', {'value': ['x']})
    p._validate_submitted_practice_answer('short_answer', {'value': 'ans'})
    with pytest.raises(envelope.APIError):
        p._validate_submitted_practice_answer('choice', {})
    with pytest.raises(envelope.APIError):
        p._validate_submitted_practice_answer('true_false', {'value': 'yes'})
    with pytest.raises(envelope.APIError):
        p._validate_submitted_practice_answer('fill_blank', {})
    # ponytail: None values normalize to 'none', so only an empty string trips short_answer
    with pytest.raises(envelope.APIError):
        p._validate_submitted_practice_answer('short_answer', {'value': ''})


def test_grade_short_answer_and_invalid_payloads():
    assert p.grade_practice_answer('short_answer', {'answer_payload': '{"value":"4"}'}, {'value': '4'}) is None
    assert p.grade_practice_answer('choice', {'answer_payload': 'not-json'}, {'selected': ['A']}) is None
    assert p.grade_practice_answer('choice', {'answer_payload': '[1,2]'}, {'selected': ['A']}) is None
    assert p.grade_practice_answer('true_false', {'answer_payload': '{"value":"yes"}'}, {'value': True}) is None
    assert p.grade_practice_answer('fill_blank', {'answer_payload': '{"value":["a"]}'}, {'value': ['a', 'b']}) is True
    assert p.grade_practice_answer('fill_blank', {'answer_payload': '{"value":["a","b"]}'}, {'value': ['a']}) is False
    assert p.grade_practice_answer('unknown_mode', {'answer_payload': '{}'}, {}) is None


# ---------------------------------------------------------- session flows


async def test_start_practice_session(monkeypatch):
    async def fake_get_bank(_pool, _user, _bank_id):
        return {'id': 1, 'is_owner': True}

    async def fake_ids(_pool, _user, _bank_id, count, mode, _type):
        return [7, 8, 9]

    monkeypatch.setattr(p, 'get_bank', fake_get_bank)
    monkeypatch.setattr(p, '_load_practice_question_ids', fake_ids)
    pool = FakePool([('INSERT INTO user_practice_sessions', FakeCursor([_session_row()]))])
    session = await p.start_practice_session(
        pool, _user(), p.PracticeSessionInput(bank_id=1, question_count=3)
    )
    assert session['id'] == 5
    assert pool.record[0][1][2] == 'practice'

    session2 = await p.start_practice_session(
        pool, _user(), p.PracticeSessionInput(bank_id=1, mode='exam', question_count=3)
    )
    assert pool.record[-1][1][2] == 'exam'

    session3 = await p.start_practice_session(
        pool, _user(), p.PracticeSessionInput(bank_id=1, mode='wrong', question_count=3)
    )
    assert pool.record[-1][1][2] == 'review'


async def test_start_practice_session_validation(monkeypatch):
    async def fake_get_bank(_pool, _user, _bank_id):
        return {'id': 1}

    async def fake_ids(_pool, _user, _bank_id, count, mode, _type):
        return []

    monkeypatch.setattr(p, 'get_bank', fake_get_bank)
    monkeypatch.setattr(p, '_load_practice_question_ids', fake_ids)
    with pytest.raises(envelope.APIError) as exc_info:
        await p.start_practice_session(pool=None, user=_user(), input=p.PracticeSessionInput(
            bank_id=1, mode='by_type'
        ))
    assert exc_info.value.code == 'VALIDATION_ERROR'
    with pytest.raises(envelope.APIError) as exc_info:
        await p.start_practice_session(pool=None, user=_user(), input=p.PracticeSessionInput(bank_id=1))
    assert exc_info.value.code == 'INVALID_STATE'
    with pytest.raises(envelope.APIError) as exc_info:
        await p.start_practice_session(pool=None, user=_user(), input=p.PracticeSessionInput(bank_id=1, mode='wrong'))
    assert 'No wrong questions' in exc_info.value.message


async def test_get_practice_session_found_and_missing():
    pool = FakePool([('FROM user_practice_sessions', FakeCursor([_session_row()]))])
    session = await p.get_practice_session(pool, _user(), 5)
    assert session['status'] == 'active'
    pool2 = FakePool([('FROM user_practice_sessions', FakeCursor([]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await p.get_practice_session(pool2, _user(), 5)
    assert exc_info.value.code == 'NOT_FOUND'


async def test_get_practice_questions(monkeypatch):
    async def fake_session(*_a):
        return p._scan_session(_session_row())

    async def fake_queue(_pool, session):
        return [7, 8]

    monkeypatch.setattr(p, 'get_practice_session', fake_session)
    monkeypatch.setattr(p, '_ensure_practice_question_queue', fake_queue)
    pool = FakePool([('WITH requested_ids AS', FakeCursor([_item_row()]))])
    items = await p.get_practice_questions(pool, _user(), 5)
    assert items[0]['question_id'] == 7
    assert items[0]['options'] == [{'id': 5, 'content': 'x'}]


async def test_get_practice_question_page(monkeypatch):
    async def fake_session(*_a):
        return p._scan_session(_session_row())

    monkeypatch.setattr(p, 'get_practice_session', fake_session)

    async def fake_queue(_pool, session):
        return [7, 8]

    monkeypatch.setattr(p, '_ensure_practice_question_queue', fake_queue)

    async def fake_rows(_pool, _session, ids, offset, limit):
        return [_item_row_mapped()]

    def _item_row_mapped():
        row = _item_row()
        return {
            'bank_id': row[0], 'group_id': row[1], 'question_id': row[2], 'item_scope': row[3],
            'bank_sort_order': row[4], 'group_sort_order': row[5], 'question_no': row[6],
            'bank_link_status': row[7], 'business_type': row[8], 'subject_id': row[9],
            'question_type_id': row[10], 'answer_mode': row[11], 'choice_variant': row[12],
            'content_mode': row[13], 'stem': row[14], 'analysis': row[15], 'question_status': row[16],
            'group_title': row[17], 'group_instructions': row[18], 'options': [{'id': 5}],
        }

    monkeypatch.setattr(p, '_load_practice_question_rows', fake_rows)

    async def fake_answer(*_a, **_k):
        return p._scan_answer(_answer_row())

    monkeypatch.setattr(p, '_get_existing_practice_answer', fake_answer)

    pool = FakePool([
        ('SELECT question_id, is_correct', FakeCursor([(7, True)])),
        ('SELECT analysis FROM questions', FakeCursor([('analysis',)])),
    ])
    page = await p.get_practice_question_page(pool, _user(), 5, 0)
    assert page['question']['question_id'] == 7
    assert page['total'] == 2
    assert page['answeredCount'] == 1
    assert page['question']['analysis'] == 'analysis'
    assert page['previousIndex'] is None
    assert page['nextIndex'] == 1
    # out-of-range index clamps
    page2 = await p.get_practice_question_page(pool, _user(), 5, 99)
    assert page2['questionIndex'] == 1


async def test_get_practice_question_page_exam_hides_results(monkeypatch):
    async def fake_session(*_a):
        return p._scan_session((5, 1, 1, 'exam', 'active', 3, 1, 1, 0, 50, TS, None))

    async def fake_queue(*_a):
        return [7]

    async def fake_rows(*_a, **_k):
        return [_item_row_mapped()]

    async def fake_answer(*_a, **_k):
        return p._scan_answer(_answer_row())

    monkeypatch.setattr(p, 'get_practice_session', fake_session)
    monkeypatch.setattr(p, '_ensure_practice_question_queue', fake_queue)
    monkeypatch.setattr(p, '_load_practice_question_rows', fake_rows)
    monkeypatch.setattr(p, '_get_existing_practice_answer', fake_answer)
    def _item_row_mapped():
        row = _item_row()
        return {k: v for k, v in zip(
            ['bank_id', 'group_id', 'question_id', 'item_scope', 'bank_sort_order', 'group_sort_order',
             'question_no', 'bank_link_status', 'business_type', 'subject_id', 'question_type_id',
             'answer_mode', 'choice_variant', 'content_mode', 'stem', 'analysis', 'question_status',
             'group_title', 'group_instructions', 'options'],
            row,
        )}

    pool = FakePool([('SELECT question_id, is_correct', FakeCursor([]))])
    page = await p.get_practice_question_page(pool, _user(), 5, None)
    assert page['progress'][0]['isCorrect'] is None  # exam hides correctness
    assert page['result']['is_correct'] is None  # exam masks answer


async def test_list_practice_sessions():
    pool = FakePool([('FROM user_practice_sessions', FakeCursor([_session_row()]))])
    page = await p.list_practice_sessions(pool, _user(), 0, '', '')
    assert page.items[0]['id'] == 5
    with pytest.raises(envelope.APIError):
        await p.list_practice_sessions(pool, _user(), 0, 'bogus', '')
    page2 = await p.list_practice_sessions(pool, _user(), 10, 'active', '')
    assert page2.items[0]['id'] == 5


async def test_submit_answer(monkeypatch):
    async def fake_session(*_a):
        return p._scan_session(_session_row())

    monkeypatch.setattr(p, 'get_practice_session', fake_session)

    async def no_answer(*_a, **_k):
        return None

    monkeypatch.setattr(p, '_get_existing_practice_answer', no_answer)
    pool = FakePool([
        ('SELECT answer_mode', FakeCursor([('choice',)])),
        ('INSERT INTO user_question_answers', FakeCursor([_answer_row()])),
    ])
    result = await p.submit_answer(
        pool, _user(), 5, p.PracticeAnswerInput(question_id=7, answer_payload={'selected': ['A']}, duration_ms=100)
    )
    assert result['is_correct'] is True
    assert result['score'] == 1.0


async def test_submit_answer_replays_existing(monkeypatch):
    async def fake_session(*_a):
        return p._scan_session(_session_row())

    async def existing(*_a, **_k):
        return p._scan_answer(_answer_row())

    monkeypatch.setattr(p, 'get_practice_session', fake_session)
    monkeypatch.setattr(p, '_get_existing_practice_answer', existing)
    result = await p.submit_answer(pool=None, user=_user(), session_id=5, input=p.PracticeAnswerInput(
        question_id=7, answer_payload={'selected': ['A']}
    ))
    assert result['id'] == 11


async def test_submit_answer_inactive_session(monkeypatch):
    async def fake_session(*_a):
        return p._scan_session((5, 1, 1, 'practice', 'completed', 3, 1, 1, 0, 50, TS, TS))

    async def no_answer(*_a, **_k):
        return None

    monkeypatch.setattr(p, 'get_practice_session', fake_session)
    monkeypatch.setattr(p, '_get_existing_practice_answer', no_answer)
    with pytest.raises(envelope.APIError) as exc_info:
        await p.submit_answer(None, _user(), 5, p.PracticeAnswerInput(question_id=7, answer_payload={}))
    assert exc_info.value.code == 'INVALID_STATE'


async def test_submit_answer_question_not_in_bank(monkeypatch):
    async def fake_session(*_a):
        return p._scan_session(_session_row())

    async def no_answer(*_a, **_k):
        return None

    monkeypatch.setattr(p, 'get_practice_session', fake_session)
    monkeypatch.setattr(p, '_get_existing_practice_answer', no_answer)
    pool = FakePool([('SELECT answer_mode', FakeCursor([]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await p.submit_answer(pool, _user(), 5, p.PracticeAnswerInput(question_id=7, answer_payload={}))
    assert exc_info.value.code == 'NOT_FOUND'


async def test_submit_answer_race_returns_existing_or_500(monkeypatch):
    async def fake_session(*_a):
        return p._scan_session(_session_row())

    monkeypatch.setattr(p, 'get_practice_session', fake_session)
    calls = {'n': 0}

    async def sometimes_existing(*_a, **_k):
        calls['n'] += 1
        return p._scan_answer(_answer_row()) if calls['n'] > 1 else None

    monkeypatch.setattr(p, '_get_existing_practice_answer', sometimes_existing)
    pool = FakePool([
        ('SELECT answer_mode', FakeCursor([('choice',)])),
        ('INSERT INTO user_question_answers', FakeCursor([])),  # ON CONFLICT DO NOTHING -> no row
    ])
    result = await p.submit_answer(pool, _user(), 5, p.PracticeAnswerInput(question_id=7, answer_payload={'selected': ['A']}))
    assert result['id'] == 11

    async def never_existing(*_a, **_k):
        return None

    monkeypatch.setattr(p, '_get_existing_practice_answer', never_existing)
    pool2 = FakePool([
        ('SELECT answer_mode', FakeCursor([('choice',)])),
        ('INSERT INTO user_question_answers', FakeCursor([])),
    ])
    with pytest.raises(envelope.APIError) as exc_info:
        await p.submit_answer(pool2, _user(), 5, p.PracticeAnswerInput(question_id=7, answer_payload={'selected': ['A']}))
    assert exc_info.value.code == 'INTERNAL_ERROR'


async def test_submit_answer_with_redis_queue_check(monkeypatch):
    fake = fakeredis.aioredis.FakeRedis()
    monkeypatch.setattr(redisx, '_client', fake)
    monkeypatch.setattr(redisx, '_client_url', 'redis://fake')
    monkeypatch.setenv('REDIS_URL', 'redis://fake')

    async def fake_session(*_a):
        return p._scan_session(_session_row())

    async def no_answer(*_a, **_k):
        return None

    monkeypatch.setattr(p, 'get_practice_session', fake_session)
    monkeypatch.setattr(p, '_get_existing_practice_answer', no_answer)
    await redisx.set_json(fake, p._practice_question_queue_key(5), [7, 8], 60)
    pool = FakePool([
        ('SELECT answer_mode', FakeCursor([('choice',)])),
        ('INSERT INTO user_question_answers', FakeCursor([_answer_row()])),
    ])
    result = await p.submit_answer(pool, _user(), 5, p.PracticeAnswerInput(question_id=7, answer_payload={'selected': ['A']}))
    assert result['id'] == 11
    # question not in queued list -> 404
    with pytest.raises(envelope.APIError) as exc_info:
        await p.submit_answer(pool, _user(), 5, p.PracticeAnswerInput(question_id=99, answer_payload={'selected': ['A']}))
    assert exc_info.value.code == 'NOT_FOUND'
    redisx._reset()


async def test_complete_practice_session():
    pool = FakePool([('UPDATE user_practice_sessions', FakeCursor([_session_row()]))])
    session = await p.complete_practice_session(pool, _user(), 5, 'completed')
    assert session['status'] == 'active'  # row as-is
    pool2 = FakePool([('UPDATE user_practice_sessions', FakeCursor([]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await p.complete_practice_session(pool2, _user(), 5, 'completed')
    assert exc_info.value.code == 'NOT_FOUND'


async def test_get_practice_results(monkeypatch):
    async def fake_session(*_a):
        return p._scan_session((5, 1, 1, 'practice', 'completed', 3, 1, 1, 0, 50, TS, TS))

    monkeypatch.setattr(p, 'get_practice_session', fake_session)
    pool = FakePool([
        ('FROM user_question_answers uqa', FakeCursor([
            _answer_row() + ('What is 2+2?', 'choice', 'analysis', '[{"version":1}]'),
        ])),
    ])
    results = await p.get_practice_results(pool, _user(), 5)
    assert results[0]['stem'] == 'What is 2+2?'
    assert results[0]['answer_keys'] == [{'version': 1}]

    async def active_session(*_a):
        return p._scan_session(_session_row())

    monkeypatch.setattr(p, 'get_practice_session', active_session)
    with pytest.raises(envelope.APIError) as exc_info:
        await p.get_practice_results(pool, _user(), 5)
    assert exc_info.value.code == 'INVALID_STATE'


async def test_ensure_practice_question_queue_redis_hit(monkeypatch):
    fake = fakeredis.aioredis.FakeRedis()
    monkeypatch.setattr(redisx, '_client', fake)
    monkeypatch.setattr(redisx, '_client_url', 'redis://fake')
    monkeypatch.setenv('REDIS_URL', 'redis://fake')
    await redisx.set_json(fake, p._practice_question_queue_key(5), [7, 8, 9], 60)
    session = p._scan_session(_session_row())
    assert await p._ensure_practice_question_queue(None, session) == [7, 8, 9]
    redisx._reset()


async def test_ensure_practice_question_queue_db_fallback():
    session = p._scan_session(_session_row())
    pool = FakePool([('FROM v_bank_question_items', FakeCursor([(7,), (8,)]))])
    assert await p._ensure_practice_question_queue(pool, session) == [7, 8]
    session_no_bank = p._scan_session((5, 1, None, 'practice', 'active', 3, 1, 1, 0, 50, TS, None))
    assert await p._ensure_practice_question_queue(pool, session_no_bank) == []


async def test_load_practice_question_ids_by_type_and_wrong():
    pool = FakePool([('SELECT item.question_id', FakeCursor([(7,), (8,)]))])
    ids = await p._load_practice_question_ids(pool, _user(), 1, 5, 'by_type', 'type-a')
    assert ids == [7, 8]
    assert pool.record[0][1][2] == 'type-a'
    ids2 = await p._load_practice_question_ids(pool, _user(), 1, 5, 'wrong', '')
    assert ids2 == [7, 8]
    assert pool.record[-1][1][2] is None


async def test_load_primary_answer_key_none_and_found():
    pool = FakePool([('SELECT id, question_id', FakeCursor([]))])
    assert await p._load_primary_answer_key(pool, 7) is None
    pool2 = FakePool([('SELECT id, question_id', FakeCursor([_key_row()]))])
    key = await p._load_primary_answer_key(pool2, 7)
    assert key['answer_payload'] == '{"selected":["A"]}'
    assert key['id'] == 3


# ------------------------------------------------------------- analytics


async def test_analytics_summary_and_accuracy(monkeypatch):
    async def fake_get_bank(_pool, _user, _bank_id):
        return {'id': 1}

    monkeypatch.setattr(a, 'get_bank', fake_get_bank)
    pool = FakePool([
        ('SELECT', FakeCursor([(2, 1, 10, 8, 2, 4, 1, 0)])),
    ])
    summary = await a.get_analytics_summary(pool, _user())
    assert summary['accuracy'] == 80
    assert summary['owned_banks'] == 2
    summary_zero = await a.get_analytics_summary(pool, _user())
    # same pool: second call re-runs loader (no redis)
    pool2 = FakePool([('SELECT', FakeCursor([(0, 0, 0, 0, 0, 0, 0, 0)]))])
    zero = await a.get_analytics_summary(pool2, _user())
    assert zero['accuracy'] == 0


async def test_get_bank_analytics_and_leaderboard():
    async def fake_get_bank(_pool, _user, _bank_id):
        return {'id': 1}

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(a, 'get_bank', fake_get_bank)
    pool3 = FakePool([('SELECT', FakeCursor([(5, 2, 3, 10)]))])
    data = await a.get_bank_analytics(pool3, _user(), 1)
    assert data['completed_count'] == 5
    monkeypatch.undo()

    monkeypatch2 = pytest.MonkeyPatch()
    monkeypatch2.setattr(a, 'get_bank', fake_get_bank)
    pool4 = FakePool([('SELECT', FakeCursor([
        (1, 'u', 10, 2, TS, 80.0),
    ]))])
    leaderboard = await a.get_bank_leaderboard(pool4, _user(), 1, 5)
    assert leaderboard[0]['accuracy_percent'] == 80.0
    assert leaderboard[0]['user_id'] == 1
    monkeypatch2.undo()


async def test_get_user_stats_snapshot():
    async def fake_summary(_pool, _user):
        return {'accuracy': 50}

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(a, 'get_analytics_summary', fake_summary)
    pool = FakePool([
        ('SELECT id, user_id, bank_id', FakeCursor([
            (5, 1, 1, 'practice', 'completed', 3, 3, 2, 1, 67, TS, TS),
        ])),
        ('SELECT', FakeCursor([
            (7, 4, 3, 1, 75, 'What?', 'type-a'),
        ])),
    ])
    snapshot = await a.get_user_stats_snapshot(pool, _user())
    assert snapshot['summary']['accuracy'] == 50
    assert snapshot['recentSessions'][0]['id'] == 5
    assert snapshot['weakQuestions'][0]['question_id'] == 7
    monkeypatch.undo()


async def test_get_import_analytics_found_and_missing():
    row = (
        99, 1, 1, 'completed', 'completed', TS, True, '{}', '{}', '[]', 5, 5,
        'a.txt', 'txt', 1, 80.0, None, None, 100, 100, 10, TS, TS, TS, TS, 3, 5,
    )
    pool = FakePool([('FROM question_import_jobs qij', FakeCursor([row]))])
    job = await a.get_import_analytics(pool, _user(), 99)
    assert job['id'] == 99
    assert job['events'] == 3
    pool2 = FakePool([('FROM question_import_jobs qij', FakeCursor([]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await a.get_import_analytics(pool2, _user(), 99)
    assert exc_info.value.code == 'NOT_FOUND'


async def test_analytics_cached_via_redis(monkeypatch):
    fake = fakeredis.aioredis.FakeRedis()
    monkeypatch.setattr(redisx, '_client', fake)
    monkeypatch.setattr(redisx, '_client_url', 'redis://fake')
    monkeypatch.setenv('REDIS_URL', 'redis://fake')
    pool = FakePool([('SELECT', FakeCursor([(1, 0, 0, 0, 0, 0, 0, 0)]))])
    summary = await a.get_analytics_summary(pool, _user())
    assert summary['owned_banks'] == 1
    # second call served from cache: pool must not be touched again
    summary2 = await a.get_analytics_summary(pool, _user())
    assert summary2['owned_banks'] == 1
    assert len(pool.record) == 1
    redisx._reset()
