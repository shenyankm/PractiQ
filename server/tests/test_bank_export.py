"""Portable bank export uses the existing desktop ZIP and result contracts."""

import hashlib
import io
import json
import wave
from pathlib import Path
from zipfile import ZipFile

import pytest
from PIL import Image

from practiq_ai import bank_export
from practiq_ai.contracts import DocumentParseResult, DocumentTaskDetail
from practiq_ai.errors import DocumentProcessingError
from tests.support import make_image, object_store, upload


def detail(result=None, **changes):
    result = result or {
        "schemaVersion": 3, "questions": [{"id": "q", "stem": "Keep null answer", "sourceText": "Source text",
        "answerMode": "short_answer", "questionTypeId": None, "items": [], "options": [], "answerPayload": None,
        "contentBlocks": [], "confidence": 0.5, "needsReview": True, "missingFields": ["answerPayload"]}],
        "groups": [{"title": "Section", "instructions": None, "questionIds": ["q"]}],
        "visualElements": [], "warnings": ["Not all supplied answers were available"], "confidenceScore": 50,
        "missingFields": ["media"],
    }
    data = {
        "threadId": "11111111-1111-4111-8111-111111111111", "runId": None, "parentThreadId": None,
        "modelConfigured": False, "resumeCompatible": False, "fileName": "试卷.txt", "state": "COMPLETED",
        "phase": "completed", "checkpointId": "current-result", "updatedAt": "2026-10-04", "expiresAt": "2026-10-05",
        "allowedActions": [], "failures": [], "blocking": [],
        "progress": {"visuals": {"total": 0, "succeeded": 0, "failed": 0, "remaining": 0},
                     "chunks": {"total": 1, "succeeded": 1, "failed": 0, "remaining": 0}},
        "status": "PARTIAL", "result": result, "modelBudget": {"limit": 1, "reserved": 1}, "processing": None,
        "usage": [], "unknownUsageCalls": [],
    }
    data.update(changes)
    return DocumentTaskDetail.model_validate(data)


async def source_store(tmp_path):
    store = object_store(tmp_path)
    source = await store.put_document(b"quiz", upload())
    return store, source


def parsed(task: DocumentTaskDetail) -> DocumentParseResult:
    assert task.result is not None
    return task.result


def unpack(payload):
    with ZipFile(io.BytesIO(payload)) as archive:
        return {entry.filename: archive.read(entry) for entry in archive.infolist()}


async def test_export_preserves_partial_nulls_tree_and_only_portable_task_fields(tmp_path):
    store, source = await source_store(tmp_path)
    root = json.loads((Path(__file__).parents[2] / "app/fixtures/composite.json").read_text())
    task = detail(root)
    payload = await bank_export.export_task_bank(task, store, source=source, title="课程", description="供离线追加")
    files = unpack(payload)
    assert set(files) == {"manifest.json", "questions.json"}
    assert json.loads(files["manifest.json"]) == {
        "format": "practiq-question-bank", "version": 2, "bank": {"title": "课程", "description": "供离线追加"},
    }
    output = json.loads(files["questions.json"])
    assert output == {"status": "PARTIAL", "result": parsed(task).model_dump(mode="json"), "processing": None}
    assert DocumentParseResult.model_validate(output["result"]) == task.result
    assert "usage" not in output and "threadId" not in output and "document" not in output
    with ZipFile(io.BytesIO(payload)) as archive:
        assert all(not entry.is_dir() and entry.create_system == 3 and entry.external_attr >> 16 & 0o170000 == 0o100000 for entry in archive.infolist())


async def test_export_defaults_to_full_filename_when_dot_extension_has_no_stem(tmp_path):
    store = object_store(tmp_path)
    source = await store.put_document(b"quiz", upload().model_copy(update={"fileName": ".txt"}))
    files = unpack(await bank_export.export_task_bank(detail(), store, source=source))
    assert json.loads(files["manifest.json"])["bank"]["title"] == ".txt"
    assert json.loads(files["questions.json"])["status"] == "PARTIAL"


async def test_export_includes_deduplicated_images_full_source_ref_and_audio(tmp_path):
    store, source = await source_store(tmp_path)
    image = await store.put_artifact(make_image(), source_sha256=source.sha256, kind="visual", index=0, media_type="image/png")
    wav = io.BytesIO()
    with wave.open(wav, "wb") as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(8000); audio.writeframes(b"\0\0" * 800)
    sound = await store.put_artifact(wav.getvalue(), source_sha256=source.sha256, kind="audio", index=0, media_type="audio/wav")
    root = parsed(detail()).model_dump(mode="json")
    root["questions"][0].update(answerMode="listening", questionKind="listening", audioRef=sound.model_dump(mode="json"), passage=[])
    root["visualElements"] = [{"kind": "image", "description": "Source figure with answers", "questionIds": ["q"],
        "imageRef": image.model_dump(mode="json"), "sourceRef": image.model_dump(mode="json")}]
    task = detail(root)
    files = unpack(await bank_export.export_task_bank(task, store, source=source))
    assert set(files) == {"manifest.json", "questions.json", f"resources/{image.objectKey}", f"resources/{sound.objectKey}"}
    result = json.loads(files["questions.json"])["result"]
    assert result == parsed(task).model_dump(mode="json")
    for reference in [image, sound]:
        data = files[f"resources/{reference.objectKey}"]
        assert hashlib.sha256(data).hexdigest() == reference.sha256 and len(data) == reference.sizeBytes


