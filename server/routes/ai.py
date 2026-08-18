"""In-process AI routes behind user sessions and PRO entitlement."""

import json
import os

from fastapi import APIRouter, Request

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

class ApplyGeneratedAnswerBody(deps.RequestBody):
    apply: bool = True


def _ai_apply_min_confidence() -> float:
    raw = os.environ.get('AI_APPLY_MIN_CONFIDENCE', '').strip()
    try:
        threshold = float(raw)
    except ValueError:
        return 0.7
    return threshold if threshold > 0 else 0.7


async def _models(request: Request, user, feature: str):
    llm_config = await users_svc.require_llm_config(
        deps.pool(request),
        user,
        request.app.state.config.llm_key_encryption_secret,
        feature,
    )
    return agents.build_models(llm_config)


@router.post('/api/v1/ai/parse-document')
async def parse_document(request: Request, payload: DocumentParseRequest):
    user = await deps.current_user(request)
    text_model, vision_model = await _models(
        request, user, 'AI document parsing'
    )
    if not payload.text and not payload.fileBase64:
        raise envelope.validation_error(
            [envelope.ValidationDetail('text', 'text or fileBase64 is required')]
        )
    try:
        result = await agents.parse_document(text_model, vision_model, payload)
    except DocumentProcessingError as exc:
        raise envelope.new_error(exc.status_code, exc.code, exc.detail) from exc
    return envelope.ok(request, result.model_dump())


@router.post('/api/v1/ai/generate-answer')
async def generate_answer(request: Request, payload: AnswerGenerationRequest):
    user = await deps.current_user(request)
    text_model, _ = await _models(request, user, 'AI answer generation')
    try:
        result = await agents.generate_answer(
            text_model, payload.model_dump(exclude_none=True)
        )
    except DocumentProcessingError as exc:
        raise envelope.new_error(exc.status_code, exc.code, exc.detail) from exc
    return envelope.ok(request, result.model_dump())


@router.post('/api/v1/ai/learning-report')
async def learning_report(request: Request, payload: LearningReportRequest):
    user = await deps.current_user(request)
    text_model, _ = await _models(request, user, 'AI learning reports')
    if payload.stats is not None and len(json.dumps(payload.stats)) > 100_000:
        raise envelope.validation_error(
            [
                envelope.ValidationDetail(
                    'stats', 'must be a JSON object of at most 100,000 bytes'
                )
            ]
        )
    if payload.userId is not None and payload.userId != user.id and user.role != 'admin':
        raise envelope.new_error(
            403,
            'FORBIDDEN',
            'Administrator privileges required to generate reports for other users',
        )
    try:
        result = await agents.learning_report(
            text_model, payload.model_dump(exclude_none=True)
        )
    except DocumentProcessingError as exc:
        raise envelope.new_error(exc.status_code, exc.code, exc.detail) from exc
    return envelope.ok(request, result.model_dump())


@router.post(
    '/api/v1/questions/{question_id}/generate-answer',
)
async def question_generate_answer(
    request: Request,
    question_id: deps.PositiveId,
    body: ApplyGeneratedAnswerBody,
):
    user = await deps.current_user(request)
    text_model, _ = await _models(request, user, 'AI answer generation')
    pool = deps.pool(request)
    detail = await questions_svc.get_question_for_editor(pool, user, question_id)
    payload = AnswerGenerationRequest(
        questionId=question_id,
        stem=detail['stem'],
        answerMode=detail['answer_mode'],
        analysis=detail.get('analysis') or None,
        options=[
            {'label': option['option_label'], 'content': option['content']}
            for option in detail['options']
        ],
    )
    try:
        result = await agents.generate_answer(
            text_model, payload.model_dump(exclude_none=True)
        )
    except DocumentProcessingError as exc:
        raise envelope.new_error(exc.status_code, exc.code, exc.detail) from exc
    if body.apply:
        if result.confidence < _ai_apply_min_confidence():
            raise envelope.new_error(
                409,
                'INVALID_STATE',
                'AI generated answer confidence is too low to apply automatically',
            )
        if not result.answerPayload:
            raise envelope.new_error(
                409,
                'INVALID_STATE',
                'AI generated answer is incomplete and cannot be applied',
            )
        await questions_svc.upsert_answer_key(
            pool,
            user,
            question_id,
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
