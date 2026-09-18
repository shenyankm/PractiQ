"""PDF document extraction."""

from io import BytesIO
from math import ceil
from typing import Any, cast

import pypdfium2 as pdfium

from ..config import load
from . import (
    DocumentProcessingError,
    ExtractedDocument,
    enforce_vision_bytes,
)

RENDER_SCALE = 200 / 72  # ~200dpi


def extract(base_text: str, file_bytes: bytes) -> ExtractedDocument:
    try:
        document = pdfium.PdfDocument(file_bytes)
        try:
            count = len(document)
            max_pages = load().max_document_pages
            if count > max_pages:
                raise DocumentProcessingError(
                    413, f"PDF exceeds the {max_pages}-page limit"
                )
        finally:
            document.close()
        return ExtractedDocument(
            text="", page_images=render_pages(file_bytes, list(range(count)))
        )
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(400, "PDF preprocessing failed") from exc


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
                if rendered_pixels > load().max_vision_page_pixels:
                    raise DocumentProcessingError(
                        413, "PDF page exceeds the configured visual pixel limit"
                    )
                bitmap = page.render(scale=cast(Any, RENDER_SCALE))
                try:
                    image = bitmap.to_pil()
                    try:
                        with BytesIO() as buffer:
                            image.save(buffer, format="PNG")
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
