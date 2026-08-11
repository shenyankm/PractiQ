"""Import worker tests with fake pools and patched agents (no database required)."""

from __future__ import annotations

import asyncio
import json

import pytest

from server import imports_queue, worker
from server.ai_schemas import (
    ContentBlock,
    DocumentParseResult,
    ParsedGroup,
    ParsedOption,
    ParsedQuestion,
)
from server.auth.runtime import User
from server.services.users import LLMConfig
from tests.fakes import FakeCursor, FakePool


def _user(active: bool = True) -> User:
    return User(id=1, username='u', email=None, is_active=active, role='user', membership='pro')


def _claimed(**overrides) -> imports_queue.ClaimedJob:
    values = dict(id=99, persist_questions=True, attempt=1, claim_version=1,
                  persistence_started=False, attempts_exhausted=False)
    values.update(overrides)
    return imports_queue.ClaimedJob(**values)


def _parse_result() -> DocumentParseResult:
    return DocumentParseResult(
        questions=[
            ParsedQuestion(
                stem='Q1', answerMode='choice', questionTypeId='type-a',
                options=[ParsedOption(label='A', content='x', isCorrect=True),
                         ParsedOption(label='B', content='y')],
                answerPayload={'correctOption': 'A'},
                contentBlocks=[ContentBlock(partType='text', textValue='body')],
                confidence=0.9, needsReview=False,
            ),
        ],
        groups=[ParsedGroup(title='G1', instructions='inst', questionIndexes=[0])],
        visualElements=[], warnings=[], qualityScore=80.0,
    )


# ------------------------------------------------------------ job loading


async def test_load_import_job_found_and_missing():
    pool = FakePool([('FROM question_import_jobs', FakeCursor([(99, 1, 1, 'a.txt', 'txt', 'queued')]))])
    job = await worker._load_import_job(pool, 99)
    assert job['id'] == 99
    pool2 = FakePool([('FROM question_import_jobs', FakeCursor([]))])
    assert await worker._load_import_job(pool2, 99) is None


async def test_build_parse_request_merges_artifact_content():
    content = json.dumps({
        'text': '  question text  ',
        'fileBase64': 'QmFzZTY0',
        'mimeType': 'text/plain',
        'originalName': 'doc.txt',
    })
    pool = FakePool([
        ("artifact_type = 'source_file'", FakeCursor([(1, content), (2, {'text': 'more text'})])),
    ])
    job = {'id': 99, 'bank_id': 1, 'file_name': '', 'source_type': 'text', 'status': 'processing'}
    request = await worker._build_parse_request(pool, job)
    assert request.sourceType == 'txt'  # 'text' normalized
    assert request.fileName == 'doc.txt'
    assert request.text == 'question text\n\nmore text'
    assert request.fileBase64 == 'QmFzZTY0'
    assert request.mimeType == 'text/plain'


async def test_build_parse_request_skips_bad_content():
    pool = FakePool([
        ("artifact_type = 'source_file'", FakeCursor([(1, 'not-json{{'), (2, {'text': 42})])),
    ])
    job = {'id': 99, 'bank_id': 1, 'file_name': 'a.txt', 'source_type': 'txt', 'status': 'processing'}
    request = await worker._build_parse_request(pool, job)
    assert request.text is None
    assert request.fileName == 'a.txt'
    assert request.fileBase64 is None


async def test_record_import_event():
    pool = FakePool([
        ('INSERT INTO question_import_job_events', FakeCursor([(42,)])),
        ('UPDATE question_import_jobs SET last_event_id', FakeCursor()),
    ])
    await worker._record_import_event(pool, 99, 'processing', 'parse', '处理中', 'processing', None, 10, 10)
    assert len(pool.record) == 2


async def test_complete_import_job_and_claim_lost():
    result = _parse_result()
    pool = FakePool([("SET status = 'completed'", FakeCursor(rowcount=1))])
    await worker._complete_import_job(pool, 99, 1, 1, result)
    pool2 = FakePool([("SET status = 'completed'", FakeCursor(rowcount=0))])
    with pytest.raises(imports_queue.ClaimLostError):
        await worker._complete_import_job(pool2, 99, 1, 1, result)


