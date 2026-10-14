"""CSV document extraction."""

import csv
from io import StringIO

from . import DocumentProcessingError, ExtractedDocument


def extract(file_bytes: bytes) -> ExtractedDocument:
    try:
        lines = []
        tabular_rows_safe = True
        for row in csv.reader(StringIO(file_bytes.decode('utf-8-sig'))):
            if not any(cell.strip() for cell in row):
                continue
            tabular_rows_safe &= not any(len(cell.splitlines()) > 1 or '\t' in cell or '\r' in cell or '\n' in cell for cell in row)
            lines.append('\t'.join(cell.strip() for cell in row))
        text = '\n'.join(lines)
    except (csv.Error, UnicodeDecodeError) as exc:
        raise DocumentProcessingError(400, 'CSV preprocessing failed') from exc
    return ExtractedDocument(text=text, tabular_rows_safe=tabular_rows_safe)
