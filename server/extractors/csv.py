import csv
from io import StringIO

from . import DocumentProcessingError, ExtractedDocument


def extract(base_text: str, file_bytes: bytes | None) -> ExtractedDocument:
    if not file_bytes:
        return ExtractedDocument(text=base_text)
    try:
        rows = csv.reader(StringIO(file_bytes.decode('utf-8-sig')))
        text = '\n'.join('\t'.join(cell.strip() for cell in row) for row in rows if any(cell.strip() for cell in row))
    except (csv.Error, UnicodeDecodeError) as exc:
        raise DocumentProcessingError(400, 'CSV preprocessing failed') from exc
    return ExtractedDocument(text='\n\n'.join(part for part in [base_text, text] if part))
