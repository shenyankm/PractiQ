"""Offline source repair uses retained references and preserves damaged evidence."""

import json
import os
import sys
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from practiq_ai import manage, source_repair
from practiq_ai.errors import DocumentProcessingError
from tests.support import object_store, upload


@pytest.fixture
async def repair_case(tmp_path, monkeypatch):
    monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')
    store = object_store(tmp_path / 'files')
    reference = await store.put_document(b'quiz', upload())
    db = SimpleNamespace(check_schema=AsyncMock(), rows=AsyncMock(return_value=[{
        'graph_id': 'document_parser', 'document': reference.model_dump(mode='json'),
    }]))
    locks = []

    @asynccontextmanager
    async def exclusive(database):
        assert database is db
        locks.append('acquired')
        try:
            yield
        finally:
            locks.append('released')

    monkeypatch.setattr(source_repair, 'exclusive', exclusive)
    monkeypatch.setattr(source_repair, 'get_object_store', lambda: store)
    replacement = tmp_path / 'original.txt'
    replacement.write_bytes(b'quiz')
    return SimpleNamespace(store=store, reference=reference, db=db, thread_id=str(uuid4()),
                           replacement=replacement, locks=locks, source=store._path(reference.objectKey))


@pytest.mark.parametrize('payload,status,code', [
    (b'quiz', 'verified', None), (b'oops', 'corrupt', 'DOCUMENT_CHECKSUM_MISMATCH'),
    (b'oversized', 'corrupt', 'DOCUMENT_SIZE_MISMATCH'), (None, 'missing', 'OBJECT_NOT_FOUND'),
])
async def test_verify_reports_source_damage_without_writing(repair_case, payload, status, code):
    case = repair_case
    if payload is None:
        case.source.unlink()
    else:
        case.source.write_bytes(payload)
    result = await source_repair.source_operation(case.db, case.thread_id)
    assert result == {'threadId': case.thread_id, 'status': status, 'errorCode': code, 'quarantine': None}
    assert not (case.store.root / '.quarantine').exists()
    assert case.locks == ['acquired', 'released']
    case.db.check_schema.assert_awaited_once()
    assert not case.source.exists() if payload is None else case.source.read_bytes() == payload


@pytest.mark.parametrize('payload', [b'oops', b'oversized', None])
async def test_repair_preserves_bad_source_and_reference_before_replacing(repair_case, payload):
    case = repair_case
    if payload is None:
        case.source.unlink()
    else:
        case.source.write_bytes(payload)
    original_reference = case.reference.model_dump(mode='json')
    result = await source_repair.source_operation(case.db, case.thread_id, case.replacement)
    assert result['status'] == 'repaired' and result['errorCode'] is None
    assert await case.store.get_verified(case.reference) == b'quiz'
    quarantine = case.store.root / result['quarantine']
    manifest = json.loads((quarantine / 'manifest.json').read_text())
    assert manifest['completed'] and manifest['document'] == original_reference
    assert manifest['threadId'] == case.thread_id
    if payload is None:
        assert manifest['original'] is None and not (quarantine / 'original').exists()
    else:
        assert (quarantine / 'original').read_bytes() == payload
        assert manifest['original']['sizeBytes'] == len(payload)
    assert (quarantine / 'manifest.json').stat().st_mode & 0o777 == 0o600
    assert quarantine.stat().st_mode & 0o777 == 0o700
    assert case.reference.model_dump(mode='json') == original_reference
    assert (await source_repair.source_operation(case.db, case.thread_id, case.replacement))['status'] == 'verified'
    assert len(list(quarantine.parent.iterdir())) == 1


@pytest.mark.skipif(os.name != 'posix', reason='POSIX file ownership boundary')
@pytest.mark.parametrize('missing', [False, True])
async def test_repair_refuses_a_different_file_owner_before_preserving_or_writing(repair_case, monkeypatch, missing):
    case = repair_case
    if missing:
        case.source.unlink()
        case.source.parent.rmdir()
        owner = case.source.parent.parent
    else:
        case.source.write_bytes(b'oops')
        owner = case.source
    monkeypatch.setattr(source_repair.os, 'geteuid', lambda: owner.stat().st_uid + 1)
    with pytest.raises(PermissionError, match='original service/file owner'):
        await source_repair.source_operation(case.db, case.thread_id, case.replacement)
    assert not (case.store.root / '.quarantine').exists()
    assert not case.source.exists() if missing else case.source.read_bytes() == b'oops'
    assert case.locks == ['acquired', 'released']


