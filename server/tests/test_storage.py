import asyncio
import threading
from pathlib import Path

import pytest

from practiq_ai import storage
from practiq_ai.contracts import ArtifactReference
from practiq_ai.errors import DocumentProcessingError
from tests.support import FakeObjectStore, object_store, upload


async def test_storage_health_checks_io_and_space_and_rejects_replaced_root(tmp_path):
    store = object_store(tmp_path / 'files')
    health = await store.health()
    assert health.healthy and health.free_bytes is not None and health.total_bytes is not None
    assert health.total_bytes >= health.free_bytes > 0
    assert list(store.root.iterdir()) == []
    store.root.rmdir()
    store.root.write_text('lost mount')
    store._health_checked_at = 0
    assert not (await store.health()).healthy
    with pytest.raises(DocumentProcessingError) as error:
        await store.require_available()
    assert error.value.status_code == 503
    assert error.value.code == 'OBJECT_STORE_UNAVAILABLE'
    assert store.root.read_text() == 'lost mount'


@pytest.mark.parametrize('failure', ['full', 'readonly', 'fsync', 'checksum', 'inodes'])
async def test_storage_health_fails_closed_and_recovers(tmp_path, monkeypatch, failure):
    import shutil
    from types import SimpleNamespace

    store = object_store(tmp_path)
    with monkeypatch.context() as patch:
        if failure == 'full':
            patch.setattr(storage.shutil, 'disk_usage', lambda _: shutil._ntuple_diskusage(100, 100, 0))
        elif failure == 'readonly':
            patch.setattr(storage.tempfile, 'TemporaryFile', lambda **_: (_ for _ in ()).throw(PermissionError('readonly')))
        elif failure == 'fsync':
            patch.setattr(storage.os, 'fsync', lambda _: (_ for _ in ()).throw(OSError('sync failed')))
        elif failure == 'checksum':
            from io import BytesIO
            class CorruptProbe(BytesIO):
                def fileno(self):
                    return 0
                def read(self, *args):
                    return b'corrupt'
            patch.setattr(storage.tempfile, 'TemporaryFile', lambda **_: CorruptProbe())
            patch.setattr(storage.os, 'fsync', lambda _: None)
        else:
            patch.setattr(storage.os, 'statvfs', lambda _: SimpleNamespace(f_files=100, f_favail=0, f_frsize=4096, f_blocks=100, f_bfree=10, f_bavail=10), raising=False)
        assert not (await store.health()).healthy
        with pytest.raises(DocumentProcessingError):
            await store.require_available()
    store._health_checked_at = 0
    assert (await store.health()).healthy


async def test_storage_health_coalesces_probes_and_bounds_stuck_io(tmp_path, monkeypatch):
    store = object_store(tmp_path, storage_timeout_seconds=0.02, storage_concurrency=1)
    original = store._probe
    probes = []
    def counted():
        probes.append(1)
        return original()
    monkeypatch.setattr(store, '_probe', counted)
    assert all(item.healthy for item in await asyncio.gather(*(store.health() for _ in range(20))))
    assert len(probes) == 1
    release = threading.Event()
    store._health_checked_at = 0
    monkeypatch.setattr(store, '_probe', lambda: release.wait(5))
    try:
        assert not (await store.health()).healthy
        assert store._slots.locked()
        with pytest.raises(DocumentProcessingError):
            await store.require_available()
    finally:
        release.set()
        await asyncio.to_thread(store._executor.shutdown)


async def test_local_source_upload_dedup_restart_and_artifacts(tmp_path):
    store = object_store(tmp_path)
    pending = await store.prepare_document(upload())
    assert pending.upload is not None
    assert pending.upload.url.startswith('/api/uploads/content?')
    reference = await store.put_document(b"quiz", upload())
    assert (await store.prepare_document(upload())).upload is None
    assert await object_store(tmp_path).get_verified(reference) == b"quiz"
    artifacts = await asyncio.gather(*(store.put_artifact(b"text", source_sha256=reference.sha256,
        kind="chunk", index=0, media_type="text/plain") for _ in range(8)))
    assert len({a.objectKey for a in artifacts}) == 1
    assert await store.get_verified(artifacts[0]) == b"text"
    assert sorted(p.name for p in (tmp_path / artifacts[0].objectKey).parent.iterdir()) == [Path(artifacts[0].objectKey).name]


@pytest.mark.parametrize('payload,code', [
    (b'quiz', None),
    (b'wrong-size', 'DOCUMENT_SIZE_MISMATCH'),
    (b'oops', 'DOCUMENT_CHECKSUM_MISMATCH'),
])
async def test_fake_store_preserves_payload_verification(payload, code):
    reference = upload()
    assert reference.sha256 is not None and reference.sizeBytes is not None
    store = FakeObjectStore({'fixture': payload})
    ref = ArtifactReference(objectKey='fixture', sha256=reference.sha256,
                            mediaType='text/plain', sizeBytes=reference.sizeBytes)
    if code is None:
        assert await store.get_verified(ref) == payload
    else:
        with pytest.raises(DocumentProcessingError) as error:
            await store.get_verified(ref)
        assert error.value.code == code


