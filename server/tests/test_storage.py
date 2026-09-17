import asyncio
import hashlib
from dataclasses import replace
from pathlib import Path

import pytest

from practiq_ai import storage
from practiq_ai.config import load
from practiq_ai.contracts import ArtifactReference, DocumentUploadRequest
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.storage import ObjectStore


def object_store(root: Path, **overrides) -> ObjectStore:
    return ObjectStore(replace(load(), storage_dir=root, **overrides))


def upload(payload=b"quiz"):
    return DocumentUploadRequest(sourceType="text", fileName="quiz.txt", mediaType="text/plain",
                                 sizeBytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())


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
    async def timeout(awaitable, **kwargs):
        awaitable.close()
        raise TimeoutError
    monkeypatch.setattr(storage.asyncio, 'wait_for', timeout)
    with pytest.raises(DocumentProcessingError) as error:
        await object_store(tmp_path).prepare_document(upload())
    assert error.value.code == 'OBJECT_STORE_UNAVAILABLE'
