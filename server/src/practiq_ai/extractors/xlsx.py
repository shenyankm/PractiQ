"""Worksheet text, anchored images and Calc views for joint visual extraction."""

import posixpath
import time
from copy import copy
from io import BytesIO
from typing import Any
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile

from openpyxl import load_workbook
from openpyxl.utils.cell import get_column_letter
from PIL import Image

from ..config import load
from . import DocumentProcessingError, ExtractedDocument, enforce_vision_bytes
from .docx import convert_to_pdf
from .pdf import extract as extract_pdf

PREPARE_SECONDS = 150  # Leave headroom inside the shared 180-second prepare deadline.
MAX_ROWS_PER_SHEET = 10_000
MAX_XLSX_ENTRIES = 5_000
MAX_XLSX_EXPANDED_BYTES = 100 * 1024 * 1024
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
D = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'


def _xml(data: bytes) -> ET.Element:
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise DocumentProcessingError(400, 'Unsafe workbook XML', 'XLSX_INVALID_XML')
    return ET.fromstring(data)


def _relationships(archive: ZipFile, part: str) -> dict[str, str | None]:
    path = posixpath.join(posixpath.dirname(part), '_rels', posixpath.basename(part) + '.rels')
    if path not in archive.namelist():
        return {}
    result = {}
    for relation in _xml(archive.read(path)):
        target = unquote(relation.get('Target', ''))
        if relation.get('TargetMode') == 'External':
            result[relation.get('Id', '')] = None
            continue
        resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(part), target))
        if not target or '\\' in target or urlsplit(target).scheme or resolved.startswith('../') or resolved not in archive.namelist():
            raise DocumentProcessingError(400, 'Invalid workbook relationship', 'XLSX_INVALID_RELATIONSHIP')
        result[relation.get('Id', '')] = resolved
    return result


def _anchor(node: ET.Element) -> str | None:
    positions = []
    for name in ('from', 'to'):
        marker = node.find(f'{{{D}}}{name}')
        if marker is not None:
            col = int(marker.findtext(f'{{{D}}}col', '0')) + 1
            row = int(marker.findtext(f'{{{D}}}row', '0')) + 1
            if not 1 <= col <= 16384 or not 1 <= row <= 1048576:
                raise DocumentProcessingError(400, 'Invalid drawing anchor', 'XLSX_INVALID_ANCHOR')
            positions.append(f'{get_column_letter(col)}{row}')
    return ':'.join(positions) or None


def _png(data: bytes) -> bytes:
    try:
        with Image.open(BytesIO(data)) as image:
            if image.width * image.height > load().max_vision_page_pixels:
                raise DocumentProcessingError(413, 'Worksheet image exceeds pixel limit', 'XLSX_IMAGE_TOO_LARGE')
            image.load()
            output = BytesIO()
            rgba = image.convert('RGBA')
            background = Image.new('RGBA', image.size, 'white')
            background.alpha_composite(rgba)
            background.convert('RGB').save(output, format='PNG')
            return output.getvalue()
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(400, 'Cannot decode worksheet image', 'XLSX_IMAGE_INVALID') from exc


def _drawings(archive: ZipFile, part: str, sheet: ET.Element) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    assets: list[dict[str, Any]] = []
    objects: list[dict[str, Any]] = []
    warnings: list[str] = []
    total_bytes = 0
    relations = _relationships(archive, part)
    for drawing in sheet.findall(f'{{{S}}}drawing'):
        path = relations.get(drawing.get(f'{{{R}}}id', ''))
        if path is None:
            warnings.append('External or missing drawing was not loaded.')
            continue
        drawing_relations = _relationships(archive, path)
        for index, node in enumerate(_xml(archive.read(path))):
            object_id = f'{path}#{index}'
            location = {'objectId': object_id, 'cellRange': _anchor(node)}
            blips = node.findall(f'.//{{{A}}}blip')
            if node.find(f'{{{D}}}pic') is not None and len(blips) == 1:
                image_path = drawing_relations.get(blips[0].get(f'{{{R}}}embed', ''))
                if image_path is None:
                    warnings.append(f'{object_id}: external or missing image was not loaded.')
                    continue
                original = archive.read(image_path)
                try:
                    png = _png(original)
                except DocumentProcessingError as exc:
                    if exc.status_code == 413:
                        raise
                    warnings.append(f'{object_id}: {exc.code}')
                    continue
                total_bytes += len(png) + len(original)
                enforce_vision_bytes(total_bytes)
                with Image.open(BytesIO(original)) as image:
                    original_type = Image.MIME.get(image.format or '', 'application/octet-stream')
                assets.append({**location, 'data': png, 'original': original, 'originalMediaType': original_type, 'mediaType': 'image/png'})
            else:
                # Charts, shapes and grouped drawings require the layout renderer.
                objects.append(location)
    for tag in ('legacyDrawing', 'legacyDrawingHF', 'oleObjects', 'controls', 'extLst'):
        if sheet.find(f'{{{S}}}{tag}') is not None:
            warnings.append(f'Unsupported worksheet object: {tag}; not interpreted.')
    return assets, objects, warnings


