"""CSV document extraction."""

import csv
from io import StringIO

from . import DocumentProcessingError, ExtractedDocument


def extract(file_bytes: bytes) -> ExtractedDocument:
    try:
        rows = csv.reader(StringIO(file_bytes.decode('utf-8-sig')))
        text = '\n'.join('\t'.join(cell.strip() for cell in row) for row in rows if any(cell.strip() for cell in row))
    except (csv.Error, UnicodeDecodeError) as exc:
        raise DocumentProcessingError(400, 'CSV preprocessing failed') from exc
    return ExtractedDocument(text=text)