@pytest.mark.parametrize("changes", [{"state": s} for s in ["RUNNING", "PAUSED", "FAILED", "WAITING_REVIEW", "EXPIRED"]] + [{"checkpointId": None}, {"checkpointId": ""}, {"result": None}, {"status": None}])
async def test_export_requires_a_completed_current_result_before_storage_read(tmp_path, changes, monkeypatch):
    store, source = await source_store(tmp_path)
    async def forbidden(_reference):
        raise AssertionError("Storage should not be read for an unavailable result")
    monkeypatch.setattr(store, "get_verified", forbidden)
    with pytest.raises(DocumentProcessingError) as error:
        await bank_export.export_task_bank(detail().model_copy(update=changes), store, source=source)
    assert error.value.status_code == 409 and error.value.code == "BANK_EXPORT_NOT_READY"


@pytest.mark.parametrize("key", ["../escape.png", "/absolute.png", "folder\\escape.png", "https://example.com/image.png", "C:/image.png", "a//b", "a/./b"])
async def test_export_rejects_unsafe_or_unmanaged_resource_keys(tmp_path, key):
    store, source = await source_store(tmp_path)
    image = await store.put_artifact(make_image(), source_sha256=source.sha256, kind="visual", index=0, media_type="image/png")
    root = parsed(detail()).model_dump(mode="json")
    root["visualElements"] = [{"kind": "image", "description": "Figure", "questionIds": ["q"], "imageRef": {**image.model_dump(), "objectKey": key}}]
    with pytest.raises(DocumentProcessingError) as error:
        await bank_export.export_task_bank(detail(root), store, source=source)
    assert error.value.code == "BANK_EXPORT_INVALID"


async def test_export_rejects_cross_source_and_conflicting_resource_metadata(tmp_path):
    store, source = await source_store(tmp_path)
    image = await store.put_artifact(make_image(), source_sha256="f" * 64, kind="visual", index=0, media_type="image/png")
    root = parsed(detail()).model_dump(mode="json")
    root["visualElements"] = [{"kind": "image", "description": "Figure", "questionIds": ["q"], "imageRef": image.model_dump()}]
    with pytest.raises(DocumentProcessingError, match="source"):
        await bank_export.export_task_bank(detail(root), store, source=source)
    image = await store.put_artifact(make_image(), source_sha256=source.sha256, kind="visual", index=0, media_type="image/png")
    root["visualElements"][0].update(imageRef=image.model_dump(), sourceRef={**image.model_dump(), "sizeBytes": image.sizeBytes + 1})
    with pytest.raises(DocumentProcessingError, match="Conflicting"):
        await bank_export.export_task_bank(detail(root), store, source=source)


@pytest.mark.parametrize("field,limit", [("MANIFEST_LIMIT", 10), ("JSON_LIMIT", 10), ("RESOURCE_LIMIT", 10), ("RESOURCES_LIMIT", 10), ("ZIP_LIMIT", 10), ("ENTRY_LIMIT", 2)])
async def test_export_enforces_desktop_package_budgets_without_truncating(tmp_path, monkeypatch, field, limit):
    store, source = await source_store(tmp_path)
    image = await store.put_artifact(make_image(), source_sha256=source.sha256, kind="visual", index=0, media_type="image/png")
    root = parsed(detail()).model_dump(mode="json")
    root["visualElements"] = [{"kind": "image", "description": "Figure", "questionIds": ["q"], "imageRef": image.model_dump()}]
    task = detail(root)
    original = task.model_dump(mode="json")
    monkeypatch.setattr(bank_export, field, limit)
    with pytest.raises(DocumentProcessingError) as error:
        await bank_export.export_task_bank(task, store, source=source)
    assert error.value.status_code == 413 and error.value.code == "BANK_EXPORT_TOO_LARGE"
    assert task.model_dump(mode="json") == original


@pytest.mark.parametrize("media", ["text/plain", "image/webp", "image/gif", "application/pdf"])
async def test_export_rejects_unsupported_packaged_media(tmp_path, media):
    store, source = await source_store(tmp_path)
    image = await store.put_artifact(make_image(), source_sha256=source.sha256, kind="visual", index=0, media_type=media)
    root = parsed(detail()).model_dump(mode="json")
    root["visualElements"] = [{"kind": "image", "description": "Figure", "questionIds": ["q"], "imageRef": image.model_dump()}]
    with pytest.raises(DocumentProcessingError, match="media"):
        await bank_export.export_task_bank(detail(root), store, source=source)


