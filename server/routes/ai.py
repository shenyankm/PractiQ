"""AI routes: in-process agentscope calls behind user session + Plus entitlement.

Mirrors the AI half of imports_ai_handlers.go (aiclient HTTP hop removed).
"""

from __future__ import annotations

import json
import os

from fastapi import APIRouter, Request
from pydantic import ValidationError as PydanticValidationError

from .. import agents, envelope
from ..ai_schemas import (
    AnswerGenerationRequest,
    DocumentParseRequest,
    LearningReportRequest,
)
from ..extractors import DocumentProcessingError
from ..services import questions as questions_svc
from ..services import users as users_svc
from . import deps

router = APIRouter()

MAX_AI_JSON_BODY_BYTES = 25 * 1024 * 1024 * 4 // 3 + 1024 * 1024


def _ai_apply_min_confidence() -> float:
    raw = os.environ.get('AI_APPLY_MIN_CONFIDENCE', '').strip()
    try:
        threshold = float(raw)
    except ValueError:
        return 0.7
    return threshold if threshold > 0 else 0.7


def _pydantic_details(exc: PydanticValidationError) -> list[dict]:
    return [
        {'field': '.'.join(str(part) for part in error['loc']), 'message': error['msg']}
        for error in exc.errors()
    ]


async def _require_plus(request: Request, user, feature: str) -> None:
    async with deps.pool(request).connection() as conn:
        await users_svc.require_plus_entitlement(conn, user, feature)


async def _decode_ai_json(request: Request) -> dict:
    body = await request.body()
    if len(body) > MAX_AI_JSON_BODY_BYTES:
        raise envelope.request_too_large()
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise envelope.invalid_json() from exc
    if not isinstance(payload, dict):
        raise envelope.invalid_json()
    return payload


@router.post('/api/v1/ai/parse-document')
async def parse_document(request: Request):
    user = await deps.current_user(request)
    await _require_plus(request, user, 'AI document parsing')
    body = await _decode_ai_json(request)
    try:
        payload = DocumentParseRequest.model_validate(body)
    except PydanticValidationError as exc:
        raise envelope.new_error(422, 'VALIDATION_ERROR', 'Invalid request', _pydantic_details(exc)) from exc
    if not payload.text and not payload.fileBase64:
        raise envelope.validation_error(
            [envelope.ValidationDetail('text', 'text or fileBase64 is required')]
        )
    try:
        result = await agents.parse_document(payload)
    except DocumentProcessingError as exc:
        raise envelope.new_error(exc.status_code, 'DOCUMENT_PROCESSING_FAILED', exc.detail) from exc
    return envelope.ok(request, result.model_dump())


@router.post('/api/v1/ai/generate-answer')
async def generate_answer(request: Request):
    user = await deps.current_user(request)
    await _require_plus(request, user, 'AI answer generation')
    body = await _decode_ai_json(request)
    details: list[envelope.ValidationDetail] = []
    if not isinstance(body.get('stem'), str) or not body['stem'].strip():
        details.append(envelope.ValidationDetail('stem', 'is required'))
    if body.get('answerMode') not in ('choice', 'true_false', 'fill_blank', 'short_answer'):
        details.append(
            envelope.ValidationDetail('answerMode', 'must be one of choice, true_false, fill_blank, short_answer')
        )
    question_id = body.get('questionId')
    if question_id is not None and (not isinstance(question_id, int) or question_id <= 0):
        details.append(envelope.ValidationDetail('questionId', 'must be a positive integer'))
    if details:
        raise envelope.validation_error(details)
    try:
        payload = AnswerGenerationRequest.model_validate(body)
    except PydanticValidationError as exc:
        raise envelope.new_error(422, 'VALIDATION_ERROR', 'Invalid request', _pydantic_details(exc)) from exc
    try:
        result = await agents.generate_answer(payload.model_dump(exclude_none=True))
    except DocumentProcessingError as exc:
        raise envelope.new_error(exc.status_code, 'DOCUMENT_PROCESSING_FAILED', exc.detail) from exc
    return envelope.ok(request, result.model_dump())


