from io import BytesIO
from zipfile import ZipFile

import pytest
from pydantic import ValidationError

from practiq_ai import extractors
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import ExtractedDocument, extract
from practiq_ai.extractors import docx as docx_extractor
from tests.support import make_blank_pdf, make_docx


def make_xlsx() -> bytes:
    from openpyxl import Workbook

    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet.title = "Quiz"
    sheet.append(["1. What is 2+2?", "A. 4", "B. 5"])
    sheet.append(["Answer", "A", None])
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def test_extract_csv_text_and_image() -> None:
    from PIL import Image

    csv_document = extract("csv", b'question,answer\n"2 + 2",4')
    markdown = "  # Quiz\n\n    indented code\n"
    text_document = extract("text", markdown.encode())
    image_buffer = BytesIO()
    Image.new("RGB", (1, 1)).save(image_buffer, format="PNG")
    image_document = extract("image", image_buffer.getvalue())

    assert csv_document.text == "question\tanswer\n2 + 2\t4"
    assert text_document.text == markdown
    assert image_document.page_images == [image_buffer.getvalue()]


def test_extract_docx_pages_and_original_images(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(docx_extractor, "convert_to_pdf", lambda _: make_blank_pdf(2))
    document = extract("docx", make_docx(with_image=True))
    assert document.text == ""
    assert len(document.page_images) == 2
    assert document.embedded_images == [b"\x89PNG fake image bytes"]


def test_docx_extraction_accepts_only_bytes() -> None:
    for value in (
        "https://example.com/quiz.docx",
        "file:///tmp/quiz.docx",
        "/tmp/quiz.docx",
        "UEsDBAoAAAAA",
        "practiq-agent/sources/deadbeef/source.docx",
    ):
        with pytest.raises(ValidationError):
            docx_extractor.extract_docx_content(value)  # type: ignore[arg-type]

    with pytest.raises(ValidationError):
        docx_extractor.extract_docx_content(make_docx(), url="https://example.com")  # type: ignore[call-arg]
    with pytest.raises(DocumentProcessingError, match="valid DOCX"):
        docx_extractor.extract_docx_content(b"file:///tmp/quiz.docx")


def test_docx_extraction_enforces_source_size(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_SOURCE_MAX_BYTES", "1")

    with pytest.raises(DocumentProcessingError) as exc_info:
        docx_extractor.extract_docx_content(make_docx())

    assert exc_info.value.status_code == 413


def test_docx_extractor_is_used_only_for_docx(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from PIL import Image

    calls = 0

    def recording_extractor(file_bytes: bytes) -> ExtractedDocument:
        nonlocal calls
        calls += 1
        assert isinstance(file_bytes, bytes)
        return ExtractedDocument(text="docx output")

    monkeypatch.setattr(docx_extractor, "extract_docx_content", recording_extractor)
    assert extract("docx", make_docx()).text == "docx output"

    image_buffer = BytesIO()
    Image.new("RGB", (1, 1)).save(image_buffer, format="PNG")
    for source_type, payload in (
        ("text", b"plain text"),
        ("csv", b"question,answer\n2 + 2,4"),
        ("image", image_buffer.getvalue()),
        ("pdf", make_blank_pdf(pages=1)),
        ("xlsx", make_xlsx()),
    ):
        extract(source_type, payload)  # type: ignore[arg-type]
    assert calls == 1


def test_extract_enforces_source_size(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_SOURCE_MAX_BYTES", "4")

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("pdf", b"12345")

    assert exc_info.value.status_code == 413


def test_extract_pdf_renders_every_page() -> None:
    document = extract("pdf", make_blank_pdf(pages=2))
    assert document.text == ""
    assert len(document.page_images) == 2
    assert all(image.startswith(b"\x89PNG") for image in document.page_images)
    assert document.warnings == []


def test_extract_pdf_enforces_page_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_MAX_DOCUMENT_PAGES", "1")

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("pdf", make_blank_pdf(pages=2))

    assert exc_info.value.status_code == 413


def test_extract_pdf_enforces_rendered_image_byte_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_MAX_VISION_BYTES", "1")

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("pdf", make_blank_pdf(pages=1))

    assert exc_info.value.status_code == 413
    assert exc_info.value.detail == extractors.VISION_BYTES_LIMIT_DETAIL


def test_extract_pdf_rejects_oversized_page_before_render(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_MAX_VISION_PAGE_PIXELS", "100")

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("pdf", make_blank_pdf(pages=1))

    assert exc_info.value.status_code == 413


def test_extract_docx_enforces_cumulative_image_byte_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_MAX_VISION_BYTES", "30")

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("docx", make_docx(with_image=True, image_count=2))

    assert exc_info.value.status_code == 413
    assert exc_info.value.detail == extractors.VISION_BYTES_LIMIT_DETAIL


def test_extract_xlsx_produces_tabbed_sheet_text() -> None:
    document = extract("xlsx", make_xlsx())

    assert "[sheet] Quiz" in document.text
    assert "A1=1. What is 2+2?\tB1=A. 4\tC1=B. 5" in document.text
    assert "A2=Answer\tB2=A" in document.text


def test_extract_xlsx_rejects_oversized_expanded_archive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import practiq_ai.extractors.xlsx as xlsx_extractor

    payload = BytesIO()
    with ZipFile(payload, "w") as archive:
        archive.writestr("xl/workbook.xml", b"x" * 11)
    monkeypatch.setattr(xlsx_extractor, "MAX_XLSX_EXPANDED_BYTES", 10)

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("xlsx", payload.getvalue())

    assert exc_info.value.status_code == 413


def test_extract_rejects_corrupt_docx_and_xlsx() -> None:
    for source_type in ("docx", "xlsx"):
        with pytest.raises(DocumentProcessingError) as exc_info:
            extract(source_type, b"not an archive")
        assert exc_info.value.status_code == 400


@pytest.mark.parametrize(
    ("source_type", "payload"),
    (
        ("text", b"\xff"),
        ("csv", b"\xff"),
        ("image", b"not an image"),
        ("pdf", b"not a pdf"),
    ),
)
def test_extract_rejects_invalid_source_payloads(
    source_type: str, payload: bytes
) -> None:
    with pytest.raises(DocumentProcessingError) as exc_info:
        extract(source_type, payload)  # type: ignore[arg-type]
    assert exc_info.value.status_code == 400


def test_docx_rejects_missing_or_oversized_archive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import practiq_ai.extractors.docx as docx_extractor

    missing = BytesIO()
    with ZipFile(missing, "w") as archive:
        archive.writestr("word/other.xml", "<w:document/>")
    with pytest.raises(DocumentProcessingError, match="not a DOCX"):
        extract("docx", missing.getvalue())

    monkeypatch.setattr(docx_extractor, "MAX_DOCX_EXPANDED_BYTES", 1)
    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("docx", make_docx())
    assert exc_info.value.status_code == 413


def test_docx_marks_excess_images_as_truncated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(docx_extractor, "convert_to_pdf", lambda _: make_blank_pdf(1))
    document = extract("docx", make_docx(with_image=True, image_count=51))

    assert len(document.embedded_images) == 50
    assert document.truncated is True
    assert any("only the first 50" in warning for warning in document.warnings)


def test_xlsx_rejects_non_workbook_and_marks_row_truncation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import practiq_ai.extractors.xlsx as xlsx_extractor

    missing = BytesIO()
    with ZipFile(missing, "w") as archive:
        archive.writestr("not-workbook.xml", "x")
    with pytest.raises(DocumentProcessingError, match="not an XLSX"):
        extract("xlsx", missing.getvalue())

    malformed = BytesIO()
    with ZipFile(malformed, "w") as archive:
        archive.writestr("xl/workbook.xml", "x")
    with pytest.raises(DocumentProcessingError, match="preprocessing failed"):
        extract("xlsx", malformed.getvalue())

    monkeypatch.setattr(xlsx_extractor, "MAX_ROWS_PER_SHEET", 1)
    document = extract("xlsx", make_xlsx())
    assert document.truncated is True
    assert document.worksheets[0]["failureCode"] == "XLSX_SHEET_TOO_LARGE"
