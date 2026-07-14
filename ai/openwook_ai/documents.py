from __future__ import annotations

import base64
import binascii
import json
import os
import re
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import cast
from zipfile import BadZipFile, ZipFile

import httpx
import mammoth

from .schemas import DocumentParseRequest, FileUploadWorkflowRequest


@dataclass
class NormalizedDocument:
    text: str
    html: str | None
    warnings: list[str]
    visual_hints: list[str]
    metadata: dict[str, object]


class DocumentProcessingError(RuntimeError):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


TEXT_NODE_PATTERN = re.compile(r"<[^>]*:t[^>]*>(.*?)</[^>]*:t>")
XML_TAG_PATTERN = re.compile(r"<[^>]+>")
CHART_POINT_PATTERN = re.compile(r"<c:pt\b")
DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
MAX_DOCX_ENTRIES = 5_000
MAX_DOCX_EXPANDED_BYTES = 100 * 1024 * 1024


def get_upload_max_bytes() -> int:
    try:
        value = int(os.getenv('IMPORT_SOURCE_MAX_BYTES', str(DEFAULT_UPLOAD_MAX_BYTES)))
    except ValueError:
        return DEFAULT_UPLOAD_MAX_BYTES
    return value if value > 0 else DEFAULT_UPLOAD_MAX_BYTES


def preprocess_upload(request: FileUploadWorkflowRequest) -> NormalizedDocument:
    if request.sourceType == 'txt':
        try:
            text = request.fileBytes.decode('utf-8-sig').strip()
        except UnicodeDecodeError as exc:
            raise DocumentProcessingError(400, 'TXT uploads must be UTF-8 encoded') from exc
        if not text:
            raise DocumentProcessingError(400, 'Uploaded file is empty')
        return NormalizedDocument(
            text=text,
            html=None,
            warnings=[],
            visual_hints=[],
            metadata={'byteLength': len(request.fileBytes), 'preprocessor': 'text'},
        )

    api_url = os.getenv('MINERU_API_URL', '').strip().rstrip('/')
    if not api_url:
        raise DocumentProcessingError(503, 'MinerU preprocessing is not configured')

    data = {
        'backend': os.getenv('MINERU_BACKEND', 'pipeline').strip() or 'pipeline',
        'lang_list': os.getenv('MINERU_LANGUAGE', 'ch').strip() or 'ch',
        'parse_method': request.parseMethod,
        'return_md': 'true',
        'return_middle_json': 'false',
        'return_model_output': 'false',
        'return_content_list': 'false',
        'return_images': 'false',
        'response_format_zip': 'false',
        'return_original_file': 'false',
    }
    timeout_seconds = _positive_float_env('MINERU_TIMEOUT_SECONDS', 600)
    timeout = httpx.Timeout(connect=10, read=timeout_seconds, write=timeout_seconds, pool=10)
    try:
        with httpx.Client(timeout=timeout) as client:
            response_context = client.stream(
                'POST',
                f'{api_url}/file_parse',
                data=data,
                files={
                    'files': (
                        Path(request.fileName).name,
                        request.fileBytes,
                        request.mimeType,
                    )
                },
            )
            with response_context as response:
                if response.status_code != 200:
                    raise DocumentProcessingError(502, 'MinerU preprocessing failed')
                response_body = read_limited_response(
                    response,
                    _positive_int_env('MINERU_MAX_RESPONSE_BYTES', 5 * 1024 * 1024),
                    'MinerU response is too large',
                )
    except httpx.HTTPError as exc:
        raise DocumentProcessingError(502, 'MinerU preprocessing request failed') from exc

    try:
        payload = json.loads(response_body)
        results = payload['results']
        parsed = next(iter(results.values()))
        markdown = parsed['md_content']
    except (KeyError, StopIteration, TypeError, ValueError, AttributeError) as exc:
        raise DocumentProcessingError(502, 'MinerU returned an invalid response') from exc

    if not isinstance(markdown, str) or not markdown.strip():
        raise DocumentProcessingError(422, 'MinerU did not extract any document content')

    return NormalizedDocument(
        text=markdown.strip(),
        html=None,
        warnings=[],
        visual_hints=[],
        metadata={
            'byteLength': len(request.fileBytes),
            'mineru': {
                'backend': payload.get('backend'),
                'version': payload.get('version'),
            },
        },
    )


