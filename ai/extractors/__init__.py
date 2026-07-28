from __future__ import annotations

import base64
import os
from dataclasses import dataclass, field

from schemas import DocumentParseRequest

DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024


class DocumentProcessingError(RuntimeError):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


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
    return positive_env('IMPORT_SOURCE_MAX_BYTES', DEFAULT_UPLOAD_MAX_BYTES)


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
    from . import docx, pdf, txt, xlsx

    extractors = {
        'docx': docx.extract,
        'pdf': pdf.extract,
        'xlsx': xlsx.extract,
        'txt': txt.extract,
        'text': txt.extract,
    }
    extractor = extractors.get(request.sourceType)
    if extractor is None:
        raise DocumentProcessingError(400, f'Unsupported sourceType: {request.sourceType}')

    base_text = (request.text or '').lstrip('\ufeff').strip()
    file_bytes = decode_uploaded_base64(request.fileBase64) if request.fileBase64 else None
    document = extractor(base_text, file_bytes)
    document.text = document.text.strip()
    return document
