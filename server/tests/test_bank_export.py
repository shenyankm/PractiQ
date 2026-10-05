"""Portable bank export uses the existing desktop ZIP and result contracts."""

import asyncio
import gc
import hashlib
import io
import json
import os
import runpy
import subprocess
import sys
import threading
import tracemalloc
import wave
from pathlib import Path
from tempfile import TemporaryFile
from zipfile import ZipFile

import httpx
import pytest
from PIL import Image

from practiq_ai import bank_export
from practiq_ai.contracts import DocumentParseResult, DocumentTaskDetail
from practiq_ai.errors import DocumentProcessingError
from tests.support import make_image, object_store, upload


@pytest.mark.parametrize("png_compression", [None, 0])
def test_documented_fixture_generator_consumes_stream_and_preserves_portable_content(tmp_path, png_compression):
    root = Path(__file__).parents[2]
    fixture = root / "app/fixtures/service-export"
    output = tmp_path / "generated"
    command = [sys.executable, str(fixture / "generate.py"), str(output)]
    if png_compression is not None:
        # PNG encoders can produce different compressed bytes for identical pixels.
        program = ("import runpy, sys; from PIL import Image; compression=int(sys.argv.pop(1)); "
                   "original=Image.Image.save; "
                   "Image.Image.save=lambda image,*args,**kwargs:original(image,*args,**(kwargs|{'compress_level':compression})); "
                   "sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0],run_name='__main__')")
        command = [sys.executable, "-c", program, str(png_compression), *command[1:]]
    process = subprocess.run(command,
                             env=os.environ | {"PYTHONPATH": str(root / "server/src")},
                             capture_output=True, text=True, check=True, timeout=30)
    provenance = json.loads((output / "provenance.json").read_text())
    archive = output / provenance["archive"]
    assert json.loads(process.stdout) == provenance
    assert provenance["archiveBytes"] == archive.stat().st_size
    assert provenance["archiveSha256"] == hashlib.sha256(archive.read_bytes()).hexdigest()
    historical = json.loads((fixture / "provenance.json").read_text())
    for field in ("source", "audio"):
        assert provenance[field] == historical[field]
    assert provenance["exporterSha256"] == hashlib.sha256((root / "server/src/practiq_ai/bank_export.py").read_bytes()).hexdigest()
    with ZipFile(archive) as generated, ZipFile(fixture / "partial-media-bank.zip") as original:
        image_path = "resources/" + provenance["image"]["objectKey"]
        old_image_path = "resources/" + historical["image"]["objectKey"]
        assert generated.namelist() == [image_path if name == old_image_path else name for name in original.namelist()]
        image_bytes = generated.read(image_path)
        assert provenance["image"]["sha256"] == hashlib.sha256(image_bytes).hexdigest()
        assert provenance["image"]["sizeBytes"] == len(image_bytes)
        assert provenance["image"]["mediaType"] == historical["image"]["mediaType"] == "image/png"
        with Image.open(io.BytesIO(image_bytes)) as image, Image.open(io.BytesIO(original.read(old_image_path))) as previous:
            assert image.format == previous.format == "PNG"
            assert image.mode == previous.mode == "RGB"
            assert image.size == previous.size == (16, 12)
            assert image.tobytes() == previous.tobytes() == b"\xff" * (16 * 12 * 3)
        if png_compression is not None:
            assert image_bytes != original.read(old_image_path)
        actual = json.loads(generated.read("questions.json"))
        expected = json.loads(original.read("questions.json"))
        for field in ("imageRef", "sourceRef"):
            assert expected["result"]["visualElements"][0][field] == historical["image"]
            expected["result"]["visualElements"][0][field] = provenance["image"]
        assert actual == expected
        dumped = json.dumps(actual["result"], sort_keys=True, ensure_ascii=False).encode()
        assert provenance["resultDumpSha256"] == hashlib.sha256(dumped).hexdigest()
        for name in original.namelist():
            if name not in {old_image_path, "questions.json"}:
                assert generated.read(name) == original.read(name)


