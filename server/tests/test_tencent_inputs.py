"""Size boundaries, lossless splitting and paid-submission preflight."""

import base64
import hashlib
import random
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest
from langgraph.store.memory import InMemoryStore
from PIL import Image

from practiq_ai import config, tencent
from practiq_ai.contracts import (
    DOCUMENT_MEDIA_TYPES,
    DocumentReference,
    document_source_key,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.execution import namespace
from practiq_ai.graphs import document
from practiq_ai.tencent_inputs import split_image, split_text
from tests.support import FakeObjectStore, ocr_text_page, tencent_provider


@pytest.mark.parametrize("limit", [4, 7, 20, 50])
def test_text_parts_preserve_every_utf8_byte_and_order(limit):
    original = "\ufeff题目\nA.你好\n\n答案：🙂\n".encode()
    parts = split_text(original, limit, 100)
    assert b"".join(parts) == original
    assert all(0 < len(part) <= limit for part in parts)
    assert "".join(part.decode("utf-8") for part in parts) == original.decode()
    assert split_text(original, limit, 100) == parts


def test_split_limits_fail_instead_of_dropping_content():
    with pytest.raises(DocumentProcessingError, match="split-part limit"):
        split_text(b"12345678", 4, 1)
    with pytest.raises(UnicodeDecodeError):
        split_text(b"bad\xff", 4, 10)


def test_image_tiles_reconstruct_all_pixels_including_alpha():
    image = Image.frombytes("RGBA", (40, 40), random.Random(7).randbytes(40 * 40 * 4))
    source = BytesIO()
    image.save(source, format="PNG")
    parts = split_image(source.getvalue(), 700, 100)
    restored = Image.new("RGBA", image.size)
    covered = 0
    for payload, media_type, (left, top, right, bottom) in parts:
        assert len(payload) <= 700 and media_type == "image/png"
        with Image.open(BytesIO(payload)) as tile:
            restored.paste(tile, (left, top))
        covered += (right - left) * (bottom - top)
    assert len(parts) > 1
    assert covered == image.width * image.height
    assert restored.tobytes() == image.tobytes()
    with pytest.raises(DocumentProcessingError):
        split_image(source.getvalue(), 700, 1)


@pytest.mark.parametrize("value", ["0", "3", "157286401", "no", "-1"])
def test_submission_limit_cannot_exceed_provider_limit(monkeypatch, value):
    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", value)
    with pytest.raises(ValueError, match="AI_TENCENT_INPUT_MAX_BYTES"):
        config.load()


def prepare(monkeypatch, kind, payload):
    digest = hashlib.sha256(payload).hexdigest()
    reference = DocumentReference(sourceType=kind, objectKey=document_source_key(kind, digest), sha256=digest,
                                  sizeBytes=len(payload), mediaType=next(iter(DOCUMENT_MEDIA_TYPES[kind])))
    files = FakeObjectStore({reference.objectKey: payload})
    monkeypatch.setattr(document, "get_object_store", lambda: files)
    monkeypatch.setattr(document, "get_model", lambda: object())
    monkeypatch.setattr(tencent, "guard", AsyncMock())
    monkeypatch.setattr(tencent, "run_remaining", AsyncMock(return_value=60))
    runtime = cast(Any, SimpleNamespace(store=InMemoryStore(), execution_info=SimpleNamespace(thread_id="split", run_id="run")))
    return {"document": reference.model_dump(mode="json")}, files, runtime


@pytest.mark.parametrize("kind", ["text", "markdown"])
async def test_oversized_text_has_ordered_receipts_and_replay_reuses_every_job(monkeypatch, kind):
    original = "第一题\n第二题\n第三题\n".encode()
    state, files, runtime = prepare(monkeypatch, kind, original)
    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", "12")
    calls = tencent_provider(monkeypatch, [ocr_text_page("question")])
    output = await document._prepare(cast(Any, state), runtime)
    submitted = [data for action, data in calls if action == "SubmitMultimodalDocParseJob"]
    assert len(submitted) == 3
    by_digest = {hashlib.sha256(base64.b64decode(data["FileBase64"])).hexdigest(): base64.b64decode(data["FileBase64"]) for data in submitted}
    assert b"".join(by_digest[part["reference"]["sha256"]] for part in output["inputParts"]) == original
    assert all(len(base64.b64decode(data["FileBase64"])) <= 12 for data in submitted)
    assert [part["byteStart"] for part in output["inputParts"]] == [0, 10, 20]
    assert len(output["ocrPageRefs"]) == 3
    receipts = await runtime.store.asearch(namespace("split", "tencent_jobs"))
    assert len(receipts) == 3
    assert all(item.value["resultRef"]["objectKey"].startswith(f"artifact/{state['document']['sha256']}/tencent-result/") for item in receipts)
    assert (await runtime.store.aget(namespace("split", "tencent_inputs"), "source")).value["parts"] == output["inputParts"]
    assert await document._prepare(cast(Any, state), runtime) == output
    assert len(calls) == 6
    assert files.blobs[state["document"]["objectKey"]] == original


async def test_failed_split_never_submits_even_the_first_part(monkeypatch):
    state, _, runtime = prepare(monkeypatch, "text", b"123456789")
    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", "4")
    monkeypatch.setenv("AI_MAX_DOCUMENT_PAGES", "2")
    calls = tencent_provider(monkeypatch, [ocr_text_page("question")])
    with pytest.raises(DocumentProcessingError):
        await document._prepare(cast(Any, state), runtime)
    assert calls == []


async def test_exact_limit_is_submitted_without_splitting(monkeypatch):
    state, _, runtime = prepare(monkeypatch, "text", b"12345678")
    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", "8")
    calls = tencent_provider(monkeypatch, [ocr_text_page("question")])
    output = await document._prepare(cast(Any, state), runtime)
    assert output["inputParts"] == []
    assert len(calls) == 2


async def test_oversized_image_retains_source_page_bounds_and_submits_only_bounded_tiles(monkeypatch):
    source = BytesIO()
    Image.frombytes("RGBA", (40, 40), random.Random(7).randbytes(40 * 40 * 4)).save(source, format="PNG")
    state, files, runtime = prepare(monkeypatch, "image", source.getvalue())
    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", "700")
    calls = tencent_provider(monkeypatch, [ocr_text_page("question")])
    output = await document._prepare(cast(Any, state), runtime)
    submitted = [base64.b64decode(data["FileBase64"]) for action, data in calls if action.startswith("Submit")]
    assert len(submitted) > 1 and all(len(part) <= 700 for part in submitted)
    assert len(output["pageRefs"]) == len(output["ocrPageRefs"]) == len(submitted)
    restored = Image.new("RGBA", (40, 40))
    by_digest = {hashlib.sha256(payload).hexdigest(): payload for payload in submitted}
    for part in output["inputParts"]:
        payload = by_digest[part["reference"]["sha256"]]
        assert part["sourcePage"] == 0
        assert files.blobs[part["originalPageRef"]["objectKey"]] == source.getvalue()
        with Image.open(BytesIO(payload)) as image:
            restored.paste(image, tuple(part["pixelBounds"][:2]))
    with Image.open(BytesIO(source.getvalue())) as original:
        assert original.tobytes() == restored.tobytes()


async def test_oversized_pdf_splits_real_rendered_pages_in_source_order(monkeypatch):
    source = BytesIO()
    first, second = Image.new("RGB", (24, 24), "white"), Image.new("RGB", (24, 24), "blue")
    first.save(source, format="PDF", save_all=True, append_images=[second])
    state, files, runtime = prepare(monkeypatch, "pdf", source.getvalue())
    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", "700")
    calls = tencent_provider(monkeypatch, [ocr_text_page("question")])
    output = await document._prepare(cast(Any, state), runtime)
    assert [part["sourcePage"] for part in output["inputParts"]] == [0, 1]
    submitted = [data for action, data in calls if action.startswith("Submit")]
    assert len(submitted) == len(output["ocrPageRefs"]) == 2
    assert all(data["FileType"] == 7 and len(base64.b64decode(data["FileBase64"])) <= 700 for data in submitted)
    assert files.blobs[state["document"]["objectKey"]] == source.getvalue()


async def test_oversized_office_without_engine_fails_before_any_paid_job(monkeypatch):
    payload = (Path(__file__).parents[2] / "app/fixtures/office/中文 试卷.docx").read_bytes()
    state, _, runtime = prepare(monkeypatch, "docx", payload)
    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", "700")
    monkeypatch.delenv("AI_OFFICE_EXECUTABLE", raising=False)
    monkeypatch.delenv("AI_OFFICE_VERSION", raising=False)
    calls = tencent_provider(monkeypatch, [ocr_text_page("question")])
    with pytest.raises(DocumentProcessingError) as error:
        await document._prepare(cast(Any, state), runtime)
    assert error.value.code == "OFFICE_NOT_CONFIGURED"
    assert calls == []


@pytest.mark.parametrize("kind,limit", [("doc", 700), ("docx", 700), ("xls", 700), ("xlsx", 700), ("xls", 8 * 1024 * 1024)])
async def test_oversized_office_reuses_isolated_pdf_conversion_before_tencent(monkeypatch, kind, limit):
    from practiq_ai.extractors import ExtractedDocument

    fixture = f"中文 试卷.{kind}" if kind.startswith("doc") else f"中文 表格.{kind}"
    payload = (Path(__file__).parents[2] / "app/fixtures/office" / fixture).read_bytes()
    state, files, runtime = prepare(monkeypatch, kind, payload)
    monkeypatch.setenv("AI_TENCENT_INPUT_MAX_BYTES", str(limit))
    pdf = await files.put_artifact(b"pdf", source_sha256=state["document"]["sha256"], kind="office", index=0, media_type="application/pdf")
    manifest = {"sources": [{"reference": pdf.model_dump(mode="json")}]}
    normalize = AsyncMock(return_value={"normalization": manifest})
    monkeypatch.setattr(document, "normalize_source", normalize)
    source = BytesIO()
    Image.new("RGB", (24, 24), "white").save(source, format="PNG")
    renderer = AsyncMock(return_value=ExtractedDocument(text="", page_images=[source.getvalue()]))
    monkeypatch.setattr(document, "extract", renderer)
    calls = tencent_provider(monkeypatch, [ocr_text_page("question")])
    output = await document._prepare(cast(Any, state), runtime)
    normalize.assert_awaited_once()
    renderer.assert_awaited_once_with("pdf", b"pdf")
    assert output["normalization"] == manifest
    assert calls[0][1]["FileType"] == 7
    assert output["inputParts"][0]["sourcePage"] == 0


@pytest.mark.parametrize("family,option", [("calc", "SinglePageSheets"), ("impress", "ExportHiddenSlides")])
def test_office_pdf_export_retains_hidden_sheets_and_slides(monkeypatch, tmp_path, family, option):
    import json

    from practiq_ai import office

    captured = []

    def run(args, _deadline, output):
        captured.append(args)
        Image.new("RGB", (24, 24)).save(output / "source.pdf", format="PDF")

    monkeypatch.setattr(office, "_run", run)
    office._export(tmp_path / "soffice", tmp_path / "source.xlsx", tmp_path / "output", family, "pdf", 10)
    args = captured[0]
    export_filter = args[args.index("--convert-to") + 1]
    assert export_filter.startswith(f"pdf:{family if family == 'calc' else 'impress'}_pdf_Export:")
    assert json.loads(export_filter.split(":", 2)[2])[option] == {"type": "boolean", "value": "true"}


def test_cmyk_jpeg_tiles_use_png_rgb_without_losing_pixels():
    original = Image.frombytes('CMYK', (40, 40), random.Random(8).randbytes(40*40*4))
    source = BytesIO()
    original.save(source, format='JPEG')
    parts = split_image(source.getvalue(), 700, 100)
    restored = Image.new('RGB', original.size)
    for data, media, bounds in parts:
        with Image.open(BytesIO(data)) as tile:
            assert tile.mode == 'RGB' and media == 'image/png' and len(data) <= 700
            restored.paste(tile, bounds[:2])
    with Image.open(BytesIO(source.getvalue())) as decoded:
        assert restored.tobytes() == decoded.convert('RGB').tobytes()
    assert len(parts) > 1


@pytest.mark.parametrize('kind', ['text', 'markdown'])
async def test_split_text_cannot_restore_proofs_by_inserting_newlines(monkeypatch, kind):
    original = b'first\nsecond'
    state, _, runtime = prepare(monkeypatch, kind, original)
    monkeypatch.setenv('AI_TENCENT_INPUT_MAX_BYTES', '6')
    tencent_provider(monkeypatch, [ocr_text_page('unused')])
    original_decode = document.decode_bundle
    def decode(bundle, settings, **kwargs):
        index = len(decoded)
        pages = original_decode(bundle, settings, **kwargs)
        pages[0]['elements'][0]['text_info']['content'] = ['first','second'][index]
        decoded.append(pages)
        return pages
    decoded = []
    monkeypatch.setattr(document, 'decode_bundle', decode)
    result = await document._prepare(cast(Any, state), runtime)
    assert result['textRef'] is None
    assert any('original-text source proofs are unavailable' in item for item in result['warnings'])


async def test_office_page_ceiling_preserves_partial_evidence_for_review(monkeypatch):
    payload = (Path(__file__).parents[2] / 'app/fixtures/office/中文 试卷.docx').read_bytes()
    state, _, runtime = prepare(monkeypatch, 'docx', payload)
    monkeypatch.setenv('AI_MAX_DOCUMENT_PAGES', '1')
    tencent_provider(monkeypatch, [ocr_text_page('first page')])
    result = await document._prepare(cast(Any, state), runtime)
    assert result['truncated'] and len(result['ocrPageRefs']) == 1
    assert any('configured page limit' in item for item in result['warnings'])


def test_invalid_cmyk_profile_returns_a_controlled_error():
    source = BytesIO()
    Image.new('CMYK', (20, 20)).save(source, format='JPEG', icc_profile=b'invalid profile')
    with pytest.raises(DocumentProcessingError) as error:
        split_image(source.getvalue(), 700, 100)
    assert error.value.code == 'IMAGE_FORMAT_UNSUPPORTED'


async def test_workbook_sheet_limit_rejects_before_any_paid_submission(monkeypatch):
    payload = (Path(__file__).parents[2] / 'app/fixtures/office/中文 表格.xlsx').read_bytes()
    state, _, runtime = prepare(monkeypatch, 'xlsx', payload)
    monkeypatch.setenv('AI_MAX_DOCUMENT_PAGES', '1')
    calls = tencent_provider(monkeypatch, [ocr_text_page('unused')])
    with pytest.raises(DocumentProcessingError) as error:
        await document._prepare(cast(Any, state), runtime)
    assert error.value.status_code == 413 and error.value.code == 'OFFICE_OUTPUT_LIMIT'
    assert calls == []
