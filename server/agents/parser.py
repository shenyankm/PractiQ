# LangGraph passes partial state between nodes; Pyright cannot infer edge ordering.
# pyright: reportTypedDictNotRequiredAccess=false

import operator
from typing import Annotated, Any, TypedDict

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime
from langgraph.types import Send
from pydantic import BaseModel, Field

from ..ai_schemas import (
    DocumentParseRequest,
    DocumentParseResult,
    ParsedGroup,
    ParsedQuestion,
    VisualElement,
)
from ..chunking import merge_chunk_results, split_into_chunks
from ..extractors import DocumentProcessingError, enforce_vision_bytes, extract
from . import vision
from .model import AgentContext, graph_config, structured_attempt

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


class ParseState(TypedDict, total=False):
    request: dict[str, Any]
    text: str
    warnings: list[str]
    page_images: list[bytes]
    embedded_images: list[bytes]
    vision_results: Annotated[list[dict[str, Any]], operator.add]
    chunks: list[str]
    chunk_results: Annotated[list[dict[str, Any]], operator.add]
    result: dict[str, Any]


class ChunkState(TypedDict, total=False):
    index: int
    total: int
    chunk: str
    file_name: str | None
    source_type: str
    messages: list[BaseMessage]
    attempts: int
    parsed: ChunkParseResult | None


def _extract(state: ParseState) -> dict[str, Any]:
    request = DocumentParseRequest.model_validate(state['request'])
    document = extract(request)
    enforce_vision_bytes(
        sum(len(image) for image in document.page_images)
        + sum(len(image) for image in document.embedded_images)
    )
    return {
        'request': request.model_dump(mode='json'),
        'text': document.text,
        'warnings': list(document.warnings),
        'page_images': document.page_images,
        'embedded_images': document.embedded_images,
        'vision_results': [],
        'chunk_results': [],
    }


def _dispatch_vision(
    state: ParseState, runtime: Runtime[AgentContext]
) -> list[Send] | str:
    if runtime.context.vision_model is None:
        return 'assemble_split'
    work = [
        Send('vision', {'kind': 'page', 'index': index, 'image': image})
        for index, image in enumerate(state['page_images'])
    ]
    work.extend(
        Send('vision', {'kind': 'embedded', 'index': index, 'image': image})
        for index, image in enumerate(state['embedded_images'])
    )
    return work or 'assemble_split'


async def _vision(
    state: dict[str, Any], runtime: Runtime[AgentContext]
) -> dict[str, list[dict[str, Any]]]:
    model = runtime.context.vision_model
    assert model is not None
    if state['kind'] == 'page':
        text, visuals = await vision.ocr_page(model, state['image'], state['index'])
        value = {
            'kind': 'page',
            'index': state['index'],
            'text': text,
            'visuals': [item.model_dump(mode='json') for item in visuals],
        }
    else:
        value = {
            'kind': 'embedded',
            'index': state['index'],
            'text': '',
            'visuals': [
                (await vision.describe_image(model, state['image'])).model_dump(
                    mode='json'
                )
            ],
        }
    return {'vision_results': [value]}


def _assemble_split(state: ParseState) -> dict[str, Any]:
    request = DocumentParseRequest.model_validate(state['request'])
    results = sorted(
        state.get('vision_results', []),
        key=lambda item: (item['kind'] != 'page', item['index']),
    )
    page_text = '\n\n'.join(
        item['text'] for item in results if item['kind'] == 'page' and item['text']
    )
    text = '\n\n'.join(part for part in [state['text'], page_text] if part)
    visuals = [
        VisualElement.model_validate(visual)
        for item in results
        for visual in item['visuals']
    ]
    warnings = [*state['warnings'], *vision._limit_crops(visuals)]
    if len(text) > MAX_TOTAL_INPUT_CHARS:
        warnings.append(
            f'Document text exceeds {MAX_TOTAL_INPUT_CHARS} characters and was truncated.'
        )
        text = text[:MAX_TOTAL_INPUT_CHARS]
    if not text.strip() and not results and (state['page_images'] or state['embedded_images']):
        raise DocumentProcessingError(
            409,
            'Configure a vision model to parse image-only documents',
            'VISION_MODEL_REQUIRED',
        )
    if not text.strip():
        raise DocumentProcessingError(422, 'Document contains no extractable text')
    return {
        'text': text,
        'warnings': warnings,
        'vision_results': [
            {
                'kind': 'assembled',
                'index': 0,
                'text': '',
                'visuals': [visual.model_dump(mode='json') for visual in visuals],
            }
        ],
        'chunks': split_into_chunks(text),
        'request': request.model_dump(mode='json'),
    }


def _dispatch_chunks(state: ParseState) -> list[Send]:
    request = DocumentParseRequest.model_validate(state['request'])
    chunks = state['chunks']
    return [
        Send(
            'chunk',
            {
                'index': index,
                'total': len(chunks),
                'chunk': chunk,
                'file_name': request.fileName,
                'source_type': request.sourceType,
            },
        )
        for index, chunk in enumerate(chunks)
    ]