@router.post('/api/v1/ai/learning-report')
async def learning_report(request: Request):
    user = await deps.current_user(request)
    await _require_plus(request, user, 'AI learning reports')
    body = await _decode_ai_json(request)
    details: list[envelope.ValidationDetail] = []
    scope = body.get('scope') or 'individual'
    if scope not in ('individual', 'class', 'bank'):
        details.append(envelope.ValidationDetail('scope', 'must be one of individual, class, bank'))
    for key, field in (('userId', 'userId'), ('bankId', 'bankId'), ('practiceSessionId', 'practiceSessionId')):
        value = body.get(key)
        if value is not None and (not isinstance(value, int) or value <= 0):
            details.append(envelope.ValidationDetail(field, 'must be a positive integer'))
    stats = body.get('stats')
    if stats is not None:
        try:
            encoded = json.dumps(stats)
        except (TypeError, ValueError):
            encoded = None
        if encoded is None or len(encoded) > 100_000:
            details.append(
                envelope.ValidationDetail('stats', 'must be a JSON object of at most 100,000 bytes')
            )
    if details:
        raise envelope.validation_error(details)
    try:
        payload = LearningReportRequest.model_validate(body)
    except PydanticValidationError as exc:
        raise envelope.new_error(422, 'VALIDATION_ERROR', 'Invalid request', _pydantic_details(exc)) from exc
    if payload.userId is not None and payload.userId != user.id and user.role != 'admin':
        raise envelope.new_error(
            403, 'FORBIDDEN', 'Administrator privileges required to generate reports for other users'
        )
    try:
        result = await agents.learning_report(payload.model_dump(exclude_none=True))
    except DocumentProcessingError as exc:
        raise envelope.new_error(exc.status_code, 'DOCUMENT_PROCESSING_FAILED', exc.detail) from exc
    return envelope.ok(request, result.model_dump())


@router.post('/api/v1/questions/{question_id}/generate-answer')
async def question_generate_answer(request: Request, question_id: str):
    user = await deps.current_user(request)
    await _require_plus(request, user, 'AI answer generation')
    parsed_question_id = deps.parse_path_id(question_id, 'questionId')
    body = await deps.decode_json_body(request, {'apply'})
    pool = deps.pool(request)
    detail = await questions_svc.get_question_for_editor(pool, user, parsed_question_id)
    payload = AnswerGenerationRequest(
        questionId=parsed_question_id,
        stem=detail['stem'],
        answerMode=detail['answer_mode'],
        analysis=detail.get('analysis') or None,
        options=[
            {'label': option['option_label'], 'content': option['content']}
            for option in detail['options']
        ],
    )
    try:
        result = await agents.generate_answer(payload.model_dump(exclude_none=True))
    except DocumentProcessingError as exc:
        raise envelope.new_error(exc.status_code, 'DOCUMENT_PROCESSING_FAILED', exc.detail) from exc
    apply = body.get('apply') if isinstance(body.get('apply'), bool) else True
    if apply:
        if result.confidence < _ai_apply_min_confidence():
            raise envelope.new_error(
                409, 'INVALID_STATE', 'AI generated answer confidence is too low to apply automatically'
            )
        if not result.answerPayload:
            raise envelope.new_error(
                409, 'INVALID_STATE', 'AI generated answer is incomplete and cannot be applied'
            )
        await questions_svc.upsert_answer_key(
            pool, user, parsed_question_id,
            detail['answer_mode'],
            result.answerPayload,
            {
                'canonicalAnswer': result.canonicalAnswer,
                'explanation': result.explanation,
                'steps': result.steps,
                'confidence': result.confidence,
                'educationalValue': result.educationalValue,
            },
            {'maxScore': 1, 'generatedBy': 'ai'},
        )
    return envelope.ok(request, result.model_dump())