def test_non_empty():
    assert worker._non_empty(None) is None
    assert worker._non_empty('  ') is None
    assert worker._non_empty(' x ') == ' x '


def test_should_requeue():
    assert worker._should_requeue(1, False) is True
    assert worker._should_requeue(3, False) is False
    assert worker._should_requeue(1, True) is False


async def test_record_failure_swallows_no_rows(monkeypatch):
    class _NoRows(Exception):
        pass

    monkeypatch.setattr(worker.imports_svc, '_NoRowsError', _NoRows)

    async def fail(_pool, *_args):
        raise _NoRows()

    monkeypatch.setattr(worker.imports_svc, 'record_import_job_failure', fail)
    await worker._record_failure(FakePool(), _claimed(), 'CODE', RuntimeError('x'))
    calls = []

    async def record(_pool, *_args):
        calls.append(_args)

    monkeypatch.setattr(worker.imports_svc, 'record_import_job_failure', record)
    await worker._record_failure(FakePool(), _claimed(), 'CODE', RuntimeError('x'))
    # record_import_job_failure(pool, job_id, claim_version, code, cause)
    assert calls[0][2] == 'CODE'


# -------------------------------------------------------- process_queued_job


async def test_process_queued_job_skips_non_processing(monkeypatch):
    async def fake_load(_pool, _job_id):
        return {'id': 99, 'status': 'queued'}

    monkeypatch.setattr(worker, '_load_import_job', fake_load)
    assert await worker.process_queued_job(FakePool(), _claimed(), 'secret') is False
    monkeypatch.setattr(worker, '_load_import_job', _async(None))
    assert await worker.process_queued_job(FakePool(), _claimed(), 'secret') is False


async def test_process_queued_job_missing_or_inactive_user(monkeypatch):
    async def fake_load(_pool, _job_id):
        return {'id': 99, 'created_by': 1, 'bank_id': 1, 'file_name': 'a', 'source_type': 'txt', 'status': 'processing'}

    monkeypatch.setattr(worker, '_load_import_job', fake_load)
    monkeypatch.setattr(worker.auth_runtime, 'current_user_by_id', _async(None))
    with pytest.raises(RuntimeError, match='not found'):
        await worker.process_queued_job(FakePool(), _claimed(), 'secret')
    monkeypatch.setattr(worker.auth_runtime, 'current_user_by_id', _async(_user(active=False)))
    with pytest.raises(RuntimeError, match='inactive'):
        await worker.process_queued_job(FakePool(), _claimed(), 'secret')


async def _patch_full_flow(monkeypatch, persist: bool = True) -> dict:
    """Patch every worker dependency; returns recorded calls."""
    job = {'id': 99, 'created_by': 1, 'bank_id': 1, 'file_name': 'a.txt', 'source_type': 'txt', 'status': 'processing'}
    monkeypatch.setattr(worker, '_load_import_job', _async(job))
    monkeypatch.setattr(worker.auth_runtime, 'current_user_by_id', _async(_user()))
    monkeypatch.setattr(worker.users_svc, 'require_llm_config', _async(LLMConfig('dashscope', 'k', 'm', None)))
    monkeypatch.setattr(worker.agents, 'build_models', lambda _cfg: (object(), None))
    monkeypatch.setattr(worker.agents, 'parse_document', _async(_parse_result()))
    monkeypatch.setattr(worker, '_record_import_event', _async(None))
    monkeypatch.setattr(worker, '_build_parse_request', _async(object()))
    monkeypatch.setattr(worker.imports_queue, 'begin_persistence', _async(None))
    calls = {'questions': [], 'groups': [], 'completed': []}
    monkeypatch.setattr(worker.questions_svc, 'persist_imported_question',
                        _async({'id': 101}, calls['questions']))
    monkeypatch.setattr(worker.groups_svc, 'create_group', _async({'id': 5}, calls['groups']))
    monkeypatch.setattr(worker.groups_svc, 'add_question_to_group', _async(None, calls['groups']))

    async def complete(_pool, _jid, _cv, count, _result):
        calls['completed'].append(count)

    monkeypatch.setattr(worker, '_complete_import_job', complete)
    monkeypatch.setattr(worker.imports_queue, 'begin_persistence', _async(None))
    claimed = _claimed(persist_questions=persist)
    return calls, claimed


