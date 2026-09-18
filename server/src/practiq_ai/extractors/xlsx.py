"""XLSX document extraction."""

from io import BytesIO
from zipfile import BadZipFile, ZipFile

from openpyxl import load_workbook

from . import DocumentProcessingError, ExtractedDocument

MAX_ROWS_PER_SHEET = 10_000
MAX_XLSX_ENTRIES = 5_000
MAX_XLSX_EXPANDED_BYTES = 100 * 1024 * 1024


def extract(file_bytes: bytes) -> ExtractedDocument:
    warnings: list[str] = []
    truncated = False
    try:
        _validate_archive(file_bytes)
        workbook = load_workbook(BytesIO(file_bytes), read_only=True, data_only=True)
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(400, 'XLSX preprocessing failed') from exc

    parts: list[str] = []
    try:
        for sheet in workbook.worksheets:
            lines = [f'[sheet] {sheet.title}']
            for row_index, row in enumerate(sheet.iter_rows(values_only=True)):
                if row_index >= MAX_ROWS_PER_SHEET:
                    truncated = True
                    warnings.append(
                        f'Sheet {sheet.title} exceeds {MAX_ROWS_PER_SHEET} rows; '
                        'remaining rows were skipped.'
                    )
                    break
                cells = ['' if cell is None else str(cell) for cell in row]
                if any(cells):
                    lines.append('\t'.join(cells).rstrip())
            if len(lines) > 1:
                parts.append('\n'.join(lines))
    finally:
        workbook.close()

    text = '\n\n'.join(parts)
    return ExtractedDocument(text=text, warnings=warnings, truncated=truncated)


def _validate_archive(file_bytes: bytes) -> None:
    try:
        with ZipFile(BytesIO(file_bytes)) as archive:
            infos = archive.infolist()
            names = {info.filename for info in infos}
            if 'xl/workbook.xml' not in names:
                raise DocumentProcessingError(400, 'Uploaded file is not an XLSX document')
            if (
                len(infos) > MAX_XLSX_ENTRIES
                or sum(info.file_size for info in infos) > MAX_XLSX_EXPANDED_BYTES
            ):
                raise DocumentProcessingError(413, 'XLSX expanded content is too large')
    except BadZipFile as exc:
        raise DocumentProcessingError(400, 'Uploaded file is not a valid XLSX document') from exc
