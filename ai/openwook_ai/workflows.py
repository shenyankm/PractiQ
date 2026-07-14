from __future__ import annotations

import json
import os
from typing import Any, Literal, NotRequired, TypedDict, cast

import httpx
from langgraph.graph import END, START, StateGraph

from .documents import (
    DocumentProcessingError,
    normalize_document,
    preprocess_upload,
    read_limited_response,
)
from .fallbacks import fallback_generate_answer, fallback_learning_report, fallback_parse_document
from .persistence import persist_document_parse
from .schemas import (
    AnswerGenerationResult,
    DocumentParseRequest,
    DocumentParseResult,
    DocumentSourceType,
    FileUploadWorkflowRequest,
    LearningReportResult,
)


Operation = Literal['parse_upload', 'parse_document', 'generate_answer', 'learning_report']
Result = DocumentParseResult | AnswerGenerationResult | LearningReportResult
Payload = DocumentParseRequest | FileUploadWorkflowRequest | dict[str, Any]
MAX_AGENT_INPUT_CHARS = 120_000


class WorkflowState(TypedDict):
    operation: Operation
    payload: Payload
    normalized_request: NotRequired[DocumentParseRequest]
    preprocessing_metadata: NotRequired[dict[str, object]]
    preprocessing_warnings: NotRequired[list[str]]
    result: NotRequired[Result]


def _normalize_document(state: WorkflowState) -> dict[str, object]:
    request = cast(DocumentParseRequest, state['payload'])
    document = normalize_document(request)
    return {
        'normalized_request': request.model_copy(
            update={'text': document.text, 'fileBase64': None}
        ),
        'preprocessing_metadata': document.metadata,
        'preprocessing_warnings': document.warnings,
    }


def _preprocess_upload(state: WorkflowState) -> dict[str, object]:
    request = cast(FileUploadWorkflowRequest, state['payload'])
    document = preprocess_upload(request)
    source_type: DocumentSourceType = (
        'docx' if request.sourceType == 'docx' else 'txt' if request.sourceType == 'txt' else 'text'
    )
    return {
        'normalized_request': DocumentParseRequest(
            importJobId=request.importJobId,
            bankId=request.bankId,
            sourceType=source_type,
            fileName=request.fileName,
            text=document.text,
            mimeType=request.mimeType,
        ),
        'preprocessing_metadata': document.metadata,
        'preprocessing_warnings': document.warnings,
    }


def _parse_document(state: WorkflowState) -> dict[str, Result]:
    request = state.get('normalized_request')
    if request is None:
        raise RuntimeError('document preprocessing did not produce a request')
    result = parse_document_with_agent(request)
    warnings = [*state.get('preprocessing_warnings', []), *result.warnings]
    if len(warnings) > 1_000:
        raise DocumentProcessingError(422, 'Document preprocessing returned too many warnings')
    return {
        'result': DocumentParseResult.model_validate(
            {**result.model_dump(), 'warnings': warnings}
        )
    }


def _persist_document(state: WorkflowState) -> dict[str, Result]:
    result = cast(DocumentParseResult | None, state.get('result'))
    if result is None:
        raise RuntimeError('document parsing did not produce a result')
    request = cast(DocumentParseRequest | FileUploadWorkflowRequest, state['payload'])
    persist_document_parse(request, result, state.get('preprocessing_metadata'))
    return {}


def _generate_answer(state: WorkflowState) -> dict[str, Result]:
    return {'result': fallback_generate_answer(cast(dict[str, Any], state['payload']))}


def _learning_report(state: WorkflowState) -> dict[str, Result]:
    return {'result': fallback_learning_report(cast(dict[str, Any], state['payload']))}


def _start_node(state: WorkflowState) -> str:
    if state['operation'] == 'parse_upload':
        return 'preprocess_upload'
    if state['operation'] == 'parse_document':
        return 'normalize_document'
    return state['operation']


def parse_document_with_agent(request: DocumentParseRequest) -> DocumentParseResult:
    original_text = request.text or ''
    if len(original_text) > MAX_AGENT_INPUT_CHARS:
        raise DocumentProcessingError(413, 'Normalized document is too large for the AI agent')

    base_url = os.getenv('OPENAI_BASE_URL', '').strip().rstrip('/')
    model = os.getenv('OPENAI_MODEL', '').strip()
    if not base_url or not model:
        return fallback_parse_document(request)

    source = request.text or ''
    schema = json.dumps(DocumentParseResult.model_json_schema(), ensure_ascii=False)
    payload = {
        'model': model,
        'temperature': 0,
        'max_tokens': _positive_int_env('AI_AGENT_MAX_TOKENS', 16_384),
        'response_format': {'type': 'json_object'},
        'messages': [
            {
                'role': 'system',
                'content': (
                    'Parse assessment questions from the supplied document. Return only one JSON '
                    f'object matching this schema: {schema}. Return at least one question.'
                ),
            },
            {
                'role': 'user',
                'content': (
                    f'File: {request.fileName or "unknown"}\n'
                    f'Source type: {request.sourceType}\n\n{source}'
                ),
            },
        ],
    }
    api_key = os.getenv('OPENAI_API_KEY', '').strip()
    headers = {'Authorization': f'Bearer {api_key}'} if api_key else {}
    timeout_seconds = _positive_float_env('AI_AGENT_TIMEOUT_SECONDS', 180)
    try:
        with httpx.Client(
            timeout=httpx.Timeout(connect=10, read=timeout_seconds, write=60, pool=10)
        ) as client:
            with client.stream(
                'POST',
                f'{base_url}/chat/completions',
                headers=headers,
                json=payload,
            ) as response:
                if response.status_code != 200:
                    raise DocumentProcessingError(502, 'AI agent request failed')
                response_body = read_limited_response(
                    response,
                    _positive_int_env('AI_AGENT_MAX_RESPONSE_BYTES', 5 * 1024 * 1024),
                    'AI agent response is too large',
                )
    except httpx.HTTPError as exc:
        raise DocumentProcessingError(502, 'AI agent request failed') from exc

    try:
        content = json.loads(response_body)['choices'][0]['message']['content']
        result = DocumentParseResult.model_validate_json(content)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise DocumentProcessingError(502, 'AI agent returned invalid JSON') from exc
    if not result.questions:
        raise DocumentProcessingError(422, 'AI agent did not return any questions')

    return result


def _positive_float_env(name: str, default: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _positive_int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


builder = StateGraph(WorkflowState)
builder.add_node('normalize_document', _normalize_document)
builder.add_node('preprocess_upload', _preprocess_upload)
builder.add_node('parse_document', _parse_document)
builder.add_node('persist_document', _persist_document)
builder.add_node('generate_answer', _generate_answer)
builder.add_node('learning_report', _learning_report)
builder.add_conditional_edges(START, _start_node)
builder.add_edge('normalize_document', 'parse_document')
builder.add_edge('preprocess_upload', 'parse_document')
builder.add_edge('parse_document', 'persist_document')
builder.add_edge('persist_document', END)
builder.add_edge('generate_answer', END)
builder.add_edge('learning_report', END)
ai_graph = builder.compile()


def invoke_workflow(operation: Operation, payload: Payload) -> Result:
    return ai_graph.invoke({'operation': operation, 'payload': payload})['result']
