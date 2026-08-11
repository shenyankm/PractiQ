from __future__ import annotations

from . import ExtractedDocument


def extract(base_text: str, file_bytes: bytes | None) -> ExtractedDocument:
    if not file_bytes:
        return ExtractedDocument(text=base_text)
    decoded = file_bytes.decode('utf-8', errors='ignore').lstrip('\ufeff').strip()
    return ExtractedDocument(
        text='\n\n'.join(part for part in [base_text, decoded] if part)
    )