async def test_checksums_sizes_missing_and_limits(tmp_path):
    store = object_store(tmp_path)
    ref = await store.put_document(b"quiz", upload())
    path = tmp_path / ref.objectKey
    for payload, code in [(b"wrong-size", "DOCUMENT_SIZE_MISMATCH"), (b"oops", "DOCUMENT_CHECKSUM_MISMATCH")]:
        path.write_bytes(payload)
        with pytest.raises(DocumentProcessingError) as error:
            await store.get_verified(ref)
        assert error.value.code == code
    with pytest.raises(DocumentProcessingError, match="checksum"):
        await store.put_document(b"quiz", upload())
    path.unlink()
    with pytest.raises(DocumentProcessingError) as error:
        await store.get_verified(ref)
    assert error.value.code == "OBJECT_NOT_FOUND"
    with pytest.raises(DocumentProcessingError) as error:
        await object_store(tmp_path, source_max_bytes=3).put_document(b"quiz", upload())
    assert error.value.status_code == 413
    with pytest.raises(DocumentProcessingError) as error:
        await store.put_document(b"oops", upload())
    assert error.value.code == "DOCUMENT_CHECKSUM_MISMATCH"
    assert not path.exists()


@pytest.mark.parametrize('key', ['../outside', '/tmp/file', 'file:///tmp/file', 'https://example.com/file', 'other/file'])
async def test_rejects_unmanaged_read_paths(tmp_path, key):
    with pytest.raises(DocumentProcessingError) as error:
        await object_store(tmp_path).get_verified(ArtifactReference(objectKey=key, sha256='a'*64,
            mediaType='text/plain', sizeBytes=1))
    assert error.value.code == 'INVALID_OBJECT_REFERENCE'


@pytest.mark.parametrize('digest,kind,index', [('../source','chunk',0),('a'*64,'../chunk',0),('a'*64,'chunk',-1)])
async def test_rejects_unmanaged_write_paths(tmp_path, digest, kind, index):
    with pytest.raises(DocumentProcessingError) as error:
        await object_store(tmp_path).put_artifact(b'x', source_sha256=digest, kind=kind, index=index, media_type='text/plain')
    assert error.value.code == 'INVALID_OBJECT_REFERENCE'


async def test_rejects_symlink_escape(tmp_path):
    root = tmp_path / 'storage'
    root.mkdir()
    (root / 'practiq-agent').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(DocumentProcessingError) as error:
        await object_store(root).put_document(b'quiz', upload())
    assert error.value.code == 'INVALID_OBJECT_REFERENCE'


async def test_atomic_failure_keeps_old_file_and_cleans_temporary(tmp_path, monkeypatch):
    store = object_store(tmp_path)
    ref = await store.put_document(b'quiz', upload())
    def fail(*args):
        raise OSError('disk full')
    monkeypatch.setattr(storage.os, 'replace', fail)
    with pytest.raises(DocumentProcessingError) as error:
        await store._call(store._write, ref.objectKey, b'new')
    assert error.value.code == 'OBJECT_STORE_UNAVAILABLE'
    assert await store.get_verified(ref) == b'quiz'
    assert len(list((tmp_path / ref.objectKey).parent.iterdir())) == 1


async def test_storage_timeout(tmp_path, monkeypatch):
    store = object_store(tmp_path, storage_timeout_seconds=0.01)
    release = threading.Event()
    monkeypatch.setattr(store, '_size', lambda *_: release.wait(5))
    try:
        with pytest.raises(DocumentProcessingError) as error:
            await store.prepare_document(upload())
        assert error.value.code == 'OBJECT_STORE_UNAVAILABLE'
    finally:
        release.set()
        await asyncio.to_thread(store._executor.shutdown)


async def test_directory_sync_failure_does_not_return_a_reference(tmp_path, monkeypatch):
    import stat
    sync = storage.os.fsync
    def fail_directory(fd):
        if stat.S_ISDIR(storage.os.fstat(fd).st_mode):
            raise OSError('directory sync failed')
        sync(fd)
    monkeypatch.setattr(storage.os, 'fsync', fail_directory)
    with pytest.raises(DocumentProcessingError, match='Object storage'):
        await object_store(tmp_path).put_artifact(b'image', source_sha256='a'*64,
            kind='embedded', index=0, media_type='image/png')
    # A completed file may remain orphaned, but no committed reference is returned.
    assert len(list(tmp_path.rglob('*.png'))) == 1
