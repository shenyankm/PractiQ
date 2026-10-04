"""Export a completed parser result in the existing portable desktop bank format."""

import asyncio
import io
import json
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from PIL import Image
from pydantic import ValidationError

from .contracts import (
    ArtifactReference,
    DocumentParseResult,
    DocumentProcessing,
    DocumentReference,
    DocumentTaskDetail,
    document_source_key,
)
from .errors import DocumentProcessingError
from .storage import ARTIFACT_KEY_PATTERN, ObjectStore

MANIFEST_LIMIT = 64 * 1024
JSON_LIMIT = 32 * 1024 * 1024
RESOURCE_LIMIT = 25 * 1024 * 1024
RESOURCES_LIMIT = 256 * 1024 * 1024
ZIP_LIMIT = 300 * 1024 * 1024
ENTRY_LIMIT = 2002
IMAGE_MEDIA = {"image/png", "image/jpeg"}
AUDIO_MEDIA = {"audio/mpeg", "audio/mp4", "audio/aac", "audio/wav"}


def _invalid(message: str) -> DocumentProcessingError:
    return DocumentProcessingError(422, message, "BANK_EXPORT_INVALID")


def _limit(size: int, maximum: int, label: str) -> None:
    if size > maximum:
        raise DocumentProcessingError(413, f"{label} exceeds desktop package limit", "BANK_EXPORT_TOO_LARGE")


def _json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def _references(result: DocumentParseResult, source: DocumentReference) -> dict[str, ArtifactReference]:
    candidates = [(ref, IMAGE_MEDIA) for visual in result.visualElements for ref in (visual.imageRef, visual.sourceRef) if ref]
    candidates.extend((question.audioRef, AUDIO_MEDIA) for question in result.questions if question.audioRef)
    references: dict[str, ArtifactReference] = {}
    for reference, media in candidates:
        key = reference.objectKey
        if "\\" in key or ":" in key or any(ord(character) < 32 for character in key) or any(part in {"", ".", ".."} for part in key.split("/")):
            raise _invalid("Unsafe resource ZIP path")
        if reference.mediaType not in media:
            raise _invalid("Unsupported packaged resource media type")
        if key == source.objectKey:
            if any(getattr(reference, field) != getattr(source, field) for field in ("sha256", "sizeBytes", "mediaType")):
                raise _invalid("Resource metadata differs from the task source")
        elif ARTIFACT_KEY_PATTERN.fullmatch(key) is None or not key.startswith(f"practiq-agent/artifacts/{source.sha256}/"):
            raise _invalid("Resource is outside the task source namespace")
        name = f"resources/{key}"
        old = references.get(name)
        if old is not None and old.model_dump() != reference.model_dump():
            raise _invalid("Conflicting packaged resource references")
        _limit(reference.sizeBytes, RESOURCE_LIMIT, "Resource")
        references[name] = reference
    _limit(len(references) + 2, ENTRY_LIMIT, "ZIP entry count")
    _limit(sum(reference.sizeBytes for reference in references.values()), RESOURCES_LIMIT, "Expanded resources")
    return references


def _image(reference: ArtifactReference, payload: bytes) -> None:
    if reference.mediaType in IMAGE_MEDIA:
        try:
            with Image.open(io.BytesIO(payload)) as image:
                if Image.MIME.get(image.format or "") != reference.mediaType:
                    raise ValueError("Image format does not match its media type")
                if not (0 < image.width <= 16_384 and 0 < image.height <= 16_384) or image.width * image.height > 32_000_000:
                    raise ValueError("Image dimensions exceed desktop limits")
                image.verify()
            with Image.open(io.BytesIO(payload)) as image:
                image.load()
        except Exception as exc:
            raise _invalid("Invalid packaged image content") from exc


def _zip(manifest: bytes, questions: bytes, resources: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with ZipFile(buffer, "w", compression=ZIP_DEFLATED) as archive:
        for name, payload in [("manifest.json", manifest), ("questions.json", questions), *sorted(resources.items())]:
            entry = ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = 0o100600 << 16
            entry.compress_type = ZIP_DEFLATED
            archive.writestr(entry, payload)
            _limit(buffer.tell(), ZIP_LIMIT, "ZIP")
    _limit(buffer.tell(), ZIP_LIMIT, "ZIP")
    return buffer.getvalue()


async def export_task_bank(
    detail: DocumentTaskDetail,
    store: ObjectStore,
    *,
    source: DocumentReference,
    title: str | None = None,
    description: str = "",
) -> bytes:
    """Package a caller-authorized current task snapshot without running a model.

    The caller obtains ``source`` from that task's authoritative record. Resource
    ownership is checked against its source SHA, then ObjectStore verifies every
    declared object. Desktop import retains its full image/audio validation.
    """
    if detail.state != "COMPLETED" or not detail.checkpointId or detail.result is None or detail.status is None:
        raise DocumentProcessingError(409, "Task has no completed current result", "BANK_EXPORT_NOT_READY")
    if source.objectKey != document_source_key(source.sourceType, source.sha256):
        raise _invalid("Task source is outside managed storage")
    if title is None:
        file_name = source.fileName or detail.fileName
        stem = file_name.rsplit(".", 1)[0]
        title = stem if stem.strip() else file_name
    if not title.strip() or len(title) > 255 or len(description) > 20_000:
        raise _invalid("Invalid bank metadata")
    try:
        result = DocumentParseResult.model_validate(detail.result.model_dump(mode="json"))
        processing = DocumentProcessing.model_validate(detail.processing.model_dump(mode="json")) if detail.processing else None
    except ValidationError as exc:
        raise _invalid("Task result does not satisfy the shared result contract") from exc
    if processing:
        ids = {question.id for question in result.questions}
        if any(item.questionId not in ids for item in [*processing.questionSources, *processing.quality.issues]):
            raise _invalid("Processing does not reference the current result")
    manifest = _json({"format": "practiq-question-bank", "version": 2, "bank": {"title": title, "description": description}})
    questions = _json({"status": detail.status, "result": result.model_dump(mode="json"),
                       "processing": processing.model_dump(mode="json") if processing else None})
    _limit(len(manifest), MANIFEST_LIMIT, "Manifest JSON")
    _limit(len(questions), JSON_LIMIT, "Questions JSON")
    references = _references(result, source)
    source_payload = await store.get_verified(source)
    resources: dict[str, bytes] = {}
    for name, reference in references.items():
        payload = source_payload if reference.objectKey == source.objectKey else await store.get_verified(reference)
        await asyncio.to_thread(_image, reference, payload)
        resources[name] = payload
    return await asyncio.to_thread(_zip, manifest, questions, resources)