def test_fixture_generator_closes_export_stream_when_destination_cannot_open(tmp_path, monkeypatch):
    payload = io.BytesIO(b"Synthetic archive; no model")
    async def export(*_args, **_kwargs):
        return payload
    monkeypatch.setattr(bank_export, "export_task_bank", export)
    monkeypatch.setattr(sys, "argv", ["generate.py", str(tmp_path)])
    original_open = Path.open
    def open_file(path, *args, **kwargs):
        if path.name == "partial-media-bank.zip" and args == ("wb",):
            raise OSError("Synthetic destination failure")
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(Path, "open", open_file)
    with pytest.raises(OSError, match="Synthetic destination failure"):
        runpy.run_path(str(Path(__file__).parents[2] / "app/fixtures/service-export/generate.py"))
    assert payload.closed and not (tmp_path / "provenance.json").exists()


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
    with payload, ZipFile(payload) as archive:
        return {entry.filename: archive.read(entry) for entry in archive.infolist()}


async def test_export_preserves_partial_nulls_tree_and_only_portable_task_fields(tmp_path):
    store, source = await source_store(tmp_path)
    root = json.loads((Path(__file__).parents[2] / "app/fixtures/composite.json").read_text())
    task = detail(root)
    payload = await bank_export.export_task_bank(task, store, source=source, title="课程", description="供离线追加")
    with ZipFile(payload) as archive:
        assert all(not entry.is_dir() and entry.create_system == 3 and entry.external_attr >> 16 & 0o170000 == 0o100000 for entry in archive.infolist())
    payload.seek(0)
    files = unpack(payload)
    assert set(files) == {"manifest.json", "questions.json"}
    assert json.loads(files["manifest.json"]) == {
        "format": "practiq-question-bank", "version": 2, "bank": {"title": "课程", "description": "供离线追加"},
    }
    output = json.loads(files["questions.json"])
    assert output == {"status": "PARTIAL", "result": parsed(task).model_dump(mode="json"), "processing": None}
    assert DocumentParseResult.model_validate(output["result"]) == task.result
    assert "usage" not in output and "threadId" not in output and "document" not in output


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


