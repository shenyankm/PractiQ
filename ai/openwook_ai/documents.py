from __future__ import annotations

import base64
import re
from dataclasses import dataclass
from io import BytesIO
from zipfile import ZipFile

import mammoth

from .schemas import DocumentParseRequest


@dataclass
class NormalizedDocument:
    text: str
    html: str | None
    warnings: list[str]
    visual_hints: list[str]
    metadata: dict[str, object]


TEXT_NODE_PATTERN = re.compile(r'<[^>]*:t[^>]*>(.*?)</[^>]*:t>')
XML_TAG_PATTERN = re.compile(r'<[^>]+>')
CHART_POINT_PATTERN = re.compile(r'<c:pt\b')


def normalize_document(request: DocumentParseRequest) -> NormalizedDocument:
    warnings: list[str] = []
    visual_hints: list[str] = []
    metadata: dict[str, object] = {}
    base_text = (request.text or '').lstrip('\ufeff').strip()
    file_bytes = base64.b64decode(request.fileBase64) if request.fileBase64 else None

    if file_bytes and request.sourceType == 'docx':
        html_result = mammoth.convert_to_html(BytesIO(file_bytes))
        raw_text = mammoth.extract_raw_text(BytesIO(file_bytes))
        ooxml = extract_docx_hints(file_bytes)
        warnings.extend([f'docx html: {message.message}' for message in html_result.messages])
        warnings.extend([f'docx text: {message.message}' for message in raw_text.messages])
        visual_hints.extend(ooxml['visual_hints'])
        metadata['mammothMessages'] = [message.message for message in [*html_result.messages, *raw_text.messages]]
        metadata['ooxml'] = {
            **ooxml['metadata'],
            'chartSummaries': ooxml['chart_summaries'],
            'chemistryLikeText': ooxml['chemistry_like_text'],
        }
        metadata['byteLength'] = len(file_bytes)
        text = '\n\n'.join(part for part in [base_text, raw_text.value.strip(), ooxml['summary_text']] if part).strip()
        return NormalizedDocument(
            text=text,
            html=html_result.value[:40_000],
            warnings=warnings,
            visual_hints=visual_hints,
            metadata=metadata,
        )

    if file_bytes:
        decoded = file_bytes.decode('utf-8', errors='ignore').lstrip('\ufeff').strip()
        metadata['byteLength'] = len(file_bytes)
        return NormalizedDocument(
            text='\n\n'.join(part for part in [base_text, decoded] if part).strip(),
            html=None,
            warnings=warnings,
            visual_hints=visual_hints,
            metadata=metadata,
        )

    return NormalizedDocument(text=base_text, html=None, warnings=warnings, visual_hints=visual_hints, metadata=metadata)


def extract_docx_hints(file_bytes: bytes) -> dict[str, object]:
    with ZipFile(BytesIO(file_bytes)) as archive:
        names = archive.namelist()
        document_xml = archive.read('word/document.xml').decode('utf-8', errors='ignore') if 'word/document.xml' in names else ''
        chart_files = [name for name in names if name.startswith('word/charts/') and name.endswith('.xml')]
        image_files = [name for name in names if name.startswith('word/media/')]
        table_count = document_xml.count('<w:tbl')
        formula_count = document_xml.count('<m:oMath')
        drawing_count = document_xml.count('<w:drawing')
        chemistry_like_text = [
            text
            for text in extract_xml_text(document_xml)
            if '→' in text or '⇌' in text or ('+' in text and any(char.isdigit() for char in text))
        ]
        chart_summaries = []
        for file_name in chart_files[:8]:
            xml = archive.read(file_name).decode('utf-8', errors='ignore')
            chart_summaries.append(
                {
                    'fileName': file_name,
                    'title': ' / '.join(extract_chart_text(xml)[:10]),
                    'pointCount': len(CHART_POINT_PATTERN.findall(xml)),
                }
            )

    visual_hints = [
        *([f'tables:{table_count}'] if table_count else []),
        *([f'formulas:{formula_count}'] if formula_count else []),
        *([f'drawings:{drawing_count}'] if drawing_count else []),
        *([f'embeddedImages:{len(image_files)}'] if image_files else []),
        *([f'charts:{len(chart_files)}'] if chart_files else []),
    ]
    summary_parts = [
        *([f'[docx formulas detected: {formula_count}]'] if formula_count else []),
        *([f'[docx tables detected: {table_count}]'] if table_count else []),
        *([f'[docx charts] {chart_summaries}'] if chart_summaries else []),
        *chemistry_like_text,
    ]
    return {
        'visual_hints': visual_hints,
        'summary_text': '\n'.join(summary_parts),
        'chart_summaries': chart_summaries,
        'chemistry_like_text': chemistry_like_text,
        'metadata': {
            'tableCount': table_count,
            'formulaCount': formula_count,
            'drawingCount': drawing_count,
            'embeddedImageCount': len(image_files),
            'chartCount': len(chart_files),
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
    text = decode_xml_entities(XML_TAG_PATTERN.sub('\n', xml))
    return [part.strip() for part in text.splitlines() if part.strip()]


def decode_xml_entities(value: str) -> str:
    return (
        value.replace('&lt;', '<')
        .replace('&gt;', '>')
        .replace('&amp;', '&')
        .replace('&quot;', '"')
        .replace('&apos;', "'")
    )