def _async(value, sink=None, called=None):
    async def _fn(*_a, **_k):
        if sink is not None:
            sink.append((_a, _k))
        return value

    return _fn


async def test_process_queued_job_full_flow(monkeypatch):
    calls, claimed = await _patch_full_flow(monkeypatch)
    result = await worker.process_queued_job(FakePool(), claimed, 'secret')
    assert result is True  # persistence started
    assert len(calls['questions']) == 1
    assert len(calls['groups']) == 2  # create_group + add_question_to_group
    assert calls['completed'] == [1]
    question_input = calls['questions'][0][0][3].question
    assert question_input.answer_mode == 'choice'
    assert question_input.choice_variant == 'single'
    assert question_input.answer_payload == {'correctOption': 'A'}


async def test_process_queued_job_without_persistence(monkeypatch):
    calls, claimed = await _patch_full_flow(monkeypatch, persist=False)
    result = await worker.process_queued_job(FakePool(), claimed, 'secret')
    assert result is False
    assert not calls['questions']
    assert calls['completed'] == [0]  # no questions persisted


async def test_process_queued_job_multiple_correct_options():
    result = DocumentParseResult(
        questions=[ParsedQuestion(
            stem='Q', answerMode='choice', questionTypeId='t',
            options=[ParsedOption(label='A', content='x', isCorrect=True),
                     ParsedOption(label='B', content='y', isCorrect=True)],
            answerPayload={'correctOptions': ['A', 'B']},
            contentBlocks=[ContentBlock(partType='text')],
            confidence=0.5, needsReview=True,
        )],
        groups=[], visualElements=[], warnings=[], qualityScore=50.0,
    )

    async def parse(*_a):
        return result

    import types

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(worker, '_load_import_job', _async(
        {'id': 99, 'created_by': 1, 'bank_id': 1, 'file_name': 'a', 'source_type': 'txt', 'status': 'processing'}
    ))
    monkeypatch.setattr(worker.auth_runtime, 'current_user_by_id', _async(_user()))
    monkeypatch.setattr(worker.users_svc, 'require_llm_config', _async(LLMConfig('dashscope', 'k', 'm', None)))
    monkeypatch.setattr(worker.agents, 'build_models', lambda _cfg: (object(), None))
    monkeypatch.setattr(worker.agents, 'parse_document', parse)
    monkeypatch.setattr(worker, '_record_import_event', _async(None))
    monkeypatch.setattr(worker, '_build_parse_request', _async(object()))
    monkeypatch.setattr(worker, '_complete_import_job', _async(None))
    captured = []
    monkeypatch.setattr(worker.questions_svc, 'persist_imported_question',
                        _async({'id': 101}, captured))
    monkeypatch.setattr(worker.imports_queue, 'begin_persistence', _async(None))
    await worker.process_queued_job(FakePool(), _claimed(), 'secret')
    question_input = captured[0][0][3].question
    assert question_input.choice_variant == 'multiple'
    monkeypatch.undo()


# -------------------------------------------------------------- run_worker


async def test_run_worker_requeues_transient_failure_then_stops(monkeypatch):
    stop = asyncio.Event()
    calls = {'n': 0}

    async def fake_claim(_pool):
        calls['n'] += 1
        if calls['n'] > 1:
            stop.set()
            return None
        return _claimed(attempt=1)

    monkeypatch.setattr(worker.imports_queue, 'claim_next_job', fake_claim)

    async def fake_process(*_a):
        raise RuntimeError('boom')

    monkeypatch.setattr(worker, 'process_queued_job', fake_process)
    requeued = []

    async def fake_requeue(_pool, job_id, claim_version, delay):
        requeued.append((job_id, claim_version, delay))

    monkeypatch.setattr(worker.imports_queue, 'requeue_job', fake_requeue)
    await worker.run_worker(FakePool(), stop, 'secret')
    assert len(requeued) == 1
    assert requeued[0][2] == imports_queue.retry_backoff_seconds(1)


