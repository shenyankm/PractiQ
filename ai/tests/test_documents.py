from __future__ import annotations

import base64
from importlib import import_module
from io import BytesIO
from pathlib import Path
import sys
from types import SimpleNamespace
from typing import Any
from zipfile import ZipFile

import pytest
from pydantic import BaseModel


AI_ROOT = Path(__file__).resolve().parents[1]
if str(AI_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_ROOT))


DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def require_document_module() -> Any:
    try:
        return import_module("openwook_ai.documents")
    except ModuleNotFoundError as exc:
        pytest.fail(f"Migration contract missing module openwook_ai.documents: {exc}")


def require_document_member(name: str) -> Any:
    module = require_document_module()
    try:
        member = getattr(module, name)
    except AttributeError:
        pytest.fail(f"Migration contract missing {name} in openwook_ai.documents")

    assert callable(member), f"{name} must be callable"
    return member


def require_schema_model(name: str) -> type[BaseModel]:
    try:
        module = import_module("openwook_ai.schemas")
    except ModuleNotFoundError as exc:
        pytest.fail(f"Migration contract missing module openwook_ai.schemas: {exc}")

    try:
        model = getattr(module, name)
    except AttributeError:
        pytest.fail(f"Migration contract missing schema {name} in openwook_ai.schemas")

    assert isinstance(model, type) and issubclass(model, BaseModel), f"{name} must be a pydantic model"
    return model


def make_document_request(**overrides: Any) -> BaseModel:
    model = require_schema_model("DocumentParseRequest")
    payload = {
        "sourceType": "text",
        "fileName": None,
        "text": None,
        "fileBase64": None,
        "mimeType": None,
    }
    payload.update(overrides)
    return model.model_validate(payload)


def make_synthetic_docx() -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr(
            "word/document.xml",
            """
            <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                        xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
              <w:body>
                <w:p><w:r><w:t>H2 + O2 → H2O</w:t></w:r></w:p>
                <w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
                <m:oMath><m:r><m:t>x+y</m:t></m:r></m:oMath>
                <w:drawing />
              </w:body>
            </w:document>
            """.strip(),
        )
        archive.writestr(
            "word/charts/chart1.xml",
            """
            <c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
              <c:chart>
                <c:title><c:tx><c:rich><a:t xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">Scores</a:t></c:rich></c:tx></c:title>
                <c:ser>
                  <c:pt idx="0"><c:v>1</c:v></c:pt>
                  <c:pt idx="1"><c:v>2</c:v></c:pt>
                </c:ser>
              </c:chart>
            </c:chartSpace>
            """.strip(),
        )
        archive.writestr("word/media/image1.png", b"png")
    return buffer.getvalue()


def fake_mammoth_result(value: str, *messages: str) -> Any:
    return SimpleNamespace(
        value=value,
        messages=[SimpleNamespace(message=message) for message in messages],
    )


def test_normalize_document_strips_utf8_bom_from_base_text_and_uploaded_txt_file() -> None:
    normalize_document = require_document_member("normalize_document")
    file_bytes = b"\xef\xbb\xbfUploaded text"

    document = normalize_document(
        make_document_request(
            sourceType="txt",
            fileName="questions.txt",
            mimeType="text/plain",
            text="\ufeffTyped instructions",
            fileBase64=base64.b64encode(file_bytes).decode("ascii"),
        )
    )

    assert document.text == "Typed instructions\n\nUploaded text"
    assert document.html is None
    assert document.warnings == []
    assert document.visual_hints == []
    assert document.metadata == {"byteLength": len(file_bytes)}


def test_extract_docx_hints_counts_visual_ooxml_features_from_synthetic_archive() -> None:
    extract_docx_hints = require_document_member("extract_docx_hints")

    result = extract_docx_hints(make_synthetic_docx())

    assert result["visual_hints"] == [
        "tables:1",
        "formulas:1",
        "drawings:1",
        "embeddedImages:1",
        "charts:1",
    ]
    assert result["metadata"] == {
        "tableCount": 1,
        "formulaCount": 1,
        "drawingCount": 1,
        "embeddedImageCount": 1,
        "chartCount": 1,
    }


def test_normalize_document_combines_mammoth_outputs_with_truncated_html_and_ooxml_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = require_document_module()
    normalize_document = require_document_member("normalize_document")
    file_bytes = make_synthetic_docx()

    monkeypatch.setattr(
        module.mammoth,
        "convert_to_html",
        lambda _stream: fake_mammoth_result("H" * 50_123, "html warning"),
    )
    monkeypatch.setattr(
        module.mammoth,
        "extract_raw_text",
        lambda _stream: fake_mammoth_result("Raw docx text", "text warning"),
    )

    document = normalize_document(
        make_document_request(
            sourceType="docx",
            fileName="questions.docx",
            mimeType=DOCX_MIME,
            text="Prompt context",
            fileBase64=base64.b64encode(file_bytes).decode("ascii"),
        )
    )

    assert document.text.startswith("Prompt context\n\nRaw docx text")
    assert "[docx formulas detected: 1]" in document.text
    assert "[docx tables detected: 1]" in document.text
    assert "[docx charts]" in document.text
    assert "H2 + O2 → H2O" in document.text
    assert document.html == "H" * 40_000
    assert document.warnings == ["docx html: html warning", "docx text: text warning"]
    assert document.visual_hints == [
        "tables:1",
        "formulas:1",
        "drawings:1",
        "embeddedImages:1",
        "charts:1",
    ]
    assert document.metadata["mammothMessages"] == ["html warning", "text warning"]
    assert document.metadata["ooxml"]["tableCount"] == 1
    assert document.metadata["ooxml"]["formulaCount"] == 1
    assert document.metadata["ooxml"]["drawingCount"] == 1
    assert document.metadata["ooxml"]["embeddedImageCount"] == 1
    assert document.metadata["ooxml"]["chartCount"] == 1
    assert document.metadata["ooxml"]["chartSummaries"] == [
        {
            "fileName": "word/charts/chart1.xml",
            "title": "Scores / 1 / 2",
            "pointCount": 2,
        }
    ]
    assert document.metadata["ooxml"]["chemistryLikeText"] == ["H2 + O2 → H2O"]
    assert document.metadata["byteLength"] == len(file_bytes)