def _render_copy(archive: ZipFile, target_part: str, target_index: int) -> bytes:
    """Change only XML print/visibility metadata; preserve drawing/chart bytes."""
    output = BytesIO()
    with ZipFile(output, 'w') as result:
        for info in archive.infolist():
            data = archive.read(info)
            if info.filename == 'xl/workbook.xml':
                root = _xml(data)
                for index, sheet in enumerate(root.findall(f'{{{S}}}sheets/{{{S}}}sheet')):
                    sheet.set('state', 'visible' if index == target_index else 'hidden')
                for view in root.findall(f'{{{S}}}bookViews/{{{S}}}workbookView'):
                    view.set('activeTab', str(target_index))
                    view.set('firstSheet', str(target_index))
                names = root.find(f'{{{S}}}definedNames')
                if names is not None:
                    for name in list(names):
                        if name.get('name', '').startswith('_xlnm.Print_'):
                            names.remove(name)
                external = root.find(f'{{{S}}}externalReferences')
                if external is not None:
                    root.remove(external)
                data = ET.tostring(root)
            elif info.filename.startswith('xl/worksheets/') and info.filename.endswith('.xml'):
                root = _xml(data)
                # Rendering must not recalculate formulas (including network functions).
                # Cached values remain, while formulas without a cache stay blank.
                for cell in root.findall(f'.//{{{S}}}c'):
                    formula = cell.find(f'{{{S}}}f')
                    if formula is not None:
                        cell.remove(formula)
                if info.filename == target_part:
                    for tag in ('pageSetup', 'rowBreaks', 'colBreaks'):
                        child = root.find(f'{{{S}}}{tag}')
                        if child is not None:
                            root.remove(child)
                for view in root.findall(f'{{{S}}}sheetViews/{{{S}}}sheetView'):
                    view.set('tabSelected', '1' if info.filename == target_part else '0')
                data = ET.tostring(root)
            elif info.filename.endswith('.rels'):
                root = _xml(data)
                for relation in list(root):
                    if relation.get('TargetMode') == 'External':
                        root.remove(relation)
                data = ET.tostring(root)
            result.writestr(copy(info), data)
    return output.getvalue()