def _positive_float_env(name: str, default: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _positive_int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def read_limited_response(
    response: httpx.Response,
    max_bytes: int,
    error_detail: str,
) -> bytes:
    body = bytearray()
    for chunk in response.iter_bytes():
        body.extend(chunk)
        if len(body) > max_bytes:
            raise DocumentProcessingError(502, error_detail)
    return bytes(body)


def normalize_document(request: DocumentParseRequest) -> NormalizedDocument:
    warnings: list[str] = []
    visual_hints: list[str] = []
    metadata: dict[str, object] = {}
    base_text = (request.text or "").lstrip("\ufeff").strip()
    file_bytes = _decode_uploaded_base64(request.fileBase64) if request.fileBase64 else None

    if file_bytes and request.sourceType == "docx":
        try:
            _validate_docx_archive(file_bytes)
            html_result = mammoth.convert_to_html(BytesIO(file_bytes))
            raw_text = mammoth.extract_raw_text(BytesIO(file_bytes))
            ooxml = extract_docx_hints(file_bytes)
        except DocumentProcessingError:
            raise
        except Exception as exc:
            raise DocumentProcessingError(400, 'DOCX preprocessing failed') from exc
        warnings.extend(
            [f"docx html: {message.message}" for message in html_result.messages]
        )
        warnings.extend(
            [f"docx text: {message.message}" for message in raw_text.messages]
        )
        visual_hints.extend(cast(list[str], ooxml["visual_hints"]))
        metadata["mammothMessages"] = [
            message.message for message in [*html_result.messages, *raw_text.messages]
        ]
        metadata["ooxml"] = {
            **cast(dict[str, object], ooxml["metadata"]),
            "chartSummaries": ooxml["chart_summaries"],
            "chemistryLikeText": ooxml["chemistry_like_text"],
        }
        metadata["byteLength"] = len(file_bytes)
        text = "\n\n".join(
            part
            for part in [base_text, raw_text.value.strip(), ooxml["summary_text"]]
            if part
        ).strip()
        return NormalizedDocument(
            text=text,
            html=html_result.value[:40_000],
            warnings=warnings,
            visual_hints=visual_hints,
            metadata=metadata,
        )

    if file_bytes:
        decoded = file_bytes.decode("utf-8", errors="ignore").lstrip("\ufeff").strip()
        metadata["byteLength"] = len(file_bytes)
        return NormalizedDocument(
            text="\n\n".join(part for part in [base_text, decoded] if part).strip(),
            html=None,
            warnings=warnings,
            visual_hints=visual_hints,
            metadata=metadata,
        )

    return NormalizedDocument(
        text=base_text,
        html=None,
        warnings=warnings,
        visual_hints=visual_hints,
        metadata=metadata,
    )


def _decode_uploaded_base64(value: str) -> bytes:
    max_bytes = get_upload_max_bytes()
    if len(value) > ((max_bytes + 2) // 3) * 4 + 4:
        raise DocumentProcessingError(413, 'Uploaded file is too large')
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise DocumentProcessingError(400, 'fileBase64 must contain valid base64') from exc
    if len(decoded) > max_bytes:
        raise DocumentProcessingError(413, 'Uploaded file is too large')
    return decoded


def _validate_docx_archive(file_bytes: bytes) -> None:
    try:
        with ZipFile(BytesIO(file_bytes)) as archive:
            infos = archive.infolist()
            if 'word/document.xml' not in {info.filename for info in infos}:
                raise DocumentProcessingError(400, 'Uploaded file is not a DOCX document')
            if len(infos) > MAX_DOCX_ENTRIES or sum(info.file_size for info in infos) > MAX_DOCX_EXPANDED_BYTES:
                raise DocumentProcessingError(413, 'DOCX expanded content is too large')
    except BadZipFile as exc:
        raise DocumentProcessingError(400, 'Uploaded file is not a valid DOCX document') from exc


def extract_docx_hints(file_bytes: bytes) -> dict[str, object]:
    with ZipFile(BytesIO(file_bytes)) as archive:
        names = archive.namelist()
        document_xml = (
            archive.read("word/document.xml").decode("utf-8", errors="ignore")
            if "word/document.xml" in names
            else ""
        )
        chart_files = [
            name
            for name in names
            if name.startswith("word/charts/") and name.endswith(".xml")
        ]
        image_files = [name for name in names if name.startswith("word/media/")]
        table_count = document_xml.count("<w:tbl")
        formula_count = document_xml.count("<m:oMath")
        drawing_count = document_xml.count("<w:drawing")
        chemistry_like_text = [
            text
            for text in extract_xml_text(document_xml)
            if "→" in text
            or "⇌" in text
            or ("+" in text and any(char.isdigit() for char in text))
        ]
        chart_summaries = []
        for file_name in chart_files[:8]:
            xml = archive.read(file_name).decode("utf-8", errors="ignore")
            chart_summaries.append(
                {
                    "fileName": file_name,
                    "title": " / ".join(extract_chart_text(xml)[:10]),
                    "pointCount": len(CHART_POINT_PATTERN.findall(xml)),
                }
            )

    visual_hints = [
        *([f"tables:{table_count}"] if table_count else []),
        *([f"formulas:{formula_count}"] if formula_count else []),
        *([f"drawings:{drawing_count}"] if drawing_count else []),
        *([f"embeddedImages:{len(image_files)}"] if image_files else []),
        *([f"charts:{len(chart_files)}"] if chart_files else []),
    ]
    summary_parts = [
        *([f"[docx formulas detected: {formula_count}]"] if formula_count else []),
        *([f"[docx tables detected: {table_count}]"] if table_count else []),
        *([f"[docx charts] {chart_summaries}"] if chart_summaries else []),
        *chemistry_like_text,
    ]
    return {
        "visual_hints": visual_hints,
        "summary_text": "\n".join(summary_parts),
        "chart_summaries": chart_summaries,
        "chemistry_like_text": chemistry_like_text,
        "metadata": {
            "tableCount": table_count,
            "formulaCount": formula_count,
            "drawingCount": drawing_count,
            "embeddedImageCount": len(image_files),
            "chartCount": len(chart_files),
        },
    }


def extract_xml_text(xml: str) -> list[str]:
    values: list[str] = []
    for match in TEXT_NODE_PATTERN.findall(xml):
        text = decode_xml_entities(match).strip()
        if text:
            values.append(text)
    return values


def extract_chart_text(xml: str) -> list[str]:
    text = decode_xml_entities(XML_TAG_PATTERN.sub("\n", xml))
    return [part.strip() for part in text.splitlines() if part.strip()]


def decode_xml_entities(value: str) -> str:
    return (
        value.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
    )
