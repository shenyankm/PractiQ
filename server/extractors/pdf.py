from __future__ import annotations

from io import BytesIO

import pypdfium2 as pdfium

from . import DocumentProcessingError, ExtractedDocument, positive_env

DEFAULT_MAX_OCR_PAGES = 1000
SCANNED_PAGE_TEXT_THRESHOLD = 20
RENDER_SCALE = 200 / 72  # ~200dpi


def get_max_ocr_pages() -> int:
    return positive_env('AI_MAX_OCR_PAGES', DEFAULT_MAX_OCR_PAGES)


def page_text(page: pdfium.PdfPage) -> str:
    textpage = page.get_textpage()
    try:
        return textpage.get_text_range().strip()
    finally:
        textpage.close()


def extract(base_text: str, file_bytes: bytes | None) -> ExtractedDocument:
    if not file_bytes:
        return ExtractedDocument(text=base_text)

    try:
        document = pdfium.PdfDocument(file_bytes)
    except Exception as exc:
        raise DocumentProcessingError(400, 'PDF preprocessing failed') from exc
    try:
        max_pages = get_max_ocr_pages()
        if len(document) > max_pages:
            raise DocumentProcessingError(413, f'PDF exceeds the {max_pages}-page limit')
        page_texts = []
        for index in range(len(document)):
            page = document[index]
            page_texts.append(page_text(page))
            page.close()
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(400, 'PDF preprocessing failed') from exc
    finally:
        document.close()

    scanned_indexes = [
        index
        for index, text in enumerate(page_texts)
        if len(text) < SCANNED_PAGE_TEXT_THRESHOLD
    ]
    warnings: list[str] = []
    page_images: list[bytes] = []
    if scanned_indexes:
        warnings.append(
            f'{len(scanned_indexes)} of {len(page_texts)} PDF pages have no '
            'extractable text; they were rendered for OCR.'
        )
        page_images = render_pages(file_bytes, scanned_indexes)

    text = '\n\n'.join(part for part in [base_text, *page_texts] if part)
    return ExtractedDocument(text=text, warnings=warnings, page_images=page_images)


def render_pages(file_bytes: bytes, indexes: list[int]) -> list[bytes]:
    images: list[bytes] = []
    document = pdfium.PdfDocument(file_bytes)
    try:
        for index in indexes:
            page = document[index]
            bitmap = page.render(scale=RENDER_SCALE)
            buffer = BytesIO()
            bitmap.to_pil().save(buffer, format='PNG')
            images.append(buffer.getvalue())
            page.close()
    finally:
        document.close()
    return images
