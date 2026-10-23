"""Synthetic filesystem ordering checks, not power-loss tests."""

import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from scripts import storage_gc
from tests.support import object_store


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
