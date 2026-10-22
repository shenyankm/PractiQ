"""One validated central directory and sequential, bounded Tencent subimage reads."""

import hashlib
import json
import zipfile
from dataclasses import replace
from io import BytesIO
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest

from practiq_ai import tencent_bundle
from practiq_ai.config import load
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from tests.support import make_image, ocr_text_page, source


def resource_bundle(count=30, image=None, extra=(), text="Question"):
    image = make_image() if image is None else image
    figures = [{"bbox": [.1, .2, .4, .5]} for _ in range(count)]
    page = ocr_text_page(text, figures=figures)
    xml = '<root>' + ''.join(f'<image id="p-{index}" page-numbers="0" src="assets/{index}.png"/>' for index in range(count)) + '</root>'
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("result_xml_full.xml", xml)
        archive.writestr("result_ocr_page0.json", json.dumps(page))
        for index in range(count):
            archive.writestr(f"assets/{index}.png", image)
        for name, data in extra:
            archive.writestr(name, data)
    return buffer.getvalue(), image


async def test_prepare_opens_one_zip_and_never_rebuilds_member_names(monkeypatch):
    payload, image = resource_bundle()
    files, reference = source("Question")
    result_ref = await files.put_artifact(payload, source_sha256=reference["sha256"], kind="tencent-result", index=0, media_type="application/octet-stream")
    monkeypatch.setattr(document, "get_object_store", lambda: files)
    monkeypatch.setattr(document, "get_model", lambda: object())
    monkeypatch.setattr(document, "parse_job", AsyncMock(return_value={"resultRef": result_ref.model_dump(), "SuccessPageNum": 1}))
    opened = []
    reads = []
    original = zipfile.ZipFile

    class CountedZipFile(original):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            opened.append(self)

        def namelist(self):
            pytest.fail("XML associations must reuse the validated member-name set")

        def read(self, name, *args, **kwargs):
            reads.append(name.filename if isinstance(name, zipfile.ZipInfo) else name)
            return super().read(name, *args, **kwargs)

    monkeypatch.setattr(zipfile, "ZipFile", CountedZipFile)
    result = await document._prepare(cast(Any, {"document": reference}), cast(Any, SimpleNamespace()))
    assert len(opened) == 1 and opened[0].fp is None
    assert reads == ["result_xml_full.xml", "result_ocr_page0.json", *[f"assets/{index}.png" for index in range(30)]]
    page = json.loads(files.blobs[result["ocrPageRefs"][0]["objectKey"]])
    assert [figure["elementIndex"] for figure in page["figures"]] == list(range(30))
    for figure in page["figures"]:
        assert files.blobs[figure["imageRef"]["objectKey"]] == image
        assert figure["imageRef"]["sha256"] == hashlib.sha256(image).hexdigest()


@pytest.mark.parametrize("bad", ["corrupt", "version", "encoding"])
async def test_prepare_translates_zip_open_failures(monkeypatch, bad):
    payload, _ = resource_bundle(0)
    damaged = bytearray(payload)
    directory = damaged.index(b"PK\x01\x02")
    if bad == "corrupt":
        payload = b"not a zip"
    elif bad == "version":
        damaged[directory + 6:directory + 8] = (255).to_bytes(2, "little")
        payload = bytes(damaged)
    else:
        flags = int.from_bytes(damaged[directory + 8:directory + 10], "little") | 0x800
        damaged[directory + 8:directory + 10] = flags.to_bytes(2, "little")
        damaged[directory + 46] = 0xff
        payload = bytes(damaged)
    files, reference = source("Question")
    result_ref = await files.put_artifact(payload, source_sha256=reference["sha256"], kind="tencent-result", index=0, media_type="application/octet-stream")
    monkeypatch.setattr(document, "get_object_store", lambda: files)
    monkeypatch.setattr(document, "get_model", lambda: object())
    monkeypatch.setattr(document, "parse_job", AsyncMock(return_value={"resultRef": result_ref.model_dump(), "SuccessPageNum": 1}))
    with pytest.raises(DocumentProcessingError) as error:
        await document._prepare(cast(Any, {"document": reference}), cast(Any, SimpleNamespace()))
    assert error.value.code == "TENCENT_RESULT_INVALID"


