import base64
import os
from dataclasses import dataclass, field

from ..ai_schemas import DocumentParseRequest

DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
DEFAULT_VISION_MAX_BYTES = 50 * 1024 * 1024
VISION_BYTES_LIMIT_DETAIL = 'Document visual content exceeds the configured limit'


class DocumentProcessingError(RuntimeError):
    def __init__(self, status_code: int, detail: str, code: str = 'DOCUMENT_PROCESSING_FAILED') -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.code = code


@dataclass
class ExtractedDocument:
    text: str
    warnings: list[str] = field(default_factory=list)
    page_images: list[bytes] = field(default_factory=list)
    embedded_images: list[bytes] = field(default_factory=list)


def positive_env[NumberT: (int, float)](name: str, default: NumberT, cast: type[NumberT] = int) -> NumberT:
    try:
        value = cast(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def get_upload_max_bytes() -> int:
    return positive_env('AI_SOURCE_MAX_BYTES', DEFAULT_UPLOAD_MAX_BYTES)


def get_vision_max_bytes() -> int:
    return positive_env('AI_MAX_VISION_BYTES', DEFAULT_VISION_MAX_BYTES)


def enforce_vision_bytes(total: int) -> None:
    if total > get_vision_max_bytes():
        raise DocumentProcessingError(413, VISION_BYTES_LIMIT_DETAIL)


def decode_uploaded_base64(value: str) -> bytes:
    max_bytes = get_upload_max_bytes()
    if len(value) > ((max_bytes + 2) // 3) * 4 + 4:
        raise DocumentProcessingError(413, 'Uploaded file is too large')
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError as exc:  # binascii.Error 是 ValueError 的子类
        raise DocumentProcessingError(400, 'fileBase64 must contain valid base64') from exc
    if len(decoded) > max_bytes:
        raise DocumentProcessingError(413, 'Uploaded file is too large')
    return decoded


def extract(request: DocumentParseRequest) -> ExtractedDocument:
    if request.sourceType == 'text':
        return ExtractedDocument(text=request.text or '')

    from .csv import extract as extract_csv
    from .docx import extract as extract_docx
    from .image import extract as extract_image
    from .pdf import extract as extract_pdf
    from .xlsx import extract as extract_xlsx

    extractor = {
        'csv': extract_csv,
        'docx': extract_docx,
        'image': extract_image,
        'pdf': extract_pdf,
        'xlsx': extract_xlsx,
    }[request.sourceType]
    document = extractor(
        request.text or '', decode_uploaded_base64(request.fileBase64 or '')
    )
    document.text = document.text.strip()
    return document
