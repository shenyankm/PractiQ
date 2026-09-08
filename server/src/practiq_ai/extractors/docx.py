"""DOCX document extraction."""

import html
import re
from collections.abc import Iterator
from io import BytesIO
from zipfile import BadZipFile, ZipFile

from docx import Document
from docx.table import Table
from docx2python import docx2python
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, ConfigDict, StrictBytes

from ..config import load
from . import (
    DocumentProcessingError,
    ExtractedDocument,
    enforce_vision_bytes,
)

XML_TAG_PATTERN = re.compile(r"<[^>]+>")
CHART_POINT_PATTERN = re.compile(r"<c:pt\b")
OMATH_PATTERN = re.compile(r"<m:oMath\b.*?</m:oMath>", re.DOTALL)
TABLE_PATTERN = re.compile(r"<w:tbl(?:\s|>)")
MAX_DOCX_ENTRIES = 5_000
MAX_DOCX_EXPANDED_BYTES = 100 * 1024 * 1024
MAX_EMBEDDED_IMAGES = 50
IMAGE_SUFFIXES = ('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp')
RICH_PARTS = (
    'word/header',
    'word/footer',
    'word/footnotes.xml',
    'word/endnotes.xml',
    'word/comments.xml',
)


class DocxExtractionInput(BaseModel):
    model_config = ConfigDict(extra='forbid')

    file_bytes: StrictBytes


def _extract_docx_content(file_bytes: bytes) -> ExtractedDocument:
    warnings: list[str] = []
    try:
        if len(file_bytes) > load().source_max_bytes:
            raise DocumentProcessingError(413, 'Uploaded file is too large')
        names = _validate_docx_archive(file_bytes)
        rich_parts = any(name.startswith(RICH_PARTS) for name in names)
        try:
            raw_text = _extract_primary_text(file_bytes)
            primary_failed = False
        except Exception:  # noqa: BLE001 - fall back across python-docx backends
            raw_text = ''
            primary_failed = True

        supplemental = ''
        if primary_failed or not raw_text or rich_parts:
            try:
                with docx2python(BytesIO(file_bytes)) as content:
                    if not raw_text:
                        raw_text = content.text.strip()
                    if rich_parts:
                        supplemental = _extract_supplemental_text(content, raw_text)
            except Exception as exc:
                if primary_failed or not raw_text:
                    raise DocumentProcessingError(
                        400, 'DOCX preprocessing failed'
                    ) from exc
                warnings.append('DOCX supplemental content could not be extracted.')

        hints = extract_docx_hints(file_bytes)
        images, truncated = _extract_embedded_images(file_bytes, warnings)
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(400, 'DOCX preprocessing failed') from exc
    text = "\n\n".join(
        part for part in [raw_text, supplemental, hints] if part
    )
    return ExtractedDocument(
        text=text,
        warnings=warnings,
        embedded_images=images,
        truncated=truncated,
    )


extract_docx_content = StructuredTool.from_function(
    func=_extract_docx_content,
    name='extract_docx_content',
    description='Extract content from verified in-memory DOCX bytes.',
    args_schema=DocxExtractionInput,
)


def _validate_docx_archive(file_bytes: bytes) -> set[str]:
    try:
        with ZipFile(BytesIO(file_bytes)) as archive:
            infos = archive.infolist()
            names = {info.filename for info in infos}
            if 'word/document.xml' not in names:
                raise DocumentProcessingError(400, 'Uploaded file is not a DOCX document')
            if len(infos) > MAX_DOCX_ENTRIES or sum(info.file_size for info in infos) > MAX_DOCX_EXPANDED_BYTES:
                raise DocumentProcessingError(413, 'DOCX expanded content is too large')
            return names
    except BadZipFile as exc:
        raise DocumentProcessingError(400, 'Uploaded file is not a valid DOCX document') from exc


def _extract_primary_text(file_bytes: bytes) -> str:
    document = Document(BytesIO(file_bytes))
    parts: list[str] = []
    for block in document.iter_inner_content():
        text = _table_text(block) if isinstance(block, Table) else block.text.strip()
        if text:
            parts.append(text)
    return '\n\n'.join(parts)


def _table_text(table: Table) -> str:
    rows = []
    for row in table.rows:
        seen_cells: set[int] = set()
        cells = []
        for cell in row.cells:
            identity = id(cell._tc)
            if identity in seen_cells:
                continue
            seen_cells.add(identity)
            parts = [
                _table_text(block) if isinstance(block, Table) else block.text.strip()
                for block in cell.iter_inner_content()
            ]
            cells.append('\n'.join(part for part in parts if part))
        if any(cells):
            rows.append('\t'.join(cells).rstrip())
    return '\n'.join(rows)


def _extract_supplemental_text(content: object, primary_text: str) -> str:
    seen = {line.strip() for line in primary_text.splitlines() if line.strip()}
    sections = []
    for name in ('header', 'footer', 'footnotes', 'endnotes', 'comments'):
        values = []
        for value in _iter_section_text(name, getattr(content, name)):
            text = value.strip()
            if text and text not in seen:
                seen.add(text)
                values.append(text)
        if values:
            sections.append(f'[docx {name}]\n' + '\n'.join(values))
    return '\n\n'.join(sections)


def _iter_section_text(name: str, value: object) -> Iterator[str]:
    if name == 'comments' and isinstance(value, list):
        for comment in value:
            if (
                isinstance(comment, tuple)
                and len(comment) >= 4
                and isinstance(comment[3], str)
            ):
                yield comment[3]
        return
    yield from _iter_text(value)


def _iter_text(value: object) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from _iter_text(item)


def _extract_embedded_images(
    file_bytes: bytes, warnings: list[str]
) -> tuple[list[bytes], bool]:
    images: list[bytes] = []
    total_bytes = 0
    max_bytes = load().vision_max_bytes
    with ZipFile(BytesIO(file_bytes)) as archive:
        media_names = [
            name
            for name in archive.namelist()
            if name.startswith('word/media/') and name.lower().endswith(IMAGE_SUFFIXES)
        ]
        for name in media_names[:MAX_EMBEDDED_IMAGES]:
            with archive.open(name) as image_file:
                image = image_file.read(max_bytes - total_bytes + 1)
            total_bytes += len(image)
            enforce_vision_bytes(total_bytes)
            images.append(image)
        if len(media_names) > MAX_EMBEDDED_IMAGES:
            warnings.append(
                f'docx contains {len(media_names)} images; only the first '
                f'{MAX_EMBEDDED_IMAGES} were analyzed.'
            )
    return images, len(media_names) > MAX_EMBEDDED_IMAGES


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
        table_count = len(TABLE_PATTERN.findall(document_xml))
        formula_count = document_xml.count("<m:oMath")
        formulas = OMATH_PATTERN.findall(document_xml)
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
    ]
    return "\n".join(summary_parts)


def extract_chart_text(xml: str) -> list[str]:
    text = html.unescape(XML_TAG_PATTERN.sub("\n", xml))
    return [part.strip() for part in text.splitlines() if part.strip()]
