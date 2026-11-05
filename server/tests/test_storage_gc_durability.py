"""Synthetic filesystem ordering checks, not power-loss tests."""

import asyncio
import hashlib
import json
import multiprocessing
import os
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from practiq_ai.contracts import ArtifactReference
from practiq_ai.errors import DocumentProcessingError
from scripts import storage_gc
from tests.support import object_store, upload


def publication_child(directory, mode, phase, ready):
    from practiq_ai import storage

    store = object_store(Path(directory))
    payload = b'Interrupted local publication'
    def stop_before_publish(name: str, path: Path | None) -> None:
        ready.send(name)
        threading.Event().wait(30)
    store._publish = stop_before_publish
    if phase == 'created':
        create = storage.tempfile.NamedTemporaryFile
        def stop_on_create(*args, **kwargs):
            target = create(*args, **kwargs)
            stop_before_publish(target.name, None)
            return target
        storage.tempfile.NamedTemporaryFile = stop_on_create
    async def write():
        if mode == 'artifact':
            await store.put_artifact(payload, source_sha256=hashlib.sha256(payload).hexdigest(),
                                     kind='text', index=1, media_type='text/plain')
        else:
            async def chunks():
                yield payload
            await store.put_document_stream(chunks(), upload(payload))
    asyncio.run(write())


@pytest.mark.parametrize('mode', ['artifact', 'upload'])
@pytest.mark.parametrize('phase', ['created', 'before-publish'])
async def test_killed_publication_can_be_quarantined_without_removing_live_source_files(tmp_path, monkeypatch, mode, phase):
    store = object_store(tmp_path / 'files')
    payload = b'Interrupted local publication'
    source = hashlib.sha256(payload).hexdigest()
    kept = await store.put_artifact(b'kept', source_sha256=source, kind='text', index=0, media_type='text/plain')
    context = multiprocessing.get_context('spawn')
    receive, send = context.Pipe(duplex=False)
    child = context.Process(target=publication_child, args=(store.root, mode, phase, send))
    child.start()
    send.close()
    try:
        assert await asyncio.to_thread(receive.poll, 10)
        pending = Path(receive.recv())
        child.kill()
        await asyncio.to_thread(child.join, 10)
        assert child.exitcode is not None and child.exitcode != 0
    finally:
        if child.is_alive():
            child.kill()
            child.join(10)
        receive.close()
    retained = b'' if phase == 'created' else payload
    assert pending.read_bytes() == retained
    os.utime(pending, (0, 0))
    os.utime(store.root / kept.objectKey, (0, 0))
    monkeypatch.setattr(storage_gc, 'get_object_store', lambda: store)
    monkeypatch.setattr(storage_gc, 'live_sources', AsyncMock(return_value={source}))
    args = SimpleNamespace(output=tmp_path / 'inventory.json', retention_days=187, quarantine=True)
    result = await storage_gc.scan(args, None)
    assert result['completed'] and result['objects'] == 1
    key = pending.relative_to(store.root).as_posix()
    assert result['candidates'][0]['key'] == key
    assert not pending.exists()
    assert (store.root / '.quarantine' / result['runId'] / key).read_bytes() == retained
    assert await object_store(store.root).get_verified(kept) == b'kept'
    args.output = tmp_path / 'second-inventory.json'
    assert (await storage_gc.scan(args, None))['objects'] == 0


@pytest.mark.parametrize('name,recognized', [
    ('.practiq-pending-abc_0123', True),
    ('.practiq-pending-short', False),
    ('.practiq-pending-abcdefgh.json', False),
    ('tmpabcdefgh', False),
    ('source.txt', False),
])
@pytest.mark.parametrize('modified', [0, 10])
def test_cleanup_retains_recent_pending_and_unrecognized_files_for_live_sources(name, recognized, modified):
    item = {'key': f'practiq-agent/sources/{"a" * 64}/{name}', 'modified': modified}
    selected = storage_gc.candidates([item], {'a' * 64}, 10)
    assert selected == ([item] if recognized and modified < 10 else [])


