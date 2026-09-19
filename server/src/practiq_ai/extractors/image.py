"""Image document extraction."""

from io import BytesIO

from PIL import Image

from ..config import load
from . import DocumentProcessingError, ExtractedDocument


def extract(file_bytes: bytes) -> ExtractedDocument:
    try:
        with Image.open(BytesIO(file_bytes)) as image:
            if image.format not in {"PNG", "JPEG"}:
                raise DocumentProcessingError(422, 'Only PNG and JPEG images are supported', 'IMAGE_FORMAT_UNSUPPORTED')
            if image.width * image.height > load().max_vision_page_pixels:
                raise DocumentProcessingError(413, 'Image exceeds pixel limit', 'IMAGE_TOO_LARGE')
            if getattr(image, 'n_frames', 1) != 1:
                raise DocumentProcessingError(422, 'Multi-frame images are not supported', 'IMAGE_MULTIFRAME_UNSUPPORTED')
            image.verify()
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(400, 'Image preprocessing failed') from exc
    return ExtractedDocument(text="", page_images=[file_bytes])
