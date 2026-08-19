"""Private AI HTTP operations; product authorization is owned by Java."""

import secrets

from fastapi import APIRouter, Depends, Header, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .. import envelope
from ..ai_schemas import AnswerGenerationRequest, DocumentParseRequest, LearningReportRequest
from ..operations import OperationManager, operation_id
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


def _manager(request: Request) -> OperationManager:
    return request.app.state.operation_manager


def _operation_id(
    value: str | None = Header(default=None, alias='X-AI-Operation-ID'),
) -> str:
    return operation_id(value)


@router.post('/parse-document')
async def parse_document(
    request: Request,
    payload: DocumentParseRequest,
    service: AIService = Depends(_service),
    manager: OperationManager = Depends(_manager),
    operation: str = Depends(_operation_id),
):
    result, usage = await manager.run(operation, lambda: service.parse_document(payload))
    return envelope.ok(request, result.model_dump(), {'usage': usage})


@router.post('/generate-answer')
async def generate_answer(
    request: Request,
    payload: AnswerGenerationRequest,
    service: AIService = Depends(_service),
    manager: OperationManager = Depends(_manager),
    operation: str = Depends(_operation_id),
):
    result, usage = await manager.run(operation, lambda: service.generate_answer(payload))
    return envelope.ok(request, result.model_dump(), {'usage': usage})


@router.post('/learning-report')
async def learning_report(
    request: Request,
    payload: LearningReportRequest,
    service: AIService = Depends(_service),
    manager: OperationManager = Depends(_manager),
    operation: str = Depends(_operation_id),
):
    result, usage = await manager.run(operation, lambda: service.learning_report(payload))
    return envelope.ok(request, result.model_dump(), {'usage': usage})


@router.post('/operations/{operation}/cancel')
async def cancel_operation(
    request: Request,
    operation: str,
    manager: OperationManager = Depends(_manager),
):
    resolved = operation_id(operation)
    await manager.cancel(resolved)
    return envelope.ok(request, {'operationId': resolved, 'cancelRequested': True})