async def test_export_peak_memory_tracks_one_resource_instead_of_the_expanded_bank(tmp_path, record_property):
    store, source = await source_store(tmp_path)
    root = parsed(detail()).model_dump(mode="json")
    template = root["questions"][0]
    root["questions"] = []
    resource_size = 4 * 1024 * 1024
    content = io.BytesIO()
    with wave.open(content, "wb") as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(8000)
        audio.writeframes(b"\0\0" * (resource_size // 2))
    resources = []
    audio_bytes = bytearray(content.getvalue())
    for index in range(8):
        audio_bytes[-2] = index
        reference = await store.put_artifact(bytes(audio_bytes), source_sha256=source.sha256,
            kind="audio", index=index, media_type="audio/wav")
        resources.append(reference)
        root["questions"].append({**template, "id": f"q{index}", "answerMode": "listening", "questionKind": "listening",
                                  "audioRef": reference.model_dump(), "passage": []})
    root["groups"][0]["questionIds"] = [question["id"] for question in root["questions"]]
    task = detail(root)
    assert len({reference.sha256 for reference in resources}) == 8
    assert len({reference.objectKey for reference in resources}) == 8
    expanded = sum(reference.sizeBytes for reference in resources)
    assert expanded == 8 * (resource_size + 44)
    del audio_bytes
    content.close(); gc.collect(); tracemalloc.start()
    payload = None
    try:
        payload = await bank_export.export_task_bank(task, store, source=source)
        _, peak = tracemalloc.get_traced_memory()
        record_property("unique_resources", 8)
        record_property("expanded_resources_bytes", expanded)
        record_property("peak_python_allocation_bytes", peak)
        with ZipFile(io.BytesIO(payload) if isinstance(payload, bytes) else payload) as archive:
            assert len(archive.infolist()) == 10
            packaged = [entry for entry in archive.infolist() if entry.filename.startswith("resources/")]
            assert len(packaged) == 8 and sum(entry.file_size for entry in packaged) == expanded
            record_property("packaged_resource_entries", len(packaged))
        assert peak < 3 * resource_size, f"Expanded {expanded} byte bank used {peak} Python allocation bytes"
        assert not isinstance(payload, bytes)
    finally:
        tracemalloc.stop()
        if payload is not None and not isinstance(payload, bytes):
            payload.close()


async def test_export_closes_private_archive_on_resource_integrity_failure(tmp_path, monkeypatch):
    store, source = await source_store(tmp_path)
    image = await store.put_artifact(make_image(), source_sha256=source.sha256, kind="visual", index=0, media_type="image/png")
    root = parsed(detail()).model_dump(mode="json")
    root["visualElements"] = [{"kind": "image", "description": "Figure", "questionIds": ["q"], "imageRef": image.model_dump()}]
    (tmp_path / image.objectKey).write_bytes(b"invalid")
    files = []
    def temporary(*args, **kwargs):
        file = TemporaryFile(*args, **kwargs)  # noqa: SIM115 - caller owns the tracked archive
        files.append(file); return file
    monkeypatch.setattr(bank_export, "TemporaryFile", temporary, raising=False)
    with pytest.raises(DocumentProcessingError):
        await bank_export.export_task_bank(detail(root), store, source=source)
    assert len(files) == 1 and files[0].closed


@pytest.mark.parametrize("failure", ["stale", "cancelled"])
async def test_task_export_closes_archive_when_the_final_snapshot_cannot_be_used(tmp_path, monkeypatch, failure):
    from types import SimpleNamespace

    from practiq_ai import task_api
    store, source = await source_store(tmp_path)
    entered = asyncio.Event()
    calls = 0
    async def read_task(_service, _thread):
        nonlocal calls
        calls += 1
        if calls == 2:
            entered.set()
            if failure == "cancelled":
                await asyncio.Event().wait()
        return {"document": source.model_dump()}, "current-result" if calls == 1 else "stale", None
    async def get_task(_thread):
        return detail().model_dump(mode="json")
    payload = TemporaryFile("w+b")  # noqa: SIM115 - assert production closes the transferred file
    async def export(*_args, **_kwargs):
        return payload
    monkeypatch.setattr(task_api, "client", lambda: SimpleNamespace(checkpoint_id=lambda snapshot, _run: snapshot))
    monkeypatch.setattr(task_api, "_read_task", read_task)
    monkeypatch.setattr(task_api, "get_task", get_task)
    monkeypatch.setattr(task_api, "get_object_store", lambda: store)
    monkeypatch.setattr(bank_export, "export_task_bank", export)
    operation = asyncio.create_task(task_api.export_task(str(detail().threadId), "current-result"))
    try:
        await entered.wait()
        if failure == "cancelled":
            operation.cancel()
        with pytest.raises(asyncio.CancelledError if failure == "cancelled" else DocumentProcessingError):
            await operation
        assert payload.closed
    finally:
        payload.close()


async def test_export_waits_for_a_cancelled_writer_before_closing_its_archive(tmp_path, monkeypatch):
    store, source = await source_store(tmp_path)
    image = await store.put_artifact(make_image(), source_sha256=source.sha256, kind="visual", index=0, media_type="image/png")
    root = parsed(detail()).model_dump(mode="json")
    root["visualElements"] = [{"kind": "image", "description": "Figure", "questionIds": ["q"], "imageRef": image.model_dump()}]
    files, errors = [], []
    entered, released, finished = threading.Event(), threading.Event(), threading.Event()
    original_write = bank_export._write_entry
    def temporary(*args, **kwargs):
        file = TemporaryFile(*args, **kwargs)  # noqa: SIM115 - production must close this file
        files.append(file); return file
    def write(archive, output, name, payload):
        if not name.startswith("resources/"):
            return original_write(archive, output, name, payload)
        entered.set()
        try:
            assert released.wait(5), "Cancelled writer was never released"
            original_write(archive, output, name, payload)
        except BaseException as exc:
            errors.append(exc)
            raise
        finally:
            finished.set()
    monkeypatch.setattr(bank_export, "TemporaryFile", temporary)
    monkeypatch.setattr(bank_export, "_write_entry", write)
    operation = asyncio.create_task(bank_export.export_task_bank(detail(root), store, source=source))
    try:
        assert await asyncio.wait_for(asyncio.to_thread(entered.wait, 5), timeout=6)
        operation.cancel()
        await asyncio.sleep(0.01)
        operation.cancel()
        await asyncio.sleep(0.01)
        assert not operation.done() and len(files) == 1 and not files[0].closed
        released.set()
        with pytest.raises(asyncio.CancelledError):
            await operation
        assert finished.is_set() and not errors and files[0].closed
    finally:
        released.set()
        if not operation.done():
            operation.cancel()
            await asyncio.gather(operation, return_exceptions=True)
        for file in files:
            file.close()


@pytest.mark.parametrize("failure", [None, "cancelled", "disconnect"])
async def test_export_http_slot_holds_through_download_and_releases_after_response(monkeypatch, failure):
    from practiq_ai import task_api, webapp
    monkeypatch.setenv("AI_SERVICE_TOKEN", "export-test-token")
    endpoint = f"/api/document-tasks/{detail().threadId}/export"
    entered, released = asyncio.Event(), asyncio.Event()
    files = []
    async def export(*_args):
        payload = TemporaryFile("w+b")  # noqa: SIM115 - response receives ownership
        payload.write(b"x" * (128 * 1024 + 17)); payload.seek(0)
        files.append(payload)
        return payload
    monkeypatch.setattr(task_api, "export_task", export)
    async def receive():
        await asyncio.Event().wait()
        return {"type": "http.disconnect"}
    async def slow_send(message):
        if message["type"] == "http.response.body" and message.get("body"):
            entered.set()
            await released.wait()
            if failure == "disconnect":
                raise OSError("Synthetic disconnected HTTP client")
    scope = {"type": "http", "method": "GET", "path": endpoint,
             "query_string": b"checkpoint_id=current-result", "headers": [(b"authorization", b"Bearer export-test-token")],
             "asgi": {"version": "3.0", "spec_version": "2.4"}, "scheme": "http", "http_version": "1.1"}
    first = asyncio.create_task(webapp.app(scope, receive, slow_send))
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url="http://test") as client:
            assert (await client.get(endpoint)).status_code == 401
            client.headers["Authorization"] = "Bearer export-test-token"
            busy = await client.get(endpoint)
            assert busy.status_code == 429 and busy.json()["detail"]["code"] == "BANK_EXPORT_BUSY"
            assert busy.headers["retry-after"] == "1" and len(files) == 1
            if failure == "cancelled":
                first.cancel()
            released.set()
            if failure:
                with pytest.raises(asyncio.CancelledError if failure == "cancelled" else Exception):
                    await first
            else:
                await first
            assert files[0].closed
            exported = await client.get(endpoint)
            assert exported.status_code == 200 and len(exported.content) == 128 * 1024 + 17
            assert len(files) == 2 and all(file.closed for file in files)
    finally:
        released.set()
        if not first.done():
            first.cancel()
            await asyncio.gather(first, return_exceptions=True)
        for file in files:
            file.close()


async def test_export_http_slot_releases_after_archive_build_failure(monkeypatch):
    from practiq_ai import task_api, webapp
    monkeypatch.setenv("AI_SERVICE_TOKEN", "export-test-token")
    files = []
    calls = 0
    async def export(*_args):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise DocumentProcessingError(503, "Synthetic archive build failure", "TEST_EXPORT_FAILURE")
        payload = TemporaryFile("w+b")  # noqa: SIM115 - response receives ownership
        payload.write(b"archive"); payload.seek(0); files.append(payload)
        return payload
    monkeypatch.setattr(task_api, "export_task", export)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url="http://test",
                                headers={"Authorization": "Bearer export-test-token"}) as client:
        endpoint = f"/api/document-tasks/{detail().threadId}/export"
        failure = await client.get(endpoint)
        assert failure.status_code == 503 and failure.json()["detail"]["code"] == "TEST_EXPORT_FAILURE"
        success = await client.get(endpoint)
        assert success.status_code == 200 and success.content == b"archive" and files[0].closed


