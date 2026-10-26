"""Workbook decoding rejects accepted ZIP metadata before provider or Office work."""

import hashlib
import io
import lzma
import struct
import zipfile
import zlib
from compression import zstd
from pathlib import Path
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest

from practiq_ai import office
from practiq_ai.contracts import DOCUMENT_MEDIA_TYPES, DocumentUploadRequest
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from tests.support import object_store


def workbook(member: str, compression: int) -> bytes:
    output = io.BytesIO()
    fixture = Path(__file__).parents[2] / "app/fixtures/office/中文 表格.xlsx"
    with zipfile.ZipFile(fixture) as original, zipfile.ZipFile(output, "w") as archive:
        for entry in original.infolist():
            archive.writestr(entry.filename, original.read(entry),
                             compress_type=compression if entry.filename == member else zipfile.ZIP_STORED)
    return output.getvalue()


def corrupt_member(source: bytes, member: str, corruption: str) -> bytes:
    payload = bytearray(source)
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        entry = archive.getinfo(member)
    local = entry.header_offset
    central = payload.index(b"PK\x01\x02")
    while True:
        name_size, extra_size, comment_size = struct.unpack_from("<HHH", payload, central + 28)
        if payload[central + 46:central + 46 + name_size] == member.encode():
            break
        central += 46 + name_size + extra_size + comment_size
    name_size, extra_size = struct.unpack_from("<HH", payload, local + 26)
    data = local + 30 + name_size + extra_size
    if corruption == "unsupported":
        struct.pack_into("<H", payload, local + 8, 9)  # Deflate64 is unsupported by zipfile.
        struct.pack_into("<H", payload, central + 10, 9)
    elif corruption == "filename":
        flags = struct.unpack_from("<H", payload, local + 6)[0]
        struct.pack_into("<H", payload, local + 6, flags | 0x800)
        payload[local + 30] = 0xff
    elif corruption == "offset":
        end = payload.rindex(b"PK\x05\x06")
        offset = struct.unpack_from("<I", payload, end + 16)[0]
        struct.pack_into("<I", payload, end + 16, offset + 1)
        cursor = payload.index(b"PK\x01\x02")
        while payload[cursor:cursor + 4] == b"PK\x01\x02":
            header_offset = struct.unpack_from("<I", payload, cursor + 42)[0]
            # Keep other members readable; the target resolves to a negative local-header offset.
            struct.pack_into("<I", payload, cursor + 42, 0 if cursor == central else header_offset + 1)
            cursor += 46 + sum(struct.unpack_from("<HHH", payload, cursor + 28))
    elif corruption == "crc":
        payload[data] ^= 1
    elif corruption == "deflate":
        payload[data] = 7  # Reserved DEFLATE block type.
    elif corruption in {"bzip2", "zstd"}:
        payload[data:data + 4] = b"BAD!"
    elif corruption == "lzma":
        payload[data + 4] = 0xff  # Invalid LZMA filter properties after the ZIP-LZMA header.
    else:
        raise AssertionError(corruption)
    return bytes(payload)


@pytest.mark.parametrize("member", ["xl/workbook.xml", "xl/worksheets/sheet1.xml"])
@pytest.mark.parametrize("corruption,compression,error", [
    ("unsupported", zipfile.ZIP_STORED, NotImplementedError),
    ("deflate", zipfile.ZIP_DEFLATED, zlib.error),
    ("bzip2", zipfile.ZIP_BZIP2, OSError),
    ("lzma", zipfile.ZIP_LZMA, lzma.LZMAError),
    ("zstd", zipfile.ZIP_ZSTANDARD, zstd.ZstdError),
    ("filename", zipfile.ZIP_STORED, UnicodeDecodeError),
    ("offset", zipfile.ZIP_STORED, ValueError),
    ("crc", zipfile.ZIP_STORED, zipfile.BadZipFile),
])
async def test_prepare_workbook_wraps_member_decode_errors_before_submission(
    tmp_path, monkeypatch, member, corruption, compression, error,
):
    source = corrupt_member(workbook(member, compression), member, corruption)
    office._validate_ooxml(source, "calc")  # Upload validation deliberately only inspects metadata.
    with zipfile.ZipFile(io.BytesIO(source)) as archive, pytest.raises(error):
        archive.read(member)
    with pytest.raises(office.OfficeError, match="^OFFICE_INPUT_INVALID$") as invalid:
        office.prepare_workbook(source)
    assert isinstance(invalid.value.__cause__, error)

    store = object_store(tmp_path)
    request = DocumentUploadRequest(sourceType="xlsx", fileName="source.xlsx",
        mediaType=next(iter(DOCUMENT_MEDIA_TYPES["xlsx"])), sizeBytes=len(source),
        sha256=hashlib.sha256(source).hexdigest())
    reference = await store.put_document(source, request)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_model", lambda: object())
    submit = AsyncMock(side_effect=AssertionError("Invalid workbook must not submit to Tencent"))
    convert = AsyncMock(side_effect=AssertionError("Invalid workbook must not start Office conversion"))
    monkeypatch.setattr(document, "parse_job", submit)
    monkeypatch.setattr(document, "normalize_source", convert)
    with pytest.raises(DocumentProcessingError) as structured:
        await document._prepare(cast(Any, {"document": reference.model_dump(mode="json")}), cast(Any, None))
    assert structured.value.status_code == 422 and structured.value.code == "OFFICE_INPUT_INVALID"
    submit.assert_not_awaited()
    convert.assert_not_awaited()
    assert await store.get_verified(reference) == source


@pytest.mark.parametrize("member", ["xl/workbook.xml", "xl/worksheets/sheet1.xml"])
@pytest.mark.parametrize("compression", [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED, zipfile.ZIP_BZIP2,
                                         zipfile.ZIP_LZMA, zipfile.ZIP_ZSTANDARD])
def test_prepare_workbook_preserves_valid_compressed_members(member, compression):
    source = workbook(member, compression)
    prepared, names = office.prepare_workbook(source)
    assert names == ["题目", "隐藏表"] and prepared != source
    assert office.prepare_workbook(prepared) == (prepared, names)
    with zipfile.ZipFile(io.BytesIO(source)) as original, zipfile.ZipFile(io.BytesIO(prepared)) as derived:
        assert original.namelist() == derived.namelist()
        assert b'state="hidden"' in original.read("xl/workbook.xml")
        assert b'state="visible"' in derived.read("xl/workbook.xml")
        for entry in original.infolist():
            assert derived.getinfo(entry.filename).compress_type == entry.compress_type
            if entry.filename != "xl/workbook.xml":
                assert original.read(entry) == derived.read(entry.filename)
