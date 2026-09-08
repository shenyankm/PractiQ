import hashlib
from dataclasses import replace
from types import SimpleNamespace
from typing import Any, cast

import oss2
import pytest

from practiq_ai import storage
from practiq_ai.config import load
from practiq_ai.contracts import (
    ArtifactReference,
    DocumentReference,
    DocumentUploadRequest,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.storage import ObjectStore


class GetResult:
    def __init__(self, payload: bytes):
        self.payload = payload

    def read(self) -> bytes:
        return self.payload

    def close(self) -> None:
        pass


class Bucket:
    def __init__(self, blobs: dict[str, bytes] | None = None):
        self.blobs = blobs or {}
        self.signed: tuple[str, str, int, dict[str, str]] | None = None

    def head_object(self, key: str):
        if key not in self.blobs:
            raise oss2.exceptions.NoSuchKey(404, {}, b"", {})
        return SimpleNamespace(content_length=len(self.blobs[key]))

    def get_object(self, key: str):
        return GetResult(self.blobs[key])

    def put_object(self, key: str, payload: bytes):
        self.blobs[key] = payload

    def sign_url(
        self, method: str, key: str, expires: int, headers: dict[str, str]
    ) -> str:
        self.signed = (method, key, expires, headers)
        return f"https://example.invalid/{key}?signed=1"


def object_store(bucket: Bucket, *, source_max_bytes: int | None = None) -> ObjectStore:
    config = load()
    if source_max_bytes is not None:
        config = replace(config, source_max_bytes=source_max_bytes)
    store = ObjectStore(config)
    store._bucket = cast(Any, bucket)
    return store


async def test_binary_upload_returns_signed_put_and_dedupes_existing_object() -> None:
    payload = b"pdf"
    digest = hashlib.sha256(payload).hexdigest()
    request = DocumentUploadRequest(
        sourceType="pdf",
        fileName="quiz.pdf",
        mediaType="application/pdf",
        sizeBytes=len(payload),
        sha256=digest,
    )
    bucket = Bucket()
    store = object_store(bucket)

    pending = await store.prepare_document(request)
    assert pending.upload is not None
    assert pending.upload.method == "PUT"
    assert pending.upload.headers == {"Content-Type": "application/pdf"}
    assert bucket.signed is not None

    bucket.blobs[pending.document.objectKey] = payload
    existing = await store.prepare_document(request)
    assert existing.upload is None


async def test_upload_rejects_oversized_source_metadata() -> None:
    store = object_store(Bucket(), source_max_bytes=4)
    with pytest.raises(DocumentProcessingError) as oversized:
        await store.prepare_document(
            DocumentUploadRequest(
                sourceType="text",
                fileName="quiz.txt",
                mediaType="text/plain",
                sizeBytes=5,
                sha256=hashlib.sha256(b"12345").hexdigest(),
            )
        )
    assert oversized.value.code == "DOCUMENT_TOO_LARGE"


@pytest.mark.parametrize(
    ("size", "digest", "code"),
    (
        (2, hashlib.sha256(b"data").hexdigest(), "DOCUMENT_SIZE_MISMATCH"),
        (4, "0" * 64, "DOCUMENT_CHECKSUM_MISMATCH"),
    ),
)
async def test_read_verifies_declared_size_and_checksum(
    size: int, digest: str, code: str
) -> None:
    key = f"practiq-agent/sources/{digest}/source.pdf"
    store = object_store(Bucket({key: b"data"}))
    reference = DocumentReference(
        objectKey=key,
        sha256=digest,
        mediaType="application/pdf",
        sizeBytes=size,
        sourceType="pdf",
        fileName="quiz.pdf",
    )
    with pytest.raises(DocumentProcessingError) as exc:
        await store.get_verified(reference)
    assert exc.value.code == code


@pytest.mark.parametrize("operation", ("put", "head", "get", "sign"))
async def test_storage_failures_use_one_error_contract(operation: str) -> None:
    payload = b"data"
    digest = hashlib.sha256(payload).hexdigest()
    key = f"practiq-agent/sources/{digest}/source.pdf"
    bucket = Bucket({key: payload})
    store = object_store(bucket)

    if operation == "put":
        bucket.put_object = cast(Any, lambda *_args: (_ for _ in ()).throw(OSError()))
        action = store.put_artifact(
            payload,
            source_sha256=digest,
            kind="chunk",
            index=0,
            media_type="text/plain",
        )
    elif operation == "sign":
        bucket.blobs.clear()
        bucket.sign_url = cast(
            Any, lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError())
        )
        action = store.prepare_document(
            DocumentUploadRequest(
                sourceType="pdf",
                fileName="quiz.pdf",
                mediaType="application/pdf",
                sizeBytes=len(payload),
                sha256=digest,
            )
        )
    else:
        if operation == "head":
            bucket.head_object = cast(
                Any, lambda *_args: (_ for _ in ()).throw(OSError())
            )
        else:
            bucket.get_object = cast(
                Any, lambda *_args: (_ for _ in ()).throw(OSError())
            )
        action = store.get_verified(
            DocumentReference(
                objectKey=key,
                sha256=digest,
                mediaType="application/pdf",
                sizeBytes=len(payload),
                sourceType="pdf",
                fileName="quiz.pdf",
            )
        )

    with pytest.raises(DocumentProcessingError) as exc:
        await action
    assert exc.value.code == "OBJECT_STORE_UNAVAILABLE"


