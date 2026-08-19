"""Private AI HTTP operations; product authorization is owned by Java."""

import json
import secrets

from fastapi import APIRouter, Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .. import envelope
from ..ai_schemas import AnswerGenerationRequest, DocumentParseRequest, LearningReportRequest
from ..extractors import DocumentProcessingError
from ..services.ai import AIService

_bearer = HTTPBearer(auto_error=False)


def _authorize(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    if credentials is None or not secrets.compare_digest(
        credentials.credentials, request.app.state.config.service_token
    ):
        raise envelope.new_error(401, 'UNAUTHENTICATED', 'Invalid AI service token')


router = APIRouter(prefix='/api/v1/ai', dependencies=[Depends(_authorize)])


def _service(request: Request) -> AIService:
    return request.app.state.ai_service


@router.post('/parse-document')
async def parse_document(
    request: Request, payload: DocumentParseRequest, service: AIService = Depends(_service),
):
    try:
        result = await service.parse_document(payload)
    except DocumentProcessingError as exc:
        raise envelope.new_error(exc.status_code, exc.code, exc.detail) from exc
    return envelope.ok(request, result.model_dump())


@router.post('/generate-answer')
async def generate_answer(
    request: Request, payload: AnswerGenerationRequest, service: AIService = Depends(_service),
):
    try:
        result = await service.generate_answer(payload)
    except DocumentProcessingError as exc:
        raise envelope.new_error(exc.status_code, exc.code, exc.detail) from exc
    return envelope.ok(request, result.model_dump())


@router.post('/learning-report')
async def learning_report(
    request: Request, payload: LearningReportRequest, service: AIService = Depends(_service),
):
    if payload.stats is not None and len(json.dumps(payload.stats)) > 100_000:
        raise envelope.validation_error(
            [envelope.ValidationDetail('stats', 'must be a JSON object of at most 100,000 bytes')]
        )
    try:
        result = await service.learning_report(payload)
    except DocumentProcessingError as exc:
        raise envelope.new_error(exc.status_code, exc.code, exc.detail) from exc
    return envelope.ok(request, result.model_dump())