@pytest.mark.skipif(os.name != 'posix', reason='POSIX file ownership boundary')
async def test_read_only_verification_allows_another_permitted_identity(repair_case, monkeypatch):
    case = repair_case
    case.source.write_bytes(b'oops')
    monkeypatch.setattr(source_repair.os, 'geteuid', lambda: case.source.stat().st_uid + 1)
    result = await source_repair.source_operation(case.db, case.thread_id)
    assert result['status'] == 'corrupt' and case.source.read_bytes() == b'oops'
    assert not (case.store.root / '.quarantine').exists()


@pytest.mark.parametrize('invalid', ['size', 'checksum', 'symlink', 'directory'])
async def test_invalid_replacement_keeps_bad_source_without_quarantine(repair_case, invalid):
    case = repair_case
    case.source.write_bytes(b'oops')
    if invalid in {'size', 'checksum'}:
        case.replacement.write_bytes(b'wrong-size' if invalid == 'size' else b'nope')
    else:
        case.replacement.unlink()
        if invalid == 'symlink':
            case.replacement.symlink_to(case.source)
        else:
            case.replacement.mkdir()
    with pytest.raises((ValueError, OSError)):
        await source_repair.source_operation(case.db, case.thread_id, case.replacement)
    assert case.source.read_bytes() == b'oops'
    assert not (case.store.root / '.quarantine').exists()


@pytest.mark.parametrize('field,value', [('objectKey', '../outside'), ('mediaType', 'application/pdf')])
async def test_invalid_retained_reference_is_never_repaired(repair_case, field, value):
    case = repair_case
    case.db.rows.return_value[0]['document'][field] = value
    with pytest.raises(ValueError):
        await source_repair.source_operation(case.db, case.thread_id, case.replacement)
    assert case.source.read_bytes() == b'quiz'
    assert not (case.store.root / '.quarantine').exists()


@pytest.mark.parametrize('link', ['source', 'quarantine'])
async def test_symlinked_source_or_quarantine_is_rejected(repair_case, tmp_path, link):
    case = repair_case
    case.source.write_bytes(b'oops')
    outside = tmp_path / 'outside'
    if link == 'source':
        outside.write_bytes(b'oops')
        case.source.unlink()
        case.source.symlink_to(outside)
    else:
        outside.mkdir()
        (case.store.root / '.quarantine').symlink_to(outside, target_is_directory=True)
    with pytest.raises(DocumentProcessingError) as error:
        await source_repair.source_operation(case.db, case.thread_id, case.replacement)
    assert error.value.code == 'INVALID_OBJECT_REFERENCE'
    assert case.source.read_bytes() == b'oops'
    assert not outside.is_dir() or not list(outside.iterdir())


@pytest.mark.parametrize('failure', ['manifest', 'replacement', 'completion'])
async def test_failed_publication_preserves_evidence_and_reports_incomplete(repair_case, monkeypatch, failure):
    case = repair_case
    case.source.write_bytes(b'oops')
    original_write = case.store._write

    def write(key, payload):
        if ((failure == 'manifest' and key.endswith('manifest.json'))
                or (failure == 'replacement' and key == case.reference.objectKey)
                or (failure == 'completion' and key.endswith('manifest.json') and json.loads(payload)['completed'])):
            raise OSError('synthetic disk failure')
        original_write(key, payload)

    monkeypatch.setattr(case.store, '_write', write)
    with pytest.raises(OSError, match='synthetic disk failure'):
        await source_repair.source_operation(case.db, case.thread_id, case.replacement)
    quarantine = next((case.store.root / '.quarantine/source-repair').iterdir())
    assert (quarantine / 'original').read_bytes() == b'oops'
    assert case.source.read_bytes() == (b'quiz' if failure == 'completion' else b'oops')
    if failure != 'manifest':
        assert not json.loads((quarantine / 'manifest.json').read_text())['completed']
    assert case.locks[-1] == 'released'


