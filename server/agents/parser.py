from __future__ import annotations

from agentscope.message import SystemMsg, UserMsg
from agentscope.model import ChatModelBase
from pydantic import BaseModel, Field

from ..chunking import merge_chunk_results, split_into_chunks
from ..extractors import DocumentProcessingError, extract
from ..ai_schemas import (
    DocumentParseRequest,
    DocumentParseResult,
    ParsedGroup,
    ParsedQuestion,
    VisualElement,
)

from . import vision
from .model import structured_call

CHUNK_VALIDATION_RETRIES = 2
# ponytail: 全文级硬上限，超大文档直接截断；需要完整解析百万字级文档时再做流式分页
MAX_TOTAL_INPUT_CHARS = 2_000_000

SYSTEM_PROMPT = (
    'Parse assessment questions from the supplied document fragment. Extract '
    'every question with its options, answer, and analysis. Keep questions in '
    'the order they appear in the source and group them by section when the '
    'source has sections. Convert every mathematical or chemical formula to '
    'LaTeX in contentBlocks.latexValue. Do not invent questions that are not '
    'in the source.'
)


class ChunkParseResult(BaseModel):
    questions: list[ParsedQuestion] = Field(default_factory=list, max_length=1_000)
    groups: list[ParsedGroup] = Field(default_factory=list, max_length=1_000)


async def parse_document(
    text_model: ChatModelBase,
    vl_model: ChatModelBase | None,
    request: DocumentParseRequest,
) -> DocumentParseResult:
    document = extract(request)
    warnings = list(document.warnings)

    text = document.text
    visual_elements: list[VisualElement] = []
    if document.page_images and vl_model is not None:
        ocr_text, ocr_visuals, ocr_warnings = await vision.ocr_pages(
            vl_model, document.page_images
        )
        text = '\n\n'.join(part for part in [text, ocr_text] if part)
        visual_elements.extend(ocr_visuals)
        warnings.extend(ocr_warnings)
    if document.embedded_images and vl_model is not None:
        visual_elements.extend(
            await vision.describe_images(vl_model, document.embedded_images)
        )

    if len(text) > MAX_TOTAL_INPUT_CHARS:
        warnings.append(
            f'Document text exceeds {MAX_TOTAL_INPUT_CHARS} characters and was truncated.'
        )
        text = text[:MAX_TOTAL_INPUT_CHARS]
    if not text.strip() and vl_model is None and (document.page_images or document.embedded_images):
        raise DocumentProcessingError(
            409, 'Configure a vision model to parse image-only documents', 'VISION_MODEL_REQUIRED'
        )
    if not text.strip():
        raise DocumentProcessingError(422, 'Document contains no extractable text')

    chunks = split_into_chunks(text)
    chunk_results: list[tuple[list[ParsedQuestion], list[ParsedGroup]]] = []
    failed_chunks = 0
    for chunk_index, chunk in enumerate(chunks):
        parsed = await structured_call(
            text_model,
            [
                SystemMsg(name='system', content=SYSTEM_PROMPT),
                UserMsg(
                    name='user',
                    content=(
                        f'File: {request.fileName or "unknown"}\n'
                        f'Source type: {request.sourceType}\n'
                        f'Fragment {chunk_index + 1} of {len(chunks)}\n\n{chunk}'
                    ),
                ),
            ],
            ChunkParseResult,
            CHUNK_VALIDATION_RETRIES,
        )
        if parsed is None:
            failed_chunks += 1
            warnings.append(
                f'Fragment {chunk_index + 1} of {len(chunks)} failed validation '
                'and was skipped.'
            )
        else:
            chunk_results.append((parsed.questions, parsed.groups))

    if failed_chunks == len(chunks):
        raise DocumentProcessingError(502, 'AI agent returned invalid JSON')

    questions, groups, merge_warnings = merge_chunk_results(chunk_results)
    warnings.extend(merge_warnings)
    if not questions:
        raise DocumentProcessingError(422, 'AI agent did not return any questions')

    quality_score = round(
        sum(question.confidence for question in questions) / len(questions) * 100, 1
    )
    return _with_warnings(
        DocumentParseResult(
            questions=questions,
            groups=groups,
            visualElements=visual_elements[:1_000],
            warnings=[],
            qualityScore=quality_score,
        ),
        warnings,
    )


def _with_warnings(
    result: DocumentParseResult, warnings: list[str]
) -> DocumentParseResult:
    if len(warnings) > 1_000:
        raise DocumentProcessingError(422, 'Document preprocessing returned too many warnings')
    return result.model_copy(update={'warnings': warnings})
