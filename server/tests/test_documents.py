from io import BytesIO

import pytest

from practiq_ai import extractors
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import extract
from tests.support import make_blank_pdf


def test_extract_csv_text_and_image() -> None:
    from PIL import Image

    csv_document = extract("csv", b'question,answer\n"2 + 2",4')
    markdown = "  # Quiz\n\n    indented code\n"
    text_document = extract("text", markdown.encode())
    image_buffer = BytesIO()
    Image.new("RGB", (1, 1)).save(image_buffer, format="PNG")
    image_document = extract("image", image_buffer.getvalue())

    assert csv_document.text == "question\tanswer\n2 + 2\t4"
    assert text_document.text == markdown
    assert image_document.page_images == [image_buffer.getvalue()]


def test_extract_enforces_source_size(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_SOURCE_MAX_BYTES", "4")

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("pdf", b"12345")

    assert exc_info.value.status_code == 413


def test_extract_pdf_renders_every_page() -> None:
    document = extract("pdf", make_blank_pdf(pages=2))
    assert document.text == ""
    assert len(document.page_images) == 2
    assert all(image.startswith(b"\x89PNG") for image in document.page_images)
    assert document.warnings == []


def test_extract_pdf_enforces_page_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_MAX_DOCUMENT_PAGES", "1")

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("pdf", make_blank_pdf(pages=2))

    assert exc_info.value.status_code == 413


def test_extract_pdf_enforces_rendered_image_byte_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_MAX_VISION_BYTES", "1")

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("pdf", make_blank_pdf(pages=1))

    assert exc_info.value.status_code == 413
    assert exc_info.value.detail == extractors.VISION_BYTES_LIMIT_DETAIL


def test_extract_pdf_rejects_oversized_page_before_render(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_MAX_VISION_PAGE_PIXELS", "100")

    with pytest.raises(DocumentProcessingError) as exc_info:
        extract("pdf", make_blank_pdf(pages=1))

    assert exc_info.value.status_code == 413


@pytest.mark.parametrize(
    ("source_type", "payload"),
    (
        ("text", b"\xff"),
        ("csv", b"\xff"),
        ("image", b"not an image"),
        ("pdf", b"not a pdf"),
    ),
)
def test_extract_rejects_invalid_source_payloads(
    source_type: str, payload: bytes
) -> None:
    with pytest.raises(DocumentProcessingError) as exc_info:
        extract(source_type, payload)  # type: ignore[arg-type]
    assert exc_info.value.status_code == 400

@pytest.mark.parametrize('format', ['WEBP', 'GIF'])
def test_image_rejects_removed_formats_even_with_a_disguised_extension(format):
    from PIL import Image

    payload = BytesIO()
    Image.new('RGB', (2, 2), 'red').save(payload, format=format)
    with pytest.raises(DocumentProcessingError) as error:
        extract('image', payload.getvalue())
    assert error.value.code == 'IMAGE_FORMAT_UNSUPPORTED'


def test_jpeg_source_is_still_supported():
    from PIL import Image

    payload = BytesIO()
    Image.new('RGB', (2, 2), 'red').save(payload, format='JPEG')
    assert extract('image', payload.getvalue()).page_images == [payload.getvalue()]