async def test_source_maintenance_refuses_live_owner_or_unapproved_mode(repair_case, monkeypatch):
    case = repair_case
    monkeypatch.setenv('AI_MAINTENANCE_MODE', 'false')
    with pytest.raises(RuntimeError, match='MAINTENANCE'):
        await source_repair.source_operation(case.db, case.thread_id, case.replacement)
    assert not case.locks
    case.db.check_schema.assert_not_awaited()
    monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')

    @asynccontextmanager
    async def owned(_):
        raise RuntimeError('Stop the service before offline maintenance')
        yield

    monkeypatch.setattr(source_repair, 'exclusive', owned)
    with pytest.raises(RuntimeError, match='Stop the service'):
        await source_repair.source_operation(case.db, case.thread_id, case.replacement)
    assert case.source.read_bytes() == b'quiz'
    case.db.check_schema.assert_not_awaited()


async def test_source_maintenance_requires_retained_task_and_valid_schema(repair_case):
    case = repair_case
    with pytest.raises(ValueError, match='canonical'):
        await source_repair.source_operation(case.db, case.thread_id.upper())
    case.db.rows.return_value = []
    with pytest.raises(ValueError, match='not found'):
        await source_repair.source_operation(case.db, case.thread_id)
    case.db.check_schema.side_effect = RuntimeError('incompatible schema')
    with pytest.raises(RuntimeError, match='schema'):
        await source_repair.source_operation(case.db, case.thread_id)


async def test_source_maintenance_rejects_missing_storage_root(repair_case):
    case = repair_case
    case.store.root = case.store.root.parent / 'missing-mount'
    with pytest.raises(ValueError, match='storage directory'):
        await source_repair.source_operation(case.db, case.thread_id, case.replacement)
    assert not case.store.root.exists()


async def test_manage_dispatches_explicit_source_maintenance(repair_case, monkeypatch, capsys):
    case = repair_case
    case.db.open, case.db.close = AsyncMock(), AsyncMock()
    monkeypatch.setattr(manage, 'Database', lambda: case.db)
    await manage.run('verify-source', thread_id=case.thread_id)
    assert json.loads(capsys.readouterr().out)['status'] == 'verified'
    case.source.write_bytes(b'oops')
    with pytest.raises(SystemExit) as error:
        await manage.run('verify-source', thread_id=case.thread_id)
    assert error.value.code == 1 and json.loads(capsys.readouterr().out)['status'] == 'corrupt'
    await manage.run('repair-source', thread_id=case.thread_id, source=case.replacement)
    assert json.loads(capsys.readouterr().out)['status'] == 'repaired'
    with pytest.raises(ValueError, match='requires'):
        await manage.run('repair-source', thread_id=case.thread_id)
    case.db.close.assert_awaited()


@pytest.mark.parametrize('arguments', [
    ['verify-source'], ['repair-source', '--thread-id', 'task'],
    ['verify-source', '--thread-id', 'task', '--source', 'original'],
])
def test_source_cli_rejects_incomplete_or_inapplicable_arguments(monkeypatch, arguments):
    monkeypatch.setattr(sys, 'argv', ['manage', *arguments])
    with pytest.raises(SystemExit) as error:
        manage.main()
    assert error.value.code == 2


@pytest.mark.usefixtures('disposable_databases')
async def test_source_repair_uses_real_maintenance_fences_without_mutating_task_records(tmp_path, monkeypatch):
    from tests.db_support import new_database

    monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')
    store = object_store(tmp_path / 'files')
    reference = await store.put_document(b'quiz', upload())
    monkeypatch.setattr(source_repair, 'get_object_store', lambda: store)
    db = await new_database()
    thread_id = str(uuid4())
    async with db.transaction() as conn:
        await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) VALUES(%s,%s,%s,%s,%s,now()+interval '180 days')",
                           (thread_id, 'a' * 64, 'document_parser', json.dumps(reference.model_dump(mode='json')), 'return_partial'))
    before = await db.rows('SELECT * FROM document_tasks')
    source = store._path(reference.objectKey)
    source.write_bytes(b'oops')
    replacement = tmp_path / 'original.txt'
    replacement.write_bytes(b'quiz')
    for slot in (1, 3):
        owner = await db.acquire(slot=slot)
        try:
            with pytest.raises(RuntimeError, match='Stop the'):
                await source_repair.source_operation(db, thread_id, replacement)
            assert source.read_bytes() == b'oops'
            assert not (store.root / '.quarantine').exists()
        finally:
            await owner.close()
    assert (await source_repair.source_operation(db, thread_id, replacement))['status'] == 'repaired'
    assert await db.rows('SELECT * FROM document_tasks') == before
    assert not await db.rows('SELECT * FROM document_runs')
    assert not await db.rows('SELECT * FROM grade_calls')