async def test_pending_file_name_cannot_be_a_verified_public_reference(tmp_path):
    key = f'practiq-agent/artifacts/{"a" * 64}/text/.practiq-pending-abcdefgh'
    reference = ArtifactReference(objectKey=key, sha256=hashlib.sha256(b'pending').hexdigest(),
                                  mediaType='text/plain', sizeBytes=7)
    with pytest.raises(DocumentProcessingError) as error:
        await object_store(tmp_path).get_verified(reference)
    assert error.value.code == 'INVALID_OBJECT_REFERENCE'


@pytest.fixture
async def gc_case(tmp_path, monkeypatch):
    store = object_store(tmp_path / 'store')
    for index in range(2):
        reference = await store.put_artifact(
            f'old-{index}'.encode(), source_sha256='a' * 64,
            kind='text', index=index, media_type='text/plain',
        )
        os.utime(store._path(reference.objectKey), (0, 0))
    monkeypatch.setattr(storage_gc, 'get_object_store', lambda: store)
    monkeypatch.setattr(storage_gc, 'live_sources', AsyncMock(return_value=set()))
    args = SimpleNamespace(output=tmp_path / 'reports' / 'nested' / 'inventory.json',
                           retention_days=187, quarantine=True)
    return store, args


@pytest.fixture
def filesystem_events(monkeypatch):
    if os.name == 'nt':
        pytest.skip('POSIX directory synchronization')
    events = []
    directories = {}
    original_open, original_sync, original_close = os.open, os.fsync, os.close
    original_rename, original_replace, original_dump = Path.rename, os.replace, json.dump

    def open_file(path, flags, *args, **kwargs):
        descriptor = original_open(path, flags, *args, **kwargs)
        if flags & os.O_DIRECTORY:
            directories[descriptor] = Path(path)
        return descriptor

    def sync(descriptor):
        events.append(('sync', directories[descriptor]) if descriptor in directories else ('file-sync',))
        original_sync(descriptor)

    def close(descriptor):
        directories.pop(descriptor, None)
        original_close(descriptor)

    def rename(source, target):
        events.append(('move', source, target))
        return original_rename(source, target)

    def replace(source, target):
        events.append(('replace', Path(target)))
        return original_replace(source, target)

    def dump(value, *args, **kwargs):
        if value.get('completed'):
            events.append(('complete',))
        return original_dump(value, *args, **kwargs)

    monkeypatch.setattr(os, 'open', open_file)
    monkeypatch.setattr(os, 'fsync', sync)
    monkeypatch.setattr(os, 'close', close)
    monkeypatch.setattr(Path, 'rename', rename)
    monkeypatch.setattr(os, 'replace', replace)
    monkeypatch.setattr(json, 'dump', dump)
    return events


async def test_storage_gc_syncs_inventory_ancestry_and_moves_before_completion(gc_case, filesystem_events):
    store, args = gc_case
    events = filesystem_events
    result = await storage_gc.scan(args, None)
    moves = [event for event in events if event[0] == 'move']
    assert len(moves) == 2
    before_move = events[:events.index(moves[0])]
    assert ('file-sync',) in before_move
    assert before_move.index(('file-sync',)) < before_move.index(('sync', args.output.parent))
    for directory in (args.output.parent, args.output.parent.parent, args.output.parent.parent.parent):
        assert ('sync', directory) in before_move
    completed = events.index(('complete',))
    for move in moves:
        _, source, target = move
        after_move = events[events.index(move) + 1:completed]
        assert ('sync', source.parent) in after_move
        assert ('sync', target.parent) in after_move
        for directory in target.parent.parents:
            if not directory.is_relative_to(store.root):
                break
            assert ('sync', directory) in events[:events.index(move)]
        assert target.read_bytes().startswith(b'old-')
        assert not source.exists()
    assert events[-4:] == [('complete',), ('file-sync',), ('replace', args.output), ('sync', args.output.parent)]
    assert json.loads(args.output.read_text()) == result
    assert result['completed']


