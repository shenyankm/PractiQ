import base64
from io import BytesIO
from zipfile import ZipFile

import pytest

import server.extractors as extractors
from server.extractors import DocumentProcessingError, extract
from server.extractors.csv import extract as extract_csv
from server.extractors.image import extract as extract_image
from server.extractors import pdf as pdf_extractor
from server.ai_schemas import DocumentParseRequest


def make_docx(with_image: bool = False, image_count: int = 1) -> bytes:
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
            for index in range(image_count):
                archive.writestr(
                    f'word/media/image{index + 1}.png', b'\x89PNG fake image bytes'
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
    sheet.title = 'Quiz'
    sheet.append(['1. What is 2+2?', 'A. 4', 'B. 5'])
    sheet.append(['Answer', 'A', None])
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def test_extract_csv_text_and_image() -> None:
    from PIL import Image

    csv_document = extract_csv('', b'question,answer\n"2 + 2",4')
    markdown = '  # Quiz\n\n    indented code\n'
    text_document = extract(DocumentParseRequest(sourceType='text', text=markdown))
    image_buffer = BytesIO()
    Image.new('RGB', (1, 1)).save(image_buffer, format='PNG')
    image_document = extract_image('', image_buffer.getvalue())

    assert csv_document.text == 'question\tanswer\n2 + 2\t4'
    assert text_document.text == markdown
    assert image_document.page_images == [image_buffer.getvalue()]


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
    monkeypatch.setenv('AI_SOURCE_MAX_BYTES', '4')

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract(DocumentParseRequest(sourceType='pdf', fileBase64=encoded))

    assert exc_info.value.status_code == status_code


@pytest.mark.parametrize(
    'payload',
    (
        DocumentParseRequest(sourceType='text', text='你好'),
        DocumentParseRequest(
            sourceType='pdf',
            text='你好',
            fileBase64=base64.b64encode(b'x').decode(),
        ),
    ),
)
def test_extract_enforces_utf8_text_upload_limit(
    monkeypatch: pytest.MonkeyPatch,
    payload: DocumentParseRequest,
) -> None:
    monkeypatch.setenv('AI_SOURCE_MAX_BYTES', '4')

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract(payload)

    assert exc_info.value.status_code == 413


def test_extract_rejects_invalid_unicode_text() -> None:
    with pytest.raises(DocumentProcessingError) as exc_info:
        extract(DocumentParseRequest(sourceType='text', text='\ud800'))

    assert exc_info.value.status_code == 400


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


def test_extract_pdf_enforces_rendered_image_byte_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('AI_MAX_VISION_BYTES', '1')

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract(
            DocumentParseRequest(
                sourceType='pdf',
                fileBase64=base64.b64encode(make_blank_pdf(pages=1)).decode(),
            )
        )

    assert exc_info.value.status_code == 413
    assert exc_info.value.detail == extractors.VISION_BYTES_LIMIT_DETAIL


def test_extract_pdf_rejects_oversized_page_before_render(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('AI_MAX_VISION_PAGE_PIXELS', '100')

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract(
            DocumentParseRequest(
                sourceType='pdf',
                fileBase64=base64.b64encode(make_blank_pdf(pages=1)).decode(),
            )
        )

    assert exc_info.value.status_code == 413


def test_extract_docx_enforces_cumulative_image_byte_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('AI_MAX_VISION_BYTES', '30')

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract(
            DocumentParseRequest(
                sourceType='docx',
                fileBase64=base64.b64encode(
                    make_docx(with_image=True, image_count=2)
                ).decode(),
            )
        )

    assert exc_info.value.status_code == 413
    assert exc_info.value.detail == extractors.VISION_BYTES_LIMIT_DETAIL


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


def test_extract_xlsx_rejects_oversized_expanded_archive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import server.extractors.xlsx as xlsx_extractor

    payload = BytesIO()
    with ZipFile(payload, 'w') as archive:
        archive.writestr('xl/workbook.xml', b'x' * 11)
    monkeypatch.setattr(xlsx_extractor, 'MAX_XLSX_EXPANDED_BYTES', 10)

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract(
            DocumentParseRequest(
                sourceType='xlsx',
                fileBase64=base64.b64encode(payload.getvalue()).decode(),
            )
        )

    assert exc_info.value.status_code == 413


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
    monkeypatch.setenv('AI_SOURCE_MAX_BYTES', 'nonsense')
    assert extractors.get_upload_max_bytes() == extractors.DEFAULT_UPLOAD_MAX_BYTES
