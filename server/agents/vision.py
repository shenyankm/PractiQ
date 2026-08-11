from __future__ import annotations

import base64
from io import BytesIO
from typing import Literal

from agentscope.message import Base64Source, DataBlock, Msg, TextBlock, UserMsg
from agentscope.model import DashScopeChatModel
from pydantic import BaseModel, Field

from ..ai_schemas import VisualElement

MAX_CROPS = 50
MAX_CROP_BYTES = 200 * 1024

OCR_PROMPT = (
    'You are an OCR engine for assessment documents. Transcribe all text on '
    'this page in reading order. Convert every mathematical or chemical '
    'formula to LaTeX. Convert every table to a markdown table. List every '
    'figure (illustration, chart, diagram, QR code) with a short description '
    'and its bounding box as relative coordinates [x0, y0, x1, y1] in the '
    'range 0..1.'
)
DESCRIBE_PROMPT = (
    'Describe this image from an assessment document in one or two sentences. '
    'Transcribe any text it contains.'
)


class OcrFigure(BaseModel):
    kind: Literal['image', 'table', 'chart', 'diagram', 'qr_code'] = 'image'
    label: str | None = None
    description: str
    bbox: list[float] = Field(min_length=4, max_length=4)


class PageOcrResult(BaseModel):
    text: str
    figures: list[OcrFigure] = Field(default_factory=list)


class ImageDescription(BaseModel):
    description: str
    extractedText: str | None = None


async def ocr_pages(
    vl_model: DashScopeChatModel,
    page_images: list[bytes],
) -> tuple[str, list[VisualElement], list[str]]:
    texts: list[str] = []
    visual_elements: list[VisualElement] = []
    warnings: list[str] = []
    crop_count = 0

    for page_index, image in enumerate(page_images):
        response = await vl_model.generate_structured_output(
            messages=[_image_message(OCR_PROMPT, image, 'image/png')],
            structured_model=PageOcrResult,
        )
        page = PageOcrResult.model_validate(response.content)
        if page.text.strip():
            texts.append(page.text.strip())
        for figure in page.figures:
            crop = None
            if crop_count < MAX_CROPS:
                crop = _crop_figure(image, figure.bbox)
                crop_count += 1
            elif crop_count == MAX_CROPS:
                warnings.append(
                    f'Figure crop limit of {MAX_CROPS} reached; remaining '
                    'figures include descriptions only.'
                )
                crop_count += 1
            visual_elements.append(
                VisualElement(
                    kind=figure.kind,
                    label=figure.label,
                    description=figure.description,
                    page=page_index,
                    bbox=_clamped_bbox(figure.bbox),
                    imageBase64=crop,
                )
            )
    return '\n\n'.join(texts), visual_elements, warnings


async def describe_images(
    vl_model: DashScopeChatModel,
    images: list[bytes],
) -> list[VisualElement]:
    visual_elements: list[VisualElement] = []
    for image in images:
        response = await vl_model.generate_structured_output(
            messages=[_image_message(DESCRIBE_PROMPT, image, _media_type(image))],
            structured_model=ImageDescription,
        )
        described = ImageDescription.model_validate(response.content)
        visual_elements.append(
            VisualElement(
                kind='image',
                description=described.description,
                extractedText=described.extractedText,
            )
        )
    return visual_elements


def _image_message(prompt: str, image: bytes, media_type: str) -> Msg:
    return UserMsg(
        name='user',
        content=[
            TextBlock(type='text', text=prompt),
            DataBlock(
                source=Base64Source(
                    data=base64.b64encode(image).decode(),
                    media_type=media_type,
                )
            ),
        ],
    )


def _media_type(image: bytes) -> str:
    if image.startswith(b'\x89PNG'):
        return 'image/png'
    if image.startswith(b'GIF8'):
        return 'image/gif'
    if image.startswith(b'RIFF') and image[8:12] == b'WEBP':
        return 'image/webp'
    return 'image/jpeg'


def _clamped_bbox(bbox: list[float]) -> list[float]:
    return [min(max(value, 0.0), 1.0) for value in bbox[:4]]


def _crop_figure(page_image: bytes, bbox: list[float]) -> str | None:
    from PIL import Image

    x0, y0, x1, y1 = _clamped_bbox(bbox)
    if x1 <= x0 or y1 <= y0:
        return None
    with Image.open(BytesIO(page_image)) as image:
        cropped = image.convert('RGB').crop(
            (
                int(x0 * image.width),
                int(y0 * image.height),
                int(x1 * image.width),
                int(y1 * image.height),
            )
        )
    # 逐步降尺寸直到 ≤200KB，保证响应体有界
    while True:
        buffer = BytesIO()
        cropped.save(buffer, format='JPEG', quality=80)
        if buffer.tell() <= MAX_CROP_BYTES:
            return base64.b64encode(buffer.getvalue()).decode()
        if cropped.width < 64 or cropped.height < 64:
            return None
        cropped = cropped.resize((cropped.width // 2, cropped.height // 2))
