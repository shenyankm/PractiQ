from io import BytesIO
from zipfile import ZipFile

import pytest
from docx import Document
from docx.document import Document as DocxDocument
from langchain_core.tools import StructuredTool
from pydantic import ValidationError

from practiq_ai import extractors
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import ExtractedDocument, extract
from practiq_ai.extractors import docx as docx_extractor
from practiq_ai.extractors import pdf as pdf_extractor


def make_docx(
    with_image: bool = False,
    image_count: int = 1,
    *,
    body_text: str = "H2 + O2 → H2O",
    header_text: str = "",
    footer_text: str = "",
    comment_text: str = "",
) -> bytes:
    document = Document()
    if header_text:
        document.sections[0].header.paragraphs[0].text = header_text
    body = document.add_paragraph(body_text)
    if comment_text:
        document.add_comment(body.runs, text=comment_text, author="Reviewer")
    document.add_paragraph()
    table = document.add_table(rows=2, cols=2)
    table.rows[0].cells[0].text = "Question"
    table.rows[0].cells[1].text = "Answer"
    table.rows[1].cells[0].text = "2 + 2"
    table.rows[1].cells[1].text = "4"
    document.add_paragraph("Escaped <text> & final paragraph")
    if footer_text:
        document.sections[0].footer.paragraphs[0].text = footer_text
    return package_docx(document, with_image, image_count)


def package_docx(
    document: DocxDocument,
    with_image: bool = False,
    image_count: int = 1,
) -> bytes:
    source = BytesIO()
    document.save(source)

    buffer = BytesIO()
    with ZipFile(source) as original, ZipFile(buffer, "w") as archive:
        for info in original.infolist():
            value = original.read(info.filename)
            if info.filename == "word/document.xml":
                value = value.replace(b"</w:body>", b"<m:oMath/></w:body>")
            archive.writestr(info, value)
        archive.writestr(
            "word/charts/chart1.xml",
            "<c:chart><a:t>Scores &amp; totals</a:t><c:pt/><c:pt/></c:chart>",
        )
        if with_image:
            for index in range(image_count):
                archive.writestr(
                    f"word/media/image{index + 1}.png", b"\x89PNG fake image bytes"
                )
    return buffer.getvalue()


def make_blank_pdf(pages: int, size: int = 200) -> bytes:
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument.new()
    for _ in range(pages):
        document.new_page(size, size)
    buffer = BytesIO()
    document.save(buffer)
    document.close()
    return buffer.getvalue()


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


def test_extract_docx_text_warnings_hints_and_images() -> None:
    document = extract(
        "docx",
        make_docx(with_image=True),
        "Prompt context",
    )

    assert document.warnings == []
    assert document.text.startswith("Prompt context\n\nH2 + O2 → H2O")
    assert (
        "H2 + O2 → H2O\n\nQuestion\tAnswer\n2 + 2\t4\n\n"
        "Escaped <text> & final paragraph"
    ) in document.text
    assert "[docx formulas detected: 1]" in document.text
    assert "[docx tables detected: 1]" in document.text
    assert "Scores & totals" in document.text
    assert document.embedded_images == [b"\x89PNG fake image bytes"]


def test_docx_extraction_is_a_bytes_only_structured_tool() -> None:
    tool = docx_extractor.extract_docx_content

    assert isinstance(tool, StructuredTool)
    assert set(docx_extractor.DocxExtractionInput.model_fields) == {"file_bytes"}
    for value in (
        "https://example.com/quiz.docx",
        "file:///tmp/quiz.docx",
        "/tmp/quiz.docx",
        "UEsDBAoAAAAA",
        "practiq-agent/sources/deadbeef/source.docx",
    ):
        with pytest.raises(ValidationError):
            tool.invoke({"file_bytes": value})

    with pytest.raises(ValidationError):
        tool.invoke({"file_bytes": make_docx(), "url": "https://example.com"})
    with pytest.raises(DocumentProcessingError, match="valid DOCX"):
        tool.invoke({"file_bytes": b"file:///tmp/quiz.docx"})