def extract(file_bytes: bytes) -> ExtractedDocument:
    deadline = time.monotonic() + PREPARE_SECONDS
    _validate_archive(file_bytes)
    try:
        workbook = load_workbook(BytesIO(file_bytes), read_only=True, data_only=True, keep_links=False)
    except Exception as exc:
        raise DocumentProcessingError(400, 'XLSX preprocessing failed') from exc
    sheets: list[dict[str, Any]] = []
    warnings: list[str] = []
    text_parts: list[str] = []
    visual_bytes = page_count = total_chars = 0
    config = load()
    try:
        with ZipFile(BytesIO(file_bytes)) as archive:
            relations = _relationships(archive, 'xl/workbook.xml')
            entries = _xml(archive.read('xl/workbook.xml')).findall(f'{{{S}}}sheets/{{{S}}}sheet')
            if len(entries) != len(workbook.worksheets):
                raise DocumentProcessingError(400, 'Unsupported workbook sheet type', 'XLSX_SHEET_UNSUPPORTED')
            for index, worksheet in enumerate(workbook.worksheets):
                unit: dict[str, Any] = {'sheetName': worksheet.title, 'text': '', 'assets': [], 'objects': [], 'warnings': [], 'failureCode': None}
                sheets.append(unit)
                try:
                    if time.monotonic() >= deadline:
                        raise DocumentProcessingError(504, 'Workbook preparation time limit reached', 'XLSX_PREPARE_TIMEOUT')
                    part = relations.get(entries[index].get(f'{{{R}}}id', ''))
                    if part is None:
                        raise DocumentProcessingError(400, 'Missing worksheet relationship', 'XLSX_INVALID_RELATIONSHIP')
                    xml = _xml(archive.read(part))
                    if worksheet.max_row and worksheet.max_row > MAX_ROWS_PER_SHEET:
                        raise DocumentProcessingError(413, 'Worksheet exceeds row limit', 'XLSX_SHEET_TOO_LARGE')
                    lines = [f'[sheet] {worksheet.title}', f'[visibility] {worksheet.sheet_state}']
                    chars = sum(map(len, lines))
                    for row_index, row in enumerate(worksheet.iter_rows(), start=1):
                        if row_index > MAX_ROWS_PER_SHEET:
                            raise DocumentProcessingError(413, 'Worksheet exceeds row limit', 'XLSX_SHEET_TOO_LARGE')
                        cells = [f'{cell.coordinate}={cell.value}' for cell in row if cell.value is not None]
                        if cells:
                            line = '\t'.join(cells)
                            lines.append(line)
                            chars += len(line) + 1
                        if chars > min(config.max_total_input_chars, config.model_max_input_chars - 10_000):
                            raise DocumentProcessingError(413, 'Worksheet exceeds model input limit', 'XLSX_SHEET_TOO_LARGE')
                    for merged in xml.findall(f'{{{S}}}mergeCells/{{{S}}}mergeCell'):
                        lines.append(f'[merged] {merged.get("ref")}')
                    for cell in xml.findall(f'.//{{{S}}}c'):
                        if cell.find(f'{{{S}}}f') is not None and not cell.findtext(f'{{{S}}}v'):
                            unit['warnings'].append(f'Formula at {cell.get("r")} has no cached value; not calculated.')
                    unit['text'] = '\n'.join(lines)
                    total_chars += len(unit['text'])
                    if total_chars > config.max_total_input_chars:
                        raise DocumentProcessingError(413, 'Workbook exceeds text limit', 'XLSX_TEXT_LIMIT')
                    assets, objects, drawing_warnings = _drawings(archive, part, xml)
                    unit['assets'], unit['objects'] = assets, objects
                    unit['warnings'].extend(drawing_warnings)
                    if objects:
                        render_source = _render_copy(archive, part, index)
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise DocumentProcessingError(504, 'Workbook preparation time limit reached', 'XLSX_PREPARE_TIMEOUT')
                        rendered = extract_pdf(convert_to_pdf(render_source, source_type='xlsx', timeout_seconds=remaining))
                        for page, data in enumerate(rendered.page_images):
                            assets.append({'objectId': f'render:{page}', 'cellRange': None, 'data': data, 'mediaType': 'image/png'})
                        page_count += len(rendered.page_images)
                    visual_bytes += sum(len(asset['data']) + len(asset.get('original', b'')) for asset in assets)
                    enforce_vision_bytes(visual_bytes)
                    if page_count > load().max_document_pages:
                        raise DocumentProcessingError(413, 'Workbook exceeds page limit', 'XLSX_PAGE_LIMIT')
                except DocumentProcessingError as exc:
                    unit['failureCode'] = exc.code
                    unit['warnings'].append(exc.detail)
                    unit['assets'] = []
                except (KeyError, ValueError, ET.ParseError, OSError, BadZipFile) as exc:
                    unit['failureCode'] = 'XLSX_SHEET_INVALID'
                    unit['warnings'].append(f'Cannot prepare worksheet: {type(exc).__name__}')
                    unit['assets'] = []
                warnings.extend(f'{worksheet.title}: {warning}' for warning in unit['warnings'])
                text_parts.append(unit['text'])
    finally:
        workbook.close()
    return ExtractedDocument(text='\n\n'.join(text_parts), worksheets=sheets, warnings=warnings, truncated=any(s['warnings'] or s['failureCode'] for s in sheets))


def _validate_archive(file_bytes: bytes) -> None:
    try:
        with ZipFile(BytesIO(file_bytes)) as archive:
            infos = archive.infolist()
            names = {info.filename for info in infos}
            if 'xl/workbook.xml' not in names:
                raise DocumentProcessingError(400, 'Uploaded file is not an XLSX document')
            if len(infos) > MAX_XLSX_ENTRIES or sum(info.file_size for info in infos) > MAX_XLSX_EXPANDED_BYTES:
                raise DocumentProcessingError(413, 'XLSX expanded content is too large')
            if len(names) != len(infos) or any(name.startswith('/') or '..' in name.split('/') for name in names):
                raise DocumentProcessingError(400, 'Invalid XLSX archive paths')
            if any('vbaproject' in name.lower() for name in names):
                raise DocumentProcessingError(400, 'Macros are not supported', 'XLSX_MACROS_UNSUPPORTED')
    except BadZipFile as exc:
        raise DocumentProcessingError(400, 'Uploaded file is not a valid XLSX document') from exc
