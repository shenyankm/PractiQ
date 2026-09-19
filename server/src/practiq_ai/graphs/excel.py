"""One durable worksheet unit: cells and visual views are interpreted together."""

import asyncio
import json
from collections.abc import Callable
from typing import Any, Self

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langgraph.runtime import Runtime
from pydantic import Field, StrictInt, model_validator

from ..contracts import (
    ArtifactReference,
    ExcelSource,
    ParsedGroup,
    ParsedQuestion,
    StrictModel,
    VisualElement,
    VisualKind,
)
from ..errors import DocumentProcessingError
from ..llm import structured_call
from .vision import _image_message


class SheetVisual(StrictModel):
    kind: VisualKind
    description: str = Field(min_length=1, max_length=20_000)
    source: ExcelSource
    questionIndexes: list[StrictInt] = Field(default_factory=list, max_length=1_000)


class SheetQuestion(ParsedQuestion):
    excelSource: ExcelSource = Field(description="Primary source of this question. Associated images belong in visuals, not additional questions.")


class SheetParseResult(StrictModel):
    questions: list[SheetQuestion] = Field(default_factory=list, max_length=1_000, description="JSON array of assessment questions only. Never include visual objects or JSON-encoded strings.")
    groups: list[ParsedGroup] = Field(default_factory=list, max_length=1_000)
    visuals: list[SheetVisual] = Field(default_factory=list, max_length=1_000, description="JSON array of visual objects, separate from questions and groups.")

    @model_validator(mode='after')
    def validate_references(self) -> Self:
        if any(index < 0 or index >= len(self.questions) for item in [*self.groups, *self.visuals] for index in item.questionIndexes):
            raise ValueError('Indexes must reference a worksheet question')
        return self


async def parse_sheet(state: Any, manifest: dict[str, Any], runtime: Runtime[None], system_prompt: str,
                      get_model: Callable, get_store: Callable) -> dict[str, Any]:
    index = state['index']
    if manifest['failureCode']:
        return {'chunkResults': [{'index': index, 'parsed': None, 'failureCode': manifest['failureCode']}], 'usage': []}
    store = await asyncio.to_thread(get_store)
    metadata = {key: manifest[key] for key in ('sheetName', 'text', 'objects', 'warnings')}
    metadata['images'] = [{key: asset[key] for key in ('objectId', 'cellRange')} for asset in manifest['assets']]
    messages: list[BaseMessage] = [SystemMessage(content=system_prompt), HumanMessage(content=json.dumps(metadata, ensure_ascii=False))]
    for asset in manifest['assets']:
        image = await store.get_verified(ArtifactReference.model_validate(asset['artifact']))
        messages.append(_image_message(f"Worksheet view: {asset['objectId']}; anchor: {asset['cellRange']}", image, 'image/png'))
    messages.append(HumanMessage(content=(
        'Return ONE root object with three sibling JSON arrays: questions, groups, visuals. '
        'Never JSON-encode an array as a string. Never insert a visual or group into the questions array. '
        'Interpret this worksheet jointly. Cells, anchored originals and rendered pages are views of the SAME source; '
        'do not duplicate questions across views. First identify distinct question STARTS in the source. '
        'Output each source occurrence exactly once. A figure and its question together are ONE question, '
        'not a text question plus an image question. Preserve repeated questions only when separate '
        'occurrences actually exist in the source. A figure label, caption, or drawing alone is NOT a question. '
        'An image contributes a separate question only if it contains identifiable question wording or '
        'an explicit question response structure. Never create a stem=null placeholder just for a figure; '
        'standalone figures belong only in visuals. Example: cell A1 asks about Diagram 1, and the anchored '
        'image shows Diagram 1 without another question: return ONE question sourced at A1, and ONE visual '
        'linked to questionIndexes=[0]. Do not add a second question for the diagram. '
        'A corrected response replaces the whole previous result; '
        'never append its questions again. Images may illustrate cell '
        'questions, contain independent questions, or be standalone visuals. Associate visuals only when both '
        'content and source evidence support it; proximity alone is insufficient. Never infer cross-sheet links. '
        'Each question carries its own excelSource for its primary source, using the supplied sheetName and '
        'cellRange and/or objectId. Copy object IDs exactly. For image questions, sourceText may transcribe '
        'the image and need not match cell text. Visuals reference a supplied image or drawing object ID, '
        'with zero-based local questionIndexes; use [] when association is unknown. Include standalone visuals. '
        'No invented page numbers or coordinates. Rendered pages supplement charts/shapes, not cached formula '
        'values; do not substitute recalculated formulas for missing cached values. Extract, never solve.'
    )))
    # Validate source identity inside structured_call so invalid references follow its
    # existing bounded correction, usage and durable-call path.
    object_ids = {asset['objectId'] for asset in manifest['assets']} | {obj['objectId'] for obj in manifest['objects']}

    class GroundedSheetResult(SheetParseResult):
        @model_validator(mode='after')
        def validate_sources(self) -> Self:
            for source in [*(question.excelSource for question in self.questions), *(visual.source for visual in self.visuals)]:
                if source.sheetName != manifest['sheetName'] or (source.objectId is not None and source.objectId not in object_ids):
                    raise ValueError('Unknown worksheet or object source')
                if source.cellRange is None and source.objectId is None:
                    raise ValueError('A cell range or object source is required')
            if any(visual.source.objectId is None for visual in self.visuals):
                raise ValueError('A visual must reference a supplied object')
            return self

    try:
        parsed, usage, failure = await structured_call(await asyncio.to_thread(get_model, 'vision'), messages, GroundedSheetResult, 'document_parse', runtime=runtime)
    except DocumentProcessingError as exc:
        if exc.code not in {'MODEL_INPUT_TOO_LARGE', 'AI_PROVIDER_ERROR', 'AI_USAGE_MISSING', 'AI_USAGE_INVALID'}:
            raise
        parsed, usage, failure = None, exc.usage, exc.code
    visuals = []
    if parsed is not None:
        references = {asset['objectId']: asset['original'] for asset in manifest['assets']}
        rendered = next((asset['original'] for asset in manifest['assets'] if asset['objectId'].startswith('render:')), None)
        for visual in parsed.visuals:
            reference = references.get(visual.source.objectId)
            # A chart/shape has no standalone image; do not mislabel an entire rendered
            # page as the object image. The page artifacts remain in the worksheet manifest.
            if reference is None and rendered is None:
                continue
            visuals.append(VisualElement(kind=visual.kind, description=visual.description,
                                         excelSource=visual.source, questionIndexes=visual.questionIndexes,
                                         imageRef=ArtifactReference.model_validate(reference) if reference else None).model_dump(mode='json'))
    return {'chunkResults': [{'index': index, 'parsed': parsed.model_dump(mode='json', include={'questions', 'groups'}, exclude={'questions': {'__all__': {'excelSource'}}}) if parsed else None,
                             'sheetResult': parsed.model_dump(mode='json') if parsed else None,
                             'visuals': visuals, 'failureCode': failure}],
            'usage': [entry.model_dump(mode='json') for entry in usage]}
