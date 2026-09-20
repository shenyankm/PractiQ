"""Vision model calls and bounded figure cropping."""

import base64
import re
from io import BytesIO
from math import isfinite
from typing import Literal

from langchain_core.messages import HumanMessage
from pydantic import BaseModel, Field, StrictInt, field_validator, model_validator

from ..contracts import VisualDescription, VisualLabel

MAX_CROPS = 50
MAX_CROP_BYTES = 200 * 1024


class PageFigure(BaseModel):
    role: str | None = Field(default=None, max_length=64, description="Use answer if any part contains supplied answers, solutions, analysis or scoring rubrics; otherwise material.")
    questionIndexes: list[StrictInt] = Field(default_factory=list, max_length=1_000, description="Indexes in this response questions array; empty only for genuinely unassociated figures.")
    kind: Literal["image", "table", "chart", "diagram", "qr_code"] = Field(default="image", description="Classify visible content: table for rows/columns, chart for plotted data, diagram for schematic relationships, qr_code for QR codes, image for other pictures.")
    tableRows: list[list[str]] | None = Field(default=None, max_length=1000, description="Simple table only: first row is headers, then ALL data rows, each cell a raw string with inline $LaTeX$. Equal column counts; empty cells remain empty strings. Null for merged/multilevel tables that cannot be faithfully represented.")
    extractedText: str | None = Field(default=None, max_length=100_000, description="For tables: complete GFM Markdown table including headers and every cell; for merged/multilevel cells use faithful readable text without inventing a flattened table. For other figures: visible text or null.")
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

    @field_validator("tableRows", mode="before")
    @classmethod
    def empty_table_rows(cls, value):
        return None if value == [] else value

    @model_validator(mode="after")
    def validate_table(self):
        if self.tableRows is not None:
            rows = self.tableRows
            if self.kind != "table" or any(len(row) > 100 for row in rows):
                raise ValueError("tableRows is only for tables with at most 100 columns")
            if sum(len(cell) for row in rows for cell in row) > 90_000:
                raise ValueError("tableRows exceeds text limit")
            if rows and any(re.search(r"\b(?:answers?|solutions?|analysis|explanations?|rubrics?)\b|答案|解析|解答|评分", cell, re.IGNORECASE) for cell in rows[0]):
                self.role = "answer"
            if len(rows) < 2 or not rows[0] or any(len(row) != len(rows[0]) for row in rows) or len(self.table_markdown() or "") > 100_000:
                # Irregular or oversized GFM stays review-only; delimiters and
                # escaping count toward the public contract limit too.
                self.extractedText = (self.extractedText or "\n".join("\t".join(row) for row in rows))[:100_000]
                self.tableRows = None
        return self

    def table_markdown(self) -> str | None:
        if self.tableRows is None:
            return None
        rows = ["| " + " | ".join(cell.replace(r"\|", "|").replace("|", r"\|").replace("\n", " ") for cell in row) + " |" for row in self.tableRows]
        rows.insert(1, "| " + " | ".join("---" for _ in self.tableRows[0]) + " |")
        return "\n".join(rows)


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
