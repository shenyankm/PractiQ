"""Content-addressed Aliyun OSS storage for source and derived artifacts."""

import asyncio
import hashlib
import re
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any, cast

import oss2

from .config import Config, load
from .contracts import (
    ArtifactReference,
    DocumentReference,
    DocumentUploadRequest,
    DocumentUploadResponse,
    SignedUpload,
    document_source_key,
)
from .errors import DocumentProcessingError

UPLOAD_URL_TTL_SECONDS = 600
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
ARTIFACT_KEY_PATTERN = re.compile(
    r"^practiq-agent/artifacts/[0-9a-f]{64}/[a-z][a-z0-9_-]{0,63}/"
    r"(?:0|[1-9][0-9]*)-([0-9a-f]{64})\.([a-z0-9]+)$"
)


class ObjectStore:
    def __init__(self, config: Config):
        self._config = config
        self._bucket = oss2.Bucket(
            oss2.Auth(config.oss_access_key_id, config.oss_access_key_secret),
            config.oss_endpoint,
            config.oss_bucket,
            connect_timeout=config.oss_timeout_seconds,
        )

    async def prepare_document(
        self, request: DocumentUploadRequest
    ) -> DocumentUploadResponse:
        assert (
            request.sha256 is not None
            and request.sizeBytes is not None
            and request.mediaType is not None
        )
        self._validate_source_size(request.sizeBytes)
        key = document_source_key(request.sourceType, request.sha256)
        existing_size = await self._head_size(key)
        if existing_size is not None and existing_size != request.sizeBytes:
            raise DocumentProcessingError(
                409,
                "Stored document size does not match upload metadata",
                "DOCUMENT_SIZE_MISMATCH",
            )
        document = DocumentReference(
            objectKey=key,
            sha256=request.sha256,
            mediaType=request.mediaType,
            sizeBytes=request.sizeBytes,
            sourceType=request.sourceType,
            fileName=request.fileName,
        )
        if existing_size is not None:
            return DocumentUploadResponse(document=document, upload=None)
        headers = {"Content-Type": request.mediaType}
        try:
            url = self._bucket.sign_url(
                "PUT", key, UPLOAD_URL_TTL_SECONDS, headers=headers
            )
        except Exception as exc:
            raise self._unavailable() from exc
        return DocumentUploadResponse(
            document=document,
            upload=SignedUpload(
                url=url,
                headers=headers,
                expiresAt=datetime.now(UTC)
                + timedelta(seconds=UPLOAD_URL_TTL_SECONDS),
            ),
        )

    async def put_document(
        self, payload: bytes, request: DocumentUploadRequest
    ) -> DocumentReference:
        prepared = await self.prepare_document(request)
        if hashlib.sha256(payload).hexdigest() != prepared.document.sha256 or len(payload) != prepared.document.sizeBytes:
            raise DocumentProcessingError(409, "Source does not match metadata", "DOCUMENT_CHECKSUM_MISMATCH")
        if prepared.upload is not None:
            await self._call(self._bucket.put_object, prepared.document.objectKey, payload)
        # The graph re-verifies even when the object already existed.
        return prepared.document

    async def put_artifact(
        self,
        payload: bytes,
        *,
        source_sha256: str,
        kind: str,
        index: int,
        media_type: str,
    ) -> ArtifactReference:
        if (
            SHA256_PATTERN.fullmatch(source_sha256) is None
            or re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", kind) is None
            or index < 0
        ):
            raise _invalid_reference()
        digest = (await asyncio.to_thread(hashlib.sha256, payload)).hexdigest()
        suffix = _suffix(media_type)
        key = f"practiq-agent/artifacts/{source_sha256}/{kind}/{index}-{digest}.{suffix}"
        await self._call(self._bucket.put_object, key, payload)
        return ArtifactReference(
            objectKey=key,
            sha256=digest,
            mediaType=media_type,
            sizeBytes=len(payload),
        )

    async def get_verified(
        self, reference: ArtifactReference | DocumentReference
    ) -> bytes:
        if isinstance(reference, DocumentReference):
            valid_reference = reference.objectKey == document_source_key(
                reference.sourceType, reference.sha256
            )
        else:
            match = ARTIFACT_KEY_PATTERN.fullmatch(reference.objectKey)
            valid_reference = bool(
                match
                and match.group(1) == reference.sha256
                and match.group(2) == _suffix(reference.mediaType)
            )
        if not valid_reference:
            raise _invalid_reference()
        size = await self._head_size(reference.objectKey)
        if size is None:
            raise DocumentProcessingError(
                404, "Stored object was not found", "OBJECT_NOT_FOUND"
            )
        if size != reference.sizeBytes:
            raise DocumentProcessingError(
                409,
                "Stored document size does not match",
                "DOCUMENT_SIZE_MISMATCH",
            )
        if isinstance(reference, DocumentReference):
            self._validate_source_size(size)
        result = await self._call(self._bucket.get_object, reference.objectKey)
        try:
            payload = cast(bytes, await self._call(result.read))
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                await asyncio.to_thread(close)
        if len(payload) != reference.sizeBytes:
            raise DocumentProcessingError(
                409,
                "Stored document size does not match",
                "DOCUMENT_SIZE_MISMATCH",
            )
        digest = (await asyncio.to_thread(hashlib.sha256, payload)).hexdigest()
        if digest != reference.sha256:
            raise DocumentProcessingError(
                409,
                "Stored document checksum does not match",
                "DOCUMENT_CHECKSUM_MISMATCH",
            )
        return payload

    def _validate_source_size(self, size: int) -> None:
        if size > self._config.source_max_bytes:
            raise DocumentProcessingError(
                413, "Uploaded file is too large", "DOCUMENT_TOO_LARGE"
            )

    async def _head_size(self, key: str) -> int | None:
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(self._bucket.head_object, key),
                timeout=self._config.oss_timeout_seconds,
            )
        except oss2.exceptions.NotFound:
            return None
        except Exception as exc:
            raise self._unavailable() from exc
        return int(result.content_length)

    async def _call(self, function: Any, *args: Any) -> Any:
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(function, *args),
                timeout=self._config.oss_timeout_seconds,
            )
        except Exception as exc:
            raise self._unavailable() from exc

    @staticmethod
    def _unavailable() -> DocumentProcessingError:
        return DocumentProcessingError(
            502, "Object storage is unavailable", "OBJECT_STORE_UNAVAILABLE"
        )


@lru_cache(maxsize=1)
def get_object_store() -> ObjectStore:
    return ObjectStore(load())


def _suffix(media_type: str) -> str:
    return {
        "image/png": "png",
        "image/jpeg": "jpg",
        "text/plain": "txt",
    }.get(media_type, "bin")


def _invalid_reference() -> DocumentProcessingError:
    return DocumentProcessingError(
        422,
        "Object reference is outside the managed OSS namespace",
        "INVALID_OBJECT_REFERENCE",
    )