@pytest.mark.parametrize('ancestor', [False, True])
async def test_storage_gc_initial_directory_sync_failure_prevents_moves(
    gc_case, filesystem_events, monkeypatch, ancestor,
):
    store, args = gc_case
    original_sync = storage_gc._sync_directory
    failed = args.output.parent.parent.parent if ancestor else args.output.parent

    def fail(directory):
        if directory == failed:
            raise OSError('initial directory sync failed')
        original_sync(directory)

    monkeypatch.setattr(storage_gc, '_sync_directory', fail)
    with pytest.raises(OSError, match='initial directory sync failed'):
        await storage_gc.scan(args, None)
    assert not any(event[0] == 'move' for event in filesystem_events)
    assert len(storage_gc.inventory(store)) == 2
    if not ancestor:
        manifest = json.loads(args.output.read_text())
        assert not manifest['completed'] and len(manifest['candidates']) == 2


@pytest.mark.parametrize('failure', ['second-move', 'source-sync', 'target-sync', 'quarantine-ancestry'])
async def test_storage_gc_partial_failure_keeps_incomplete_inventory(
    gc_case, filesystem_events, monkeypatch, failure,
):
    store, args = gc_case
    original_sync, original_rename = storage_gc._sync_directory, Path.rename
    moved = []

    def rename(source, target):
        if failure == 'second-move' and moved:
            raise OSError('quarantine failed')
        result = original_rename(source, target)
        moved.append((source, target))
        return result

    def sync(directory):
        if ((failure == 'source-sync' and moved and directory == moved[-1][0].parent)
                or (failure == 'target-sync' and moved and directory == moved[-1][1].parent)
                or (failure == 'quarantine-ancestry' and directory == store.root)):
            raise OSError('quarantine failed')
        original_sync(directory)

    monkeypatch.setattr(Path, 'rename', rename)
    monkeypatch.setattr(storage_gc, '_sync_directory', sync)
    with pytest.raises(OSError, match='quarantine failed'):
        await storage_gc.scan(args, None)
    manifest = json.loads(args.output.read_text())
    assert not manifest['completed'] and len(manifest['candidates']) == 2
    assert len(moved) == (0 if failure == 'quarantine-ancestry' else 1)
    assert ('complete',) not in filesystem_events
    for item in manifest['candidates']:
        source = store._path(item['key'])
        target = store.root / '.quarantine' / manifest['runId'] / item['key']
        assert source.exists() != target.exists()
        assert (source if source.exists() else target).read_bytes().startswith(b'old-')


async def test_storage_gc_final_directory_sync_failure_is_reported(gc_case, filesystem_events, monkeypatch):
    store, args = gc_case
    original_sync = storage_gc._sync_directory

    def sync(directory):
        if ('replace', args.output) in filesystem_events:
            raise OSError('final directory sync failed')
        original_sync(directory)

    monkeypatch.setattr(storage_gc, '_sync_directory', sync)
    with pytest.raises(OSError, match='final directory sync failed'):
        await storage_gc.scan(args, None)
    # Replacement may already be visible, but all moves passed their barriers first.
    assert json.loads(args.output.read_text())['completed']
    assert not storage_gc.inventory(store)
    assert list(args.output.parent.iterdir()) == [args.output]


def test_storage_gc_directory_sync_closes_descriptor_on_failure(tmp_path, monkeypatch):
    opened, closed = [], []
    monkeypatch.setattr(storage_gc.os, 'name', 'posix')
    monkeypatch.setattr(storage_gc.os, 'O_DIRECTORY', 0x10000, raising=False)
    monkeypatch.setattr(storage_gc.os, 'open', lambda *args: opened.append(args) or 123)
    monkeypatch.setattr(storage_gc.os, 'close', closed.append)

    def fail(descriptor):
        assert descriptor == 123
        raise OSError('sync failed')

    monkeypatch.setattr(storage_gc.os, 'fsync', fail)
    with pytest.raises(OSError, match='sync failed'):
        storage_gc._sync_directory(tmp_path)
    assert opened == [(tmp_path, os.O_RDONLY | os.O_DIRECTORY)]
    assert closed == [123]


def test_storage_gc_directory_sync_windows_guard(tmp_path, monkeypatch):
    with monkeypatch.context() as patch:
        patch.setattr(storage_gc.os, 'name', 'nt')

        def forbidden(*args):
            pytest.fail('Windows must not attempt POSIX directory synchronization')

        patch.setattr(storage_gc.os, 'open', forbidden)
        patch.setattr(storage_gc.os, 'fsync', forbidden)
        patch.setattr(storage_gc.os, 'close', forbidden)
        storage_gc._sync_directory(tmp_path)
