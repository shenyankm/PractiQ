from io import BytesIO
from math import ceil

import pypdfium2 as pdfium

from . import (
    DocumentProcessingError,
    ExtractedDocument,
    enforce_vision_bytes,
    positive_env,
)

DEFAULT_MAX_OCR_PAGES = 1000
DEFAULT_MAX_VISION_PAGE_PIXELS = 25_000_000
SCANNED_PAGE_TEXT_THRESHOLD = 20
RENDER_SCALE = 200 / 72  # ~200dpi


def get_max_ocr_pages() -> int:
    return positive_env('AI_MAX_OCR_PAGES', DEFAULT_MAX_OCR_PAGES)


def get_max_vision_page_pixels() -> int:
    return positive_env(
        'AI_MAX_VISION_PAGE_PIXELS', DEFAULT_MAX_VISION_PAGE_PIXELS
    )


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
            try:
                page_texts.append(page_text(page))
            finally:
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
    total_bytes = 0
    document = pdfium.PdfDocument(file_bytes)
    try:
        for index in indexes:
            page = document[index]
            try:
                width, height = page.get_size()
                rendered_pixels = ceil(width * RENDER_SCALE) * ceil(
                    height * RENDER_SCALE
                )
                if rendered_pixels > get_max_vision_page_pixels():
                    raise DocumentProcessingError(
                        413, 'PDF page exceeds the configured visual pixel limit'
                    )
                bitmap = page.render(scale=RENDER_SCALE)
                try:
                    image = bitmap.to_pil()
                    try:
                        with BytesIO() as buffer:
                            image.save(buffer, format='PNG')
                            data = buffer.getvalue()
                    finally:
                        image.close()
                finally:
                    bitmap.close()
            finally:
                page.close()
            total_bytes += len(data)
            enforce_vision_bytes(total_bytes)
            images.append(data)
    finally:
        document.close()
    return images
