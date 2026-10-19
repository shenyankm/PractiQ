"""Lossless, deterministic splitting before any paid document submission."""

from io import BytesIO

from PIL import Image

from .errors import DocumentProcessingError


def split_text(payload: bytes, limit: int, max_parts: int) -> list[bytes]:
    payload.decode("utf-8-sig")
    parts = []
    start = 0
    while start < len(payload):
        end = min(start + limit, len(payload))
        if end < len(payload):
            while payload[end] & 0xC0 == 0x80:
                end -= 1
            newline = payload.rfind(b"\n", start, end)
            if newline >= start:
                end = newline + 1
        if end <= start:
            raise DocumentProcessingError(413, "A UTF-8 character exceeds the input limit", "TENCENT_SOURCE_TOO_LARGE")
        parts.append(payload[start:end])
        if len(parts) > max_parts:
            raise DocumentProcessingError(413, "Document exceeds the split-part limit", "TENCENT_SOURCE_TOO_LARGE")
        start = end
    return parts


def split_image(payload: bytes, limit: int, max_parts: int) -> list[tuple[bytes, str, tuple[int, int, int, int]]]:
    """Tile without downsampling; bounds refer to the retained original page."""
    parts = []
    with Image.open(BytesIO(payload)) as image:
        pending = [(0, 0, image.width, image.height)]
        while pending:
            bounds = pending.pop()
            with image.crop(bounds) as tile:
                buffer = BytesIO()
                tile.save(buffer, format="PNG")
                data = buffer.getvalue()
            if len(data) <= limit:
                parts.append((data, "image/png", bounds))
            else:
                left, top, right, bottom = bounds
                if bottom - top >= right - left and bottom - top > 1:
                    middle = (top + bottom) // 2
                    children = [(left, top, right, middle), (left, middle, right, bottom)]
                elif right - left > 1:
                    middle = (left + right) // 2
                    children = [(left, top, middle, bottom), (middle, top, right, bottom)]
                else:
                    raise DocumentProcessingError(413, "An image pixel exceeds the input limit", "TENCENT_SOURCE_TOO_LARGE")
                pending.extend(reversed(children))
            if len(parts) + len(pending) > max_parts:
                raise DocumentProcessingError(413, "Document exceeds the split-part limit", "TENCENT_SOURCE_TOO_LARGE")
    return parts