async def test_run_worker_records_persistence_interrupted(monkeypatch):
    stop = asyncio.Event()
    calls = {'n': 0}

    async def fake_claim(_pool):
        calls['n'] += 1
        if calls['n'] > 1:
            stop.set()
            return None
        return _claimed(persistence_started=True)

    monkeypatch.setattr(worker.imports_queue, 'claim_next_job', fake_claim)
    failures = []

    async def fake_record_failure(_pool, _job, code, _cause):
        failures.append(code)

    monkeypatch.setattr(worker, '_record_failure', fake_record_failure)
    await worker.run_worker(FakePool(), stop, 'secret')
    assert failures == [worker.imports_svc.IMPORT_PERSISTENCE_INTERRUPTED_CODE]


async def test_run_worker_records_attempts_exhausted(monkeypatch):
    stop = asyncio.Event()
    calls = {'n': 0}

    async def fake_claim(_pool):
        calls['n'] += 1
        if calls['n'] > 1:
            stop.set()
            return None
        return _claimed(attempt=3, attempts_exhausted=True)

    monkeypatch.setattr(worker.imports_queue, 'claim_next_job', fake_claim)
    failures = []

    async def fake_record_failure(_pool, _job, code, _cause):
        failures.append(code)

    monkeypatch.setattr(worker, '_record_failure', fake_record_failure)
    await worker.run_worker(FakePool(), stop, 'secret')
    assert failures == [worker.imports_svc.IMPORT_ATTEMPTS_EXHAUSTED_CODE]


async def test_run_worker_claim_lost_continues(monkeypatch):
    stop = asyncio.Event()
    calls = {'n': 0}

    async def fake_claim(_pool):
        calls['n'] += 1
        if calls['n'] > 1:
            stop.set()
            return None
        return _claimed()

    monkeypatch.setattr(worker.imports_queue, 'claim_next_job', fake_claim)

    async def fake_process(*_a):
        raise imports_queue.ClaimLostError()

    monkeypatch.setattr(worker, 'process_queued_job', fake_process)
    await worker.run_worker(FakePool(), stop, 'secret')
    assert calls['n'] == 2


async def test_run_worker_records_final_failure_when_no_requeue(monkeypatch):
    stop = asyncio.Event()
    calls = {'n': 0}

    async def fake_claim(_pool):
        calls['n'] += 1
        if calls['n'] > 1:
            stop.set()
            return None
        return _claimed(attempt=3)

    monkeypatch.setattr(worker.imports_queue, 'claim_next_job', fake_claim)
    monkeypatch.setattr(worker, 'process_queued_job', _async(False))
    # force an exception from the persistence path itself
    async def failing_process(*_a):
        raise RuntimeError('boom')

    monkeypatch.setattr(worker, 'process_queued_job', failing_process)
    failures = []

    async def fake_record_failure(_pool, _job, code, _cause):
        failures.append(code)

    monkeypatch.setattr(worker, '_record_failure', fake_record_failure)
    await worker.run_worker(FakePool(), stop, 'secret')
    assert failures == [worker.imports_svc.IMPORT_ATTEMPTS_EXHAUSTED_CODE]


async def test_run_worker_shutdown_releases_and_raises(monkeypatch):
    stop = asyncio.Event()
    monkeypatch.setattr(worker.imports_queue, 'claim_next_job', _async(_claimed()))
    released = []

    async def fake_release(_pool, job_id, claim_version):
        released.append((job_id, claim_version))

    monkeypatch.setattr(worker.imports_queue, 'release_job', fake_release)

    async def failing_process(*_a):
        stop.set()  # shutdown lands mid-job
        raise RuntimeError('shutdown boom')

    monkeypatch.setattr(worker, 'process_queued_job', failing_process)
    with pytest.raises(RuntimeError, match='shutdown boom'):
        await worker.run_worker(FakePool(), stop, 'secret')
    assert released == [(99, 1)]
