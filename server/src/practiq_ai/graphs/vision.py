"""Vision model calls and bounded figure cropping."""

import base64
from io import BytesIO
from math import isfinite
from typing import Any, Literal

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import HumanMessage
from langgraph.runtime import Runtime
from pydantic import BaseModel, Field, field_validator

from ..contracts import ModelCallUsage, VisualElement
from ..llm import structured_call

MAX_CROPS = 50
MAX_CROP_BYTES = 200 * 1024

OCR_PROMPT = (
    "You are an OCR engine for assessment documents. Transcribe all text on "
    "this page in reading order. Convert every mathematical or chemical "
    "formula to LaTeX. Convert every table to a markdown table. List every "
    "figure with a short description and relative bounding box [x0,y0,x1,y1]."
)
DESCRIBE_PROMPT = (
    "Describe this image from an assessment document in one or two sentences. "
    "Transcribe any text it contains."
)


class OcrFigure(BaseModel):
    kind: Literal["image", "table", "chart", "diagram", "qr_code"] = "image"
    label: str | None = None
    description: str = Field(min_length=1, max_length=20_000)
    bbox: list[float] = Field(min_length=4, max_length=4)

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, bbox: list[float]) -> list[float]:
        x0, y0, x1, y1 = bbox
        if not all(isfinite(value) and 0 <= value <= 1 for value in bbox):
            raise ValueError("bbox values must be finite and normalized")
        if x1 <= x0 or y1 <= y0:
            raise ValueError("bbox must have positive area")
        return bbox


class PageOcrResult(BaseModel):
    text: str = Field(max_length=120_000)
    figures: list[OcrFigure] = Field(default_factory=list)


class ImageDescription(BaseModel):
    description: str = Field(min_length=1, max_length=20_000)
    extractedText: str | None = Field(default=None, max_length=100_000)


async def ocr_page(
    model: BaseChatModel,
    image: bytes,
    page_index: int,
    runtime: Runtime[Any] | None = None,
) -> tuple[str, list[VisualElement], list[ModelCallUsage], str | None]:
    parsed, usage, failure = await structured_call(
        model,
        [_image_message(OCR_PROMPT, image, "image/png")],
        PageOcrResult,
        "vision_ocr",
        runtime=runtime,
    )
    if parsed is None:
        return "", [], usage, failure
    return (
        parsed.text.strip(),
        [
            VisualElement(
                kind=figure.kind,
                label=figure.label,
                description=figure.description,
                page=page_index,
                bbox=figure.bbox,
            )
            for figure in parsed.figures
        ],
        usage,
        None,
    )


async def describe_image(
    model: BaseChatModel,
    image: bytes,
    runtime: Runtime[Any] | None = None,
) -> tuple[VisualElement | None, list[ModelCallUsage], str | None]:
    parsed, usage, failure = await structured_call(
        model,
        [_image_message(DESCRIBE_PROMPT, image, _media_type(image))],
        ImageDescription,
        "vision_describe",
        runtime=runtime,
    )
    if parsed is None:
        return None, usage, failure
    return VisualElement(
        kind="image",
        description=parsed.description,
        extractedText=parsed.extractedText,
    ), usage, None


def _image_message(prompt: str, image: bytes, media_type: str) -> HumanMessage:
    return HumanMessage(
        content=[
            {"type": "text", "text": prompt},
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{media_type};base64,{base64.b64encode(image).decode()}"
                },
            },
        ]
    )


def _media_type(image: bytes) -> str:
    if image.startswith(b"\x89PNG"):
        return "image/png"
    if image.startswith(b"GIF8"):
        return "image/gif"
    if image.startswith(b"RIFF") and image[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def crop_figure(page_image: bytes, bbox: list[float]) -> bytes | None:
    from PIL import Image

    x0, y0, x1, y1 = bbox
    with Image.open(BytesIO(page_image)) as image:
        try:
            box = (
                int(x0 * image.width),
                int(y0 * image.height),
                int(x1 * image.width),
                int(y1 * image.height),
            )
        except (OverflowError, ValueError):
            return None
        cropped = image.convert("RGB").crop(box)
    while True:
        buffer = BytesIO()
        cropped.save(buffer, format="JPEG", quality=80)
        if buffer.tell() <= MAX_CROP_BYTES:
            return buffer.getvalue()
        if cropped.width < 64 or cropped.height < 64:
            return None
        cropped = cropped.resize((cropped.width // 2, cropped.height // 2))