@pytest.mark.parametrize("failure", [None, "disconnect", "cancelled", "header_disconnect", "legacy_disconnect"])
async def test_export_response_reads_bounded_chunks_and_closes_on_completion_or_disconnect(monkeypatch, failure):
    from practiq_ai import task_api, webapp
    payload = TemporaryFile("w+b")  # noqa: SIM115 - assert production closes the transferred file
    payload.write(b"x" * (128 * 1024 + 17)); payload.seek(0)
    async def export(*_args):
        return payload
    monkeypatch.setattr(task_api, "export_task", export)
    messages = []
    async def send(message):
        messages.append(message)
        if message["type"] == "http.response.start" and failure == "header_disconnect":
            raise OSError("Synthetic disconnected client before its first read")
        if message["type"] == "http.response.body" and failure in {"disconnect", "cancelled"}:
            if failure == "disconnect":
                raise OSError("Synthetic disconnected client")
            raise asyncio.CancelledError
    async def receive():
        if failure != "legacy_disconnect":
            await asyncio.Event().wait()
        return {"type": "http.disconnect"}
    try:
        response = await webapp.export_document_task(detail().threadId, "current-result")
        assert response.headers["content-length"] == str(128 * 1024 + 17)
        scope = {"type": "http", "method": "GET", "asgi": {"spec_version": "2.0" if failure == "legacy_disconnect" else "2.4"}}
        if failure and failure != "legacy_disconnect":
            with pytest.raises(asyncio.CancelledError if failure == "cancelled" else Exception):
                await response(scope, receive, send)
        else:
            await response(scope, receive, send)
        if not failure:
            bodies = [message["body"] for message in messages if message["type"] == "http.response.body"]
            assert b"".join(bodies) == b"x" * (128 * 1024 + 17)
        assert payload.closed
        assert all(len(message.get("body", b"")) <= 64 * 1024 for message in messages)
    finally:
        payload.close()


