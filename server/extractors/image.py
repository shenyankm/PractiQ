from io import BytesIO

from PIL import Image

from . import DocumentProcessingError, ExtractedDocument


def extract(base_text: str, file_bytes: bytes | None) -> ExtractedDocument:
    if not file_bytes:
        return ExtractedDocument(text=base_text)
    try:
        with Image.open(BytesIO(file_bytes)) as image:
            image.verify()
    except Exception as exc:
        raise DocumentProcessingError(400, 'Image preprocessing failed') from exc
    return ExtractedDocument(text=base_text, page_images=[file_bytes])
