"""Vision model calls and bounded figure cropping."""

import base64
from io import BytesIO
from math import isfinite
from typing import Literal

from langchain_core.messages import HumanMessage
from pydantic import BaseModel, Field, field_validator

from ..contracts import VisualDescription, VisualLabel

MAX_CROPS = 50
MAX_CROP_BYTES = 200 * 1024


class PageFigure(BaseModel):
    kind: Literal["image", "table", "chart", "diagram", "qr_code"] = Field(default="image", description="Classify visible content: table for rows/columns, chart for plotted data, diagram for schematic relationships, qr_code for QR codes, image for other pictures.")
    label: VisualLabel | None = None
    description: VisualDescription
    bbox: list[float] = Field(min_length=4, max_length=4, description="[x0, y0, x1, y1] relative to the full page, normalized to [0, 1], from top-left to bottom-right with positive area.")

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, bbox: list[float]) -> list[float]:
        x0, y0, x1, y1 = bbox
        if not all(isfinite(value) and 0 <= value <= 1 for value in bbox):
            raise ValueError("bbox values must be finite and normalized")
        if x1 <= x0 or y1 <= y0:
            raise ValueError("bbox must have positive area")
        return bbox


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