@pytest.mark.parametrize("bad", ["unsafe", "duplicate", "entries", "expanded"])
def test_reused_archive_validates_all_members_before_subimage_reads(monkeypatch, bad):
    extra = [("../unused", b"bad")] if bad == "unsafe" else [("assets/0.png", b"duplicate")] if bad == "duplicate" else []
    if bad == "duplicate":
        with pytest.warns(UserWarning, match="Duplicate name"):
            payload, _ = resource_bundle(1, extra=extra)
    else:
        payload, _ = resource_bundle(1, extra=extra)
    if bad == "entries":
        monkeypatch.setattr(tencent_bundle, "MAX_ENTRIES", 2)
    elif bad == "expanded":
        monkeypatch.setattr(tencent_bundle, "MAX_EXPANDED_BYTES", 1)
    with tencent_bundle.open_bundle(payload) as archive, pytest.raises(DocumentProcessingError) as error:
        tencent_bundle.decode_bundle(archive, load(), page_count=1)
    assert error.value.code == "TENCENT_RESULT_INVALID"


@pytest.mark.parametrize("bad", ["size", "format", "pixels", "crc"])
def test_reused_zip_subimages_keep_size_format_pixel_and_crc_checks(monkeypatch, bad):
    payload, image = resource_bundle(1, image=b"not an image" if bad == "format" else None)
    if bad == "crc":
        offset = payload.index(image)
        payload = payload[:offset] + bytes([payload[offset] ^ 1]) + payload[offset + 1:]
    settings = load()
    if bad == "size":
        settings = replace(settings, vision_max_bytes=len(image) - 1)
    elif bad == "pixels":
        monkeypatch.setenv("AI_MAX_VISION_PAGE_PIXELS", "1")
    with tencent_bundle.open_bundle(payload) as archive:
        tencent_bundle.decode_bundle(archive, settings, page_count=1)
        with pytest.raises(DocumentProcessingError) as error:
            tencent_bundle.read_bundle_image(archive, "assets/0.png", settings)
    if bad == "size":
        assert error.value.code == "TENCENT_RESULT_TOO_LARGE"
    elif bad == "crc":
        assert error.value.code == "TENCENT_RESULT_INVALID"
    elif bad == "pixels":
        assert error.value.code == "IMAGE_TOO_LARGE"


@pytest.mark.parametrize("limit", ["pages", "text", "assets"])
async def test_decode_enforces_shared_limits_after_parallel_jobs(monkeypatch, limit):
    files, reference = source("aaa\nbbb\n")
    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", "4")
    if limit == "pages":
        monkeypatch.setenv("AI_MAX_DOCUMENT_PAGES", "2")
    elif limit == "text":
        monkeypatch.setenv("AI_MAX_TOTAL_INPUT_CHARS", "1000")
    payload, image = resource_bundle(1 if limit == "assets" else 0, text="x" * 600 if limit == "text" else "Question")
    if limit == "assets":
        monkeypatch.setenv("AI_MAX_VISION_BYTES", str(len(image) + 1))
    result_ref = await files.put_artifact(payload, source_sha256=reference["sha256"], kind="tencent-result", index=0, media_type="application/octet-stream")
    monkeypatch.setattr(document, "get_object_store", lambda: files)
    monkeypatch.setattr(document, "get_model", lambda: object())
    paid = AsyncMock(return_value={"resultRef": result_ref.model_dump(), "SuccessPageNum": 2 if limit == "pages" else 1})
    monkeypatch.setattr(document, "parse_job", paid)
    # Each part is valid alone; their combined evidence exceeds a shared cap.
    from langgraph.store.memory import InMemoryStore

    runtime = cast(Any, SimpleNamespace(store=InMemoryStore(), execution_info=SimpleNamespace(thread_id="limits")))
    with pytest.raises(DocumentProcessingError) as error:
        await document._prepare(cast(Any, {"document": reference}), runtime)
    assert paid.await_count == 2
    assert error.value.code == ("PDF_PAGE_LIMIT_EXCEEDED" if limit == "pages" else "TENCENT_RESULT_TOO_LARGE")
