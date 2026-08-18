import base64
from io import BytesIO
from typing import Literal

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import HumanMessage
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


async def ocr_page(
    vl_model: BaseChatModel, image: bytes, page_index: int
) -> tuple[str, list[VisualElement]]:
    page = await vl_model.with_structured_output(
        PageOcrResult, method='function_calling'
    ).ainvoke([_image_message(OCR_PROMPT, image, 'image/png')])
    return page.text.strip(), [
        VisualElement(
            kind=figure.kind,
            label=figure.label,
            description=figure.description,
            page=page_index,
            bbox=_clamped_bbox(figure.bbox),
            imageBase64=_crop_figure(image, figure.bbox),
        )
        for figure in page.figures
    ]


async def describe_image(vl_model: BaseChatModel, image: bytes) -> VisualElement:
    described = await vl_model.with_structured_output(
        ImageDescription, method='function_calling'
    ).ainvoke([_image_message(DESCRIBE_PROMPT, image, _media_type(image))])
    return VisualElement(
        kind='image',
        description=described.description,
        extractedText=described.extractedText,
    )


async def ocr_pages(
    vl_model: BaseChatModel,
    page_images: list[bytes],
) -> tuple[str, list[VisualElement], list[str]]:
    results = [
        await ocr_page(vl_model, image, index)
        for index, image in enumerate(page_images)
    ]
    texts = [text for text, _ in results if text]
    visuals = [item for _, items in results for item in items]
    warnings = _limit_crops(visuals)
    return '\n\n'.join(texts), visuals, warnings


async def describe_images(
    vl_model: BaseChatModel,
    images: list[bytes],
) -> list[VisualElement]:
    return [await describe_image(vl_model, image) for image in images]


def _limit_crops(visuals: list[VisualElement]) -> list[str]:
    figures = 0
    limited = False
    for index, item in enumerate(visuals):
        if item.bbox is None:
            continue
        figures += 1
        if figures > MAX_CROPS:
            visuals[index] = item.model_copy(update={'imageBase64': None})
            limited = True
    return (
        [
            f'Figure crop limit of {MAX_CROPS} reached; remaining figures '
            'include descriptions only.'
        ]
        if limited
        else []
    )


def _image_message(prompt: str, image: bytes, media_type: str) -> HumanMessage:
    return HumanMessage(
        content=[
            {'type': 'text', 'text': prompt},
            {
                'type': 'image_url',
                'image_url': {
                    'url': f'data:{media_type};base64,{base64.b64encode(image).decode()}'
                },
            },
        ]
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
    while True:
        buffer = BytesIO()
        cropped.save(buffer, format='JPEG', quality=80)
        if buffer.tell() <= MAX_CROP_BYTES:
            return base64.b64encode(buffer.getvalue()).decode()
        if cropped.width < 64 or cropped.height < 64:
            return None
        cropped = cropped.resize((cropped.width // 2, cropped.height // 2))
