"""Keep source-unit indexes stable while limiting explicitly requested work."""
from collections.abc import Mapping
from typing import Any

from .errors import DocumentProcessingError


def page_indices(state: Mapping[str, Any]) -> list[int]:
    refs = state.get('pageRefs', [])
    requested = state.get('pages')
    if requested is None or not refs:
        return list(range(len(refs)))
    parts = state.get('inputParts', [])
    sources = [parts[index].get('sourcePage', index) if index < len(parts) else index for index in range(len(refs))]
    requested = set(requested)
    if not requested <= {index + 1 for index in sources}:
        raise DocumentProcessingError(422, 'Selected pages are outside the retained source', 'SOURCE_SELECTION_INVALID')
    return [index for index, source in enumerate(sources) if source + 1 in requested]


def active_indices(state: Mapping[str, Any], stage: str) -> list[int]:
    selected = state.get('selectedUnits')
    if stage != 'vision_parse' and selected is not None:
        bounds = range(len(state.get('chunkRefs', [])))
        requested = {unit['index'] for unit in selected if unit['stage'] == stage}
        return sorted({int(index) for index in requested if index in bounds})
    available = page_indices(state) if stage == 'vision_parse' else list(range(len(state.get('chunkRefs', []))))
    if selected is None:
        return available
    requested = {unit['index'] for unit in selected if unit['stage'] == stage}
    return [index for index in available if index in requested]
