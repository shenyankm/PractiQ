from __future__ import annotations

import html
import re
from io import BytesIO
from zipfile import BadZipFile, ZipFile

import mammoth

from . import DocumentProcessingError, ExtractedDocument

TEXT_NODE_PATTERN = re.compile(r"<[^>]*:t[^>]*>(.*?)</[^>]*:t>")
XML_TAG_PATTERN = re.compile(r"<[^>]+>")
CHART_POINT_PATTERN = re.compile(r"<c:pt\b")
OMATH_PATTERN = re.compile(r"<m:oMath\b.*?</m:oMath>", re.DOTALL)
MAX_DOCX_ENTRIES = 5_000
MAX_DOCX_EXPANDED_BYTES = 100 * 1024 * 1024
MAX_EMBEDDED_IMAGES = 50
IMAGE_SUFFIXES = ('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp')


def extract(base_text: str, file_bytes: bytes | None) -> ExtractedDocument:
    if not file_bytes:
        return ExtractedDocument(text=base_text)

    warnings: list[str] = []
    try:
        _validate_docx_archive(file_bytes)
        raw_text = mammoth.extract_raw_text(BytesIO(file_bytes))
        hints = extract_docx_hints(file_bytes)
        images = _extract_embedded_images(file_bytes, warnings)
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(400, 'DOCX preprocessing failed') from exc
    warnings.extend(f"docx text: {message.message}" for message in raw_text.messages)
    text = "\n\n".join(
        part for part in [base_text, raw_text.value.strip(), hints] if part
    )
    return ExtractedDocument(text=text, warnings=warnings, embedded_images=images)


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


def _extract_embedded_images(file_bytes: bytes, warnings: list[str]) -> list[bytes]:
    images: list[bytes] = []
    with ZipFile(BytesIO(file_bytes)) as archive:
        media_names = [
            name
            for name in archive.namelist()
            if name.startswith('word/media/') and name.lower().endswith(IMAGE_SUFFIXES)
        ]
        for name in media_names[:MAX_EMBEDDED_IMAGES]:
            images.append(archive.read(name))
        if len(media_names) > MAX_EMBEDDED_IMAGES:
            warnings.append(
                f'docx contains {len(media_names)} images; only the first '
                f'{MAX_EMBEDDED_IMAGES} were analyzed.'
            )
    return images


def extract_docx_hints(file_bytes: bytes) -> str:
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
        table_count = document_xml.count("<w:tbl")
        formula_count = document_xml.count("<m:oMath")
        formulas = OMATH_PATTERN.findall(document_xml)
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

    summary_parts = [
        *([f"[docx formulas detected: {formula_count}]"] if formula_count else []),
        # OMML 公式原文透传，由 LLM 转 LaTeX
        *(f"[docx formula OMML] {formula}" for formula in formulas[:200]),
        *([f"[docx tables detected: {table_count}]"] if table_count else []),
        *([f"[docx charts] {chart_summaries}"] if chart_summaries else []),
        *chemistry_like_text,
    ]
    return "\n".join(summary_parts)


def extract_xml_text(xml: str) -> list[str]:
    values: list[str] = []
    for match in TEXT_NODE_PATTERN.findall(xml):
        text = html.unescape(match).strip()
        if text:
            values.append(text)
    return values


def extract_chart_text(xml: str) -> list[str]:
    text = html.unescape(XML_TAG_PATTERN.sub("\n", xml))
    return [part.strip() for part in text.splitlines() if part.strip()]