async def test_export_preserves_processing_and_storage_integrity_failures(tmp_path):
    store, source = await source_store(tmp_path)
    task = detail(processing={"chunks": {"total": 2, "succeeded": 1, "skipped": 0}, "visuals": {"total": 0, "succeeded": 0, "skipped": 0},
        "truncated": True, "failures": [{"stage": "document_parse", "index": 1, "code": "MODEL_UNAVAILABLE", "retryable": True}],
        "questionSources": [], "quality": {"reviewRequired": True, "reviewQuestionCount": 1, "issues": [{"questionId": "q", "code": "NEEDS_REVIEW"}]}})
    result = unpack(await bank_export.export_task_bank(task, store, source=source))
    assert task.processing is not None
    assert json.loads(result["questions.json"])["processing"] == task.processing.model_dump(mode="json")
    (tmp_path / source.objectKey).write_bytes(b"oops")
    with pytest.raises(DocumentProcessingError) as error:
        await bank_export.export_task_bank(task, store, source=source)
    assert error.value.code == "DOCUMENT_CHECKSUM_MISMATCH"


async def test_export_can_package_the_verified_original_image_as_a_source_ref(tmp_path):
    from practiq_ai.contracts import DocumentUploadRequest

    payload = make_image()
    store = object_store(tmp_path)
    source = await store.put_document(payload, DocumentUploadRequest(sourceType="image", fileName="source.png",
        mediaType="image/png", sizeBytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
    root = parsed(detail()).model_dump(mode="json")
    root["visualElements"] = [{"kind": "image", "description": "Original page", "questionIds": ["q"],
        "sourceRef": source.model_dump(exclude={"sourceType", "fileName"})}]
    files = unpack(await bank_export.export_task_bank(detail(root), store, source=source))
    assert files[f"resources/{source.objectKey}"] == payload


@pytest.mark.parametrize("content,media", [(b"invalid", "image/png"), (make_image(), "image/jpeg")])
async def test_export_rejects_damaged_or_mislabeled_images(tmp_path, content, media):
    store, source = await source_store(tmp_path)
    image = await store.put_artifact(content, source_sha256=source.sha256, kind="visual", index=0, media_type=media)
    root = parsed(detail()).model_dump(mode="json")
    root["visualElements"] = [{"kind": "image", "description": "Figure", "questionIds": ["q"], "imageRef": image.model_dump()}]
    with pytest.raises(DocumentProcessingError, match="image"):
        await bank_export.export_task_bank(detail(root), store, source=source)


async def test_export_rejects_image_dimensions_the_desktop_cannot_import(tmp_path):
    store, source = await source_store(tmp_path)
    content = io.BytesIO()
    Image.new("RGB", (16_385, 1)).save(content, format="PNG")
    image = await store.put_artifact(content.getvalue(), source_sha256=source.sha256, kind="visual", index=0, media_type="image/png")
    root = parsed(detail()).model_dump(mode="json")
    root["visualElements"] = [{"kind": "image", "description": "Figure", "questionIds": ["q"], "imageRef": image.model_dump()}]
    with pytest.raises(DocumentProcessingError, match="image"):
        await bank_export.export_task_bank(detail(root), store, source=source)


@pytest.mark.parametrize("missing", [True, False])
async def test_export_rejects_missing_and_changed_resources(tmp_path, missing):
    store, source = await source_store(tmp_path)
    image = await store.put_artifact(make_image(), source_sha256=source.sha256, kind="visual", index=0, media_type="image/png")
    root = parsed(detail()).model_dump(mode="json")
    root["visualElements"] = [{"kind": "image", "description": "Figure", "questionIds": ["q"], "imageRef": image.model_dump()}]
    path = tmp_path / image.objectKey
    if missing:
        path.unlink()
    else:
        path.write_bytes(b"bad image")
    with pytest.raises(DocumentProcessingError) as error:
        await bank_export.export_task_bank(detail(root), store, source=source)
    assert error.value.code == ("OBJECT_NOT_FOUND" if missing else "DOCUMENT_SIZE_MISMATCH")


async def test_export_rejects_processing_for_a_different_result_question(tmp_path):
    store, source = await source_store(tmp_path)
    task = detail(processing={"chunks": {"total": 1, "succeeded": 1, "skipped": 0}, "visuals": {"total": 0, "succeeded": 0, "skipped": 0},
        "truncated": False, "failures": [], "questionSources": [{"questionId": "old-question", "stage": "document_parse", "unitIndex": 0}],
        "quality": {"reviewRequired": False, "reviewQuestionCount": 0, "issues": []}})
    with pytest.raises(DocumentProcessingError, match="current result"):
        await bank_export.export_task_bank(task, store, source=source)


@pytest.mark.parametrize("key", ["questions", "groups", "visualElements", "warnings"])
async def test_export_revalidates_count_limits_in_a_mutated_result(tmp_path, key):
    store, source = await source_store(tmp_path)
    task = detail()
    value = parsed(task)
    entries = getattr(value, key)
    if not entries:
        root = value.model_dump(mode="json")
        root["visualElements"] = [{"kind": "image", "description": "Figure", "questionIds": ["q"]}]
        value = DocumentParseResult.model_validate(root)
        entries = getattr(value, key)
    entries *= 1001
    task = task.model_copy(update={"result": value})
    with pytest.raises(DocumentProcessingError, match="result contract"):
        await bank_export.export_task_bank(task, store, source=source)
