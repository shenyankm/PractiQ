import base64
from io import BytesIO
from zipfile import ZipFile

import pytest

import server.extractors as extractors
from server.extractors import DocumentProcessingError, extract
from server.extractors import pdf as pdf_extractor
from server.ai_schemas import DocumentParseRequest


def make_docx(with_image: bool = False) -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, 'w') as archive:
        archive.writestr(
            'word/document.xml',
            '<w:document><w:t>H&#50; + O&#50; → H&#50;O</w:t>'
            '<w:tbl/><m:oMath/></w:document>',
        )
        archive.writestr(
            'word/charts/chart1.xml',
            '<c:chart><a:t>Scores &amp; totals</a:t><c:pt/><c:pt/></c:chart>',
        )
        if with_image:
            archive.writestr('word/media/image1.png', b'\x89PNG fake image bytes')
    return buffer.getvalue()


def make_blank_pdf(pages: int) -> bytes:
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument.new()
    for _ in range(pages):
        document.new_page(200, 200)
    buffer = BytesIO()
    document.save(buffer)
    document.close()
    return buffer.getvalue()


def make_xlsx() -> bytes:
    from openpyxl import Workbook

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = 'Quiz'
    sheet.append(['1. What is 2+2?', 'A. 4', 'B. 5'])
    sheet.append(['Answer', 'A', None])
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def test_extract_txt_combines_text_and_base64() -> None:
    document = extract(
        DocumentParseRequest(
            sourceType='txt',
            text='\ufeffTyped instructions',
            fileBase64=base64.b64encode(b'\xef\xbb\xbfUploaded text').decode(),
        )
    )

    assert document.text == 'Typed instructions\n\nUploaded text'
    assert document.warnings == []
    assert document.page_images == []


def test_extract_docx_text_warnings_hints_and_images() -> None:
    document = extract(
        DocumentParseRequest(
            sourceType='docx',
            text='Prompt context',
            fileBase64=base64.b64encode(make_docx(with_image=True)).decode(),
        )
    )

    assert document.warnings == []
    assert document.text.startswith('Prompt context\n\nH2 + O2 → H2O')
    assert '[docx formulas detected: 1]' in document.text
    assert '[docx tables detected: 1]' in document.text
    assert 'Scores & totals' in document.text
    assert document.embedded_images == [b'\x89PNG fake image bytes']


@pytest.mark.parametrize(
    ('encoded', 'status_code'),
    (
        ('not base64', 400),
        (base64.b64encode(b'12345').decode(), 413),
    ),
)
def test_extract_enforces_base64_upload_limits(
    monkeypatch: pytest.MonkeyPatch,
    encoded: str,
    status_code: int,
) -> None:
    monkeypatch.setenv('IMPORT_SOURCE_MAX_BYTES', '4')

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract(DocumentParseRequest(sourceType='txt', fileBase64=encoded))

    assert exc_info.value.status_code == status_code


def test_extract_pdf_with_embedded_text_skips_ocr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    texts = iter(['1. What is 2+2? A. 4 B. 5', '2. What is 3+3? A. 6 B. 7'])
    monkeypatch.setattr(pdf_extractor, 'page_text', lambda _page: next(texts))

    document = extract(
        DocumentParseRequest(
            sourceType='pdf',
            fileBase64=base64.b64encode(make_blank_pdf(pages=2)).decode(),
        )
    )

    assert '1. What is 2+2?' in document.text
    assert '2. What is 3+3?' in document.text
    assert document.page_images == []
    assert document.warnings == []


def test_extract_pdf_renders_scanned_pages_for_ocr() -> None:
    document = extract(
        DocumentParseRequest(
            sourceType='pdf',
            fileBase64=base64.b64encode(make_blank_pdf(pages=1)).decode(),
        )
    )

    assert len(document.page_images) == 1
    assert document.page_images[0].startswith(b'\x89PNG')
    assert any('rendered for OCR' in warning for warning in document.warnings)


def test_extract_pdf_enforces_page_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AI_MAX_OCR_PAGES', '1')

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract(
            DocumentParseRequest(
                sourceType='pdf',
                fileBase64=base64.b64encode(make_blank_pdf(pages=2)).decode(),
            )
        )

    assert exc_info.value.status_code == 413


def test_extract_xlsx_produces_tabbed_sheet_text() -> None:
    document = extract(
        DocumentParseRequest(
            sourceType='xlsx',
            fileBase64=base64.b64encode(make_xlsx()).decode(),
        )
    )

    assert '[sheet] Quiz' in document.text
    assert '1. What is 2+2?\tA. 4\tB. 5' in document.text
    assert 'Answer\tA' in document.text


def test_extract_rejects_corrupt_docx_and_xlsx() -> None:
    for source_type in ('docx', 'xlsx'):
        with pytest.raises(DocumentProcessingError) as exc_info:
            extract(
                DocumentParseRequest(
                    sourceType=source_type,
                    fileBase64=base64.b64encode(b'not an archive').decode(),
                )
            )
        assert exc_info.value.status_code == 400


def test_get_upload_max_bytes_falls_back_on_bad_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('IMPORT_SOURCE_MAX_BYTES', 'nonsense')
    assert extractors.get_upload_max_bytes() == extractors.DEFAULT_UPLOAD_MAX_BYTES