async def _chunk_call(
    state: ChunkState, runtime: Runtime[AgentContext]
) -> dict[str, Any]:
    messages = state.get('messages') or [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(
            content=(
                f'File: {state.get("file_name") or "unknown"}\n'
                f'Source type: {state["source_type"]}\n'
                f'Fragment {state["index"] + 1} of {state["total"]}\n\n'
                f'{state["chunk"]}'
            )
        ),
    ]
    parsed, messages = await structured_attempt(
        runtime.context.text_model, messages, ChunkParseResult, stage='parse_chunk'
    )
    return {
        'messages': messages,
        'parsed': parsed,
        'attempts': state.get('attempts', 0) + 1,
    }


def _chunk_retry(state: ChunkState) -> str:
    if state.get('parsed') is not None:
        return 'done'
    return 'failed' if state['attempts'] > CHUNK_VALIDATION_RETRIES else 'call'


def _chunk_done(state: ChunkState) -> ChunkState:
    return state


_chunk_builder = StateGraph(ChunkState, context_schema=AgentContext)
_chunk_builder.add_node('call', _chunk_call)
_chunk_builder.add_node('done', _chunk_done)
_chunk_builder.add_node('failed', _chunk_done)
_chunk_builder.add_edge(START, 'call')
_chunk_builder.add_conditional_edges('call', _chunk_retry)
_chunk_builder.add_edge('done', END)
_chunk_builder.add_edge('failed', END)
_chunk_graph = _chunk_builder.compile()


async def _chunk(
    state: ChunkState, runtime: Runtime[AgentContext], config: RunnableConfig
) -> dict[str, list[dict[str, Any]]]:
    result = await _chunk_graph.ainvoke(state, config, context=runtime.context)
    return {
        'chunk_results': [
            {
                'index': state['index'],
                'parsed': (
                    result['parsed'].model_dump(mode='json')
                    if result.get('parsed') is not None
                    else None
                ),
            }
        ]
    }


def _merge_finalize(state: ParseState) -> dict[str, dict[str, Any]]:
    ordered = sorted(state['chunk_results'], key=lambda item: item['index'])
    failures = [item for item in ordered if item['parsed'] is None]
    if len(failures) == len(ordered):
        raise DocumentProcessingError(502, 'AI agent returned invalid JSON')
    warnings = list(state['warnings'])
    warnings.extend(
        f'Fragment {item["index"] + 1} of {len(ordered)} failed validation and was skipped.'
        for item in failures
    )
    parsed = [
        ChunkParseResult.model_validate(item['parsed'])
        for item in ordered
        if item['parsed']
    ]
    questions, groups, merge_warnings = merge_chunk_results(
        [(item.questions, item.groups) for item in parsed]
    )
    warnings.extend(merge_warnings)
    if not questions:
        raise DocumentProcessingError(422, 'AI agent did not return any questions')
    if len(warnings) > 1_000:
        raise DocumentProcessingError(422, 'Document preprocessing returned too many warnings')
    assembled = next(
        item for item in state['vision_results'] if item['kind'] == 'assembled'
    )
    return {
        'result': DocumentParseResult(
            questions=questions,
            groups=groups,
            visualElements=[
                VisualElement.model_validate(item)
                for item in assembled['visuals'][:1_000]
            ],
            warnings=warnings,
            qualityScore=round(
                sum(question.confidence for question in questions) / len(questions) * 100,
                1,
            ),
        ).model_dump(mode='json')
    }


def parse_graph_input(request: DocumentParseRequest) -> ParseState:
    return {'request': request.model_dump(mode='json')}


def build_parse_graph(
    checkpointer: BaseCheckpointSaver | None = None,
) -> CompiledStateGraph[ParseState, AgentContext, ParseState, ParseState]:
    builder = StateGraph(ParseState, context_schema=AgentContext)
    builder.add_node('extract', _extract)
    builder.add_node('vision', _vision)  # pyright: ignore[reportArgumentType]
    builder.add_node('assemble_split', _assemble_split)
    builder.add_node('chunk', _chunk)  # pyright: ignore[reportArgumentType]
    builder.add_node('merge_finalize', _merge_finalize)
    builder.add_edge(START, 'extract')
    builder.add_conditional_edges(
        'extract', _dispatch_vision, ['vision', 'assemble_split']
    )
    builder.add_edge('vision', 'assemble_split')
    builder.add_conditional_edges('assemble_split', _dispatch_chunks, ['chunk'])
    builder.add_edge('chunk', 'merge_finalize')
    builder.add_edge('merge_finalize', END)
    return builder.compile(checkpointer=checkpointer, name='document_parser')


async def run_parse_graph(
    text_model: BaseChatModel,
    vl_model: BaseChatModel | None,
    request: DocumentParseRequest,
    *,
    graph: CompiledStateGraph[ParseState, AgentContext, ParseState, ParseState] | None = None,
    config: RunnableConfig | None = None,
) -> DocumentParseResult:
    try:
        output = await (graph or build_parse_graph()).ainvoke(
            parse_graph_input(request),
            graph_config(config),
            context=AgentContext(text_model, vl_model),
        )
        return DocumentParseResult.model_validate(output['result'])
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(502, 'AI agent request failed') from exc


async def parse_document(
    text_model: BaseChatModel,
    vl_model: BaseChatModel | None,
    request: DocumentParseRequest,
) -> DocumentParseResult:
    return await run_parse_graph(text_model, vl_model, request)