async def test_export_response_waits_for_a_cancelled_read_before_closing_its_archive(monkeypatch):
    from practiq_ai import task_api, webapp
    payload = TemporaryFile("w+b")  # noqa: SIM115 - assert production closes the transferred file
    payload.write(b"archive"); payload.seek(0)
    entered, released, finished = threading.Event(), threading.Event(), threading.Event()
    errors = []
    original_read = payload.read
    def read(size):
        entered.set()
        try:
            assert released.wait(5), "Cancelled archive read was never released"
            return original_read(size)
        except BaseException as exc:
            errors.append(exc)
            raise
        finally:
            finished.set()
    async def export(*_args):
        return payload
    async def receive():
        await asyncio.Event().wait()
        return {"type": "http.disconnect"}
    async def send(_message):
        pass
    monkeypatch.setattr(payload, "read", read)
    monkeypatch.setattr(task_api, "export_task", export)
    response = await webapp.export_document_task(detail().threadId, "current-result")
    operation = asyncio.create_task(response({"type": "http", "method": "GET", "asgi": {"spec_version": "2.4"}}, receive, send))
    try:
        assert await asyncio.wait_for(asyncio.to_thread(entered.wait, 5), timeout=6)
        operation.cancel()
        await asyncio.sleep(0.01)
        operation.cancel()
        await asyncio.sleep(0.01)
        assert not operation.done() and not payload.closed
        released.set()
        with pytest.raises(asyncio.CancelledError):
            await operation
        assert finished.is_set() and not errors and payload.closed
    finally:
        released.set()
        if not operation.done():
            operation.cancel()
            await asyncio.gather(operation, return_exceptions=True)
        payload.close()


def test_export_entries_use_fast_compression_and_preserve_content_and_permissions(monkeypatch):
    output = io.BytesIO()
    payload = b'unchanged source and question bytes' * 1000
    with ZipFile(output,'w') as archive:
        original = archive.open
        def observed(entry, mode='r', *args, **kwargs):
            assert entry.compress_type == bank_export.ZIP_DEFLATED and entry.compress_level == 1
            assert mode == 'w'
            return original(entry,'w',*args,**kwargs)
        monkeypatch.setattr(archive,'open',observed)
        bank_export._write_entry(archive,output,'questions.json',payload)
    with ZipFile(io.BytesIO(output.getvalue())) as archive:
        assert archive.read('questions.json') == payload
        assert archive.getinfo('questions.json').external_attr >> 16 == 0o100600
        assert archive.testzip() is None