def test_docx_tool_enforces_source_size(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_SOURCE_MAX_BYTES", "1")

    with pytest.raises(DocumentProcessingError) as exc_info:
        docx_extractor.extract_docx_content.invoke({"file_bytes": make_docx()})

    assert exc_info.value.status_code == 413


def test_docx_tool_is_registered_only_for_docx(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from PIL import Image

    calls = 0

    class RecordingTool:
        def invoke(self, value: dict[str, bytes]) -> ExtractedDocument:
            nonlocal calls
            calls += 1
            assert isinstance(value["file_bytes"], bytes)
            return ExtractedDocument(text="docx tool output")

    monkeypatch.setattr(docx_extractor, "extract_docx_content", RecordingTool())
    assert extract("docx", make_docx()).text == "docx tool output"

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


def test_docx_uses_docx2python_only_for_rich_parts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = docx_extractor.docx2python

    def unexpected_call(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("docx2python should not run for a plain DOCX")

    monkeypatch.setattr(docx_extractor, "docx2python", unexpected_call)
    assert "H2 + O2 → H2O" in extract("docx", make_docx()).text

    calls = 0

    def tracked_call(*args: object, **kwargs: object) -> object:
        nonlocal calls
        calls += 1
        return original(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(docx_extractor, "docx2python", tracked_call)
    rich = extract(
        "docx",
        make_docx(
            body_text="Repeated content",
            header_text="Repeated content",
            footer_text="Footer only",
            comment_text="Correct answer is B",
        ),
    )

    assert calls == 1
    assert rich.text.count("Repeated content") == 1
    assert "[docx header]" not in rich.text
    assert "[docx footer]\nFooter only" in rich.text
    assert "[docx comments]\nCorrect answer is B" in rich.text
    assert "Reviewer" not in rich.text


def test_docx_extracts_nested_tables_without_repeating_merged_cells() -> None:
    source = Document()
    source.add_paragraph("Before")
    outer = source.add_table(rows=1, cols=1)
    outer.cell(0, 0).text = "Outer"
    outer.cell(0, 0).add_table(rows=1, cols=1).cell(0, 0).text = "Nested question"
    merged = source.add_table(rows=1, cols=2).cell(0, 0).merge(
        source.tables[-1].cell(0, 1)
    )
    merged.text = "Merged question"
    source.add_paragraph("After")

    text = extract("docx", package_docx(source)).text

    assert text.index("Before") < text.index("Nested question") < text.index("After")
    assert "Outer\nNested question" in text
    assert text.count("Merged question") == 1


def test_docx_falls_back_to_docx2python(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(docx_extractor, "_extract_primary_text", lambda _value: "")

    document = extract("docx", make_docx())

    assert "H2 + O2 → H2O" in document.text
    assert "Question" in document.text


def test_docx_returns_existing_error_when_both_parsers_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail(*_args: object, **_kwargs: object) -> None:
        raise ValueError("parser failed")

    monkeypatch.setattr(docx_extractor, "_extract_primary_text", fail)
    monkeypatch.setattr(docx_extractor, "docx2python", fail)

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("docx", make_docx())

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "DOCX preprocessing failed"


def test_extract_enforces_source_size(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_SOURCE_MAX_BYTES", "4")

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("pdf", b"12345")

    assert exc_info.value.status_code == 413


def test_extract_pdf_with_embedded_text_skips_ocr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    texts = iter(["1. What is 2+2? A. 4 B. 5", "2. What is 3+3? A. 6 B. 7"])
    monkeypatch.setattr(pdf_extractor, "page_text", lambda _page: next(texts))

    document = extract("pdf", make_blank_pdf(pages=2))

    assert "1. What is 2+2?" in document.text
    assert "2. What is 3+3?" in document.text
    assert document.page_images == []
    assert document.warnings == []


def test_extract_pdf_renders_scanned_pages_for_ocr() -> None:
    document = extract("pdf", make_blank_pdf(pages=1))

    assert len(document.page_images) == 1
    assert document.page_images[0].startswith(b"\x89PNG")
    assert any("rendered for OCR" in warning for warning in document.warnings)


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
    assert "1. What is 2+2?\tA. 4\tB. 5" in document.text
    assert "Answer\tA" in document.text


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


def test_docx_marks_excess_images_as_truncated() -> None:
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
    assert any("remaining rows were skipped" in warning for warning in document.warnings)
