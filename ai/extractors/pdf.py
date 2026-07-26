from __future__ import annotations

import os
from io import BytesIO

from pypdf import PdfReader

from . import DocumentProcessingError, ExtractedDocument

DEFAULT_MAX_OCR_PAGES = 1000
SCANNED_PAGE_TEXT_THRESHOLD = 20
RENDER_SCALE = 200 / 72  # ~200dpi


def get_max_ocr_pages() -> int:
    try:
        value = int(os.getenv('AI_MAX_OCR_PAGES', str(DEFAULT_MAX_OCR_PAGES)))
    except ValueError:
        return DEFAULT_MAX_OCR_PAGES
    return value if value > 0 else DEFAULT_MAX_OCR_PAGES


def extract(base_text: str, file_bytes: bytes | None) -> ExtractedDocument:
    if not file_bytes:
        return ExtractedDocument(text=base_text)

    try:
        reader = PdfReader(BytesIO(file_bytes))
        page_texts = [(page.extract_text() or '').strip() for page in reader.pages]
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(400, 'PDF preprocessing failed') from exc

    max_pages = get_max_ocr_pages()
    if len(page_texts) > max_pages:
        raise DocumentProcessingError(413, f'PDF exceeds the {max_pages}-page limit')

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
    import pypdfium2 as pdfium

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