async def test_source_and_artifact_keys_are_content_addressed() -> None:
    bucket = Bucket()
    store = object_store(bucket)

    text = await store.prepare_document(
        DocumentUploadRequest(
            sourceType="text",
            fileName="quiz.txt",
            mediaType="text/plain",
            sizeBytes=4,
            sha256=hashlib.sha256(b"quiz").hexdigest(),
        )
    )
    digest = hashlib.sha256(b"quiz").hexdigest()
    assert text.document.objectKey == f"practiq-agent/sources/{digest}/source.txt"
    assert text.upload is not None

    binary = await store.prepare_document(
        DocumentUploadRequest(
            sourceType="pdf",
            fileName="quiz.pdf",
            mediaType="application/pdf",
            sizeBytes=3,
            sha256=hashlib.sha256(b"pdf").hexdigest(),
        )
    )
    assert binary.upload is not None

    artifact = await store.put_artifact(
        b"binary",
        source_sha256=digest,
        kind="raw",
        index=1,
        media_type="application/octet-stream",
    )
    assert artifact.objectKey.endswith(".bin")
    assert bucket.blobs[artifact.objectKey] == b"binary"


async def test_storage_rejects_conflicts_and_missing_objects() -> None:
    payload = b"pdf"
    digest = hashlib.sha256(payload).hexdigest()
    request = DocumentUploadRequest(
        sourceType="pdf",
        fileName="quiz.pdf",
        mediaType="application/pdf",
        sizeBytes=len(payload),
        sha256=digest,
    )
    key = f"practiq-agent/sources/{digest}/source.pdf"
    store = object_store(Bucket({key: b"wrong-size"}))
    with pytest.raises(DocumentProcessingError) as conflict:
        await store.prepare_document(request)
    assert conflict.value.code == "DOCUMENT_SIZE_MISMATCH"

    missing_store = object_store(Bucket())
    empty_digest = hashlib.sha256(b"").hexdigest()
    missing = ArtifactReference(
        objectKey=(
            f"practiq-agent/artifacts/{'a' * 64}/chunk/0-{empty_digest}.txt"
        ),
        sha256=empty_digest,
        mediaType="text/plain",
        sizeBytes=0,
    )
    with pytest.raises(DocumentProcessingError) as not_found:
        await missing_store.get_verified(missing)
    assert not_found.value.code == "OBJECT_NOT_FOUND"


async def test_read_detects_post_head_length_mismatch() -> None:
    class InconsistentBucket(Bucket):
        def head_object(self, key: str):
            return SimpleNamespace(content_length=4)

        def get_object(self, key: str):
            return GetResult(b"bad")

    digest = hashlib.sha256(b"data").hexdigest()
    reference = ArtifactReference(
        objectKey=f"practiq-agent/artifacts/{'a' * 64}/chunk/0-{digest}.txt",
        sha256=digest,
        mediaType="text/plain",
        sizeBytes=4,
    )
    with pytest.raises(DocumentProcessingError) as exc:
        await object_store(InconsistentBucket()).get_verified(reference)
    assert exc.value.code == "DOCUMENT_SIZE_MISMATCH"


@pytest.mark.parametrize(
    "object_key",
    (
        "https://example.com/artifact.txt",
        "file:///tmp/artifact.txt",
        "data:text/plain;base64,QQ==",
        "../artifact.txt",
        "other-prefix/artifact.txt",
    ),
)
async def test_storage_rejects_unmanaged_artifact_keys(object_key: str) -> None:
    with pytest.raises(DocumentProcessingError) as exc:
        await object_store(Bucket()).get_verified(
            ArtifactReference(
                objectKey=object_key,
                sha256="a" * 64,
                mediaType="text/plain",
                sizeBytes=1,
            )
        )
    assert exc.value.code == "INVALID_OBJECT_REFERENCE"


@pytest.mark.parametrize(
    ("source_sha256", "kind", "index"),
    (("../source", "chunk", 0), ("a" * 64, "../chunk", 0), ("a" * 64, "chunk", -1)),
)
async def test_storage_rejects_unmanaged_artifact_write_paths(
    source_sha256: str, kind: str, index: int
) -> None:
    with pytest.raises(DocumentProcessingError) as exc:
        await object_store(Bucket()).put_artifact(
            b"data",
            source_sha256=source_sha256,
            kind=kind,
            index=index,
            media_type="text/plain",
        )
    assert exc.value.code == "INVALID_OBJECT_REFERENCE"


async def test_storage_timeout_uses_unavailable_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def timeout(awaitable, **_kwargs):
        awaitable.close()
        raise TimeoutError

    monkeypatch.setattr(storage.asyncio, "wait_for", timeout)
    store = object_store(Bucket())
    with pytest.raises(DocumentProcessingError) as exc:
        await store.prepare_document(
            DocumentUploadRequest(
                sourceType="pdf",
                fileName="quiz.pdf",
                mediaType="application/pdf",
                sizeBytes=1,
                sha256="a" * 64,
            )
        )
    assert exc.value.code == "OBJECT_STORE_UNAVAILABLE"


@pytest.mark.parametrize(
    ("media_type", "suffix"),
    (
        ("image/png", "png"),
        ("image/jpeg", "jpg"),
        ("text/plain", "txt"),
        ("application/octet-stream", "bin"),
    ),
)
def test_artifact_suffixes(media_type: str, suffix: str) -> None:
    assert storage._suffix(media_type) == suffix
