from dataclasses import dataclass, field

from ..config import load
from ..contracts import DocumentSourceType
from ..errors import DocumentProcessingError

VISION_BYTES_LIMIT_DETAIL = "Document visual content exceeds the configured limit"


@dataclass
class ExtractedDocument:
    text: str
    warnings: list[str] = field(default_factory=list)
    page_images: list[bytes] = field(default_factory=list)
    embedded_images: list[bytes] = field(default_factory=list)
    truncated: bool = False


def enforce_vision_bytes(total: int) -> None:
    if total > load().vision_max_bytes:
        raise DocumentProcessingError(413, VISION_BYTES_LIMIT_DETAIL)


def extract(
    source_type: DocumentSourceType,
    payload: bytes,
) -> ExtractedDocument:
    if len(payload) > load().source_max_bytes:
        raise DocumentProcessingError(413, "Uploaded file is too large")
    if source_type == "text":
        try:
            return ExtractedDocument(text=payload.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise DocumentProcessingError(400, "text must contain valid UTF-8") from exc

    from .csv import extract as extract_csv
    from .image import extract as extract_image
    from .pdf import extract as extract_pdf

    extractor = {
        "csv": extract_csv,
        "image": extract_image,
        "pdf": extract_pdf,
    }[source_type]
    document = extractor(payload)
    document.text = document.text.strip()
    return document
