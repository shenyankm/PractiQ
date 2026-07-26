from __future__ import annotations

import hmac
import os
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException

from extractors import DocumentProcessingError
from schemas import (
    AnswerGenerationRequest,
    DocumentParseRequest,
    LearningReportRequest,
)
from workflows import invoke_workflow

router = APIRouter()


def authentication_error(authorization: str | None) -> tuple[int, str] | None:
    expected = os.getenv('AI_SERVICE_TOKEN', '').strip()
    if not expected:
        return 503, 'AI service authentication is not configured'
    if not authorization or not hmac.compare_digest(
        authorization.encode(), f'Bearer {expected}'.encode()
    ):
        return 401, 'Unauthorized'
    return None


def _require_token(authorization: Annotated[str | None, Header()] = None) -> None:
    error = authentication_error(authorization)
    if error:
        status_code, detail = error
        raise HTTPException(
            status_code=status_code,
            detail=detail,
            headers={'WWW-Authenticate': 'Bearer'} if status_code == 401 else None,
        )


@router.get('/internal/health/live')
def live() -> dict[str, bool]:
    return {'ok': True}


@router.get('/internal/health/ready')
def ready() -> dict[str, bool]:
    if not os.getenv('AI_SERVICE_TOKEN', '').strip():
        raise HTTPException(
            status_code=503,
            detail='AI service authentication is not configured',
        )
    return {'ok': True}


@router.post('/internal/ai/parse-document', dependencies=[Depends(_require_token)])
async def parse_document(payload: DocumentParseRequest) -> dict[str, Any]:
    return (await _invoke('parse_document', payload)).model_dump()


@router.post('/internal/ai/generate-answer', dependencies=[Depends(_require_token)])
async def generate_answer(payload: AnswerGenerationRequest) -> dict[str, Any]:
    return (
        await _invoke('generate_answer', payload.model_dump(exclude_none=True))
    ).model_dump()


@router.post('/internal/ai/learning-report', dependencies=[Depends(_require_token)])
async def learning_report(payload: LearningReportRequest) -> dict[str, Any]:
    return (
        await _invoke('learning_report', payload.model_dump(exclude_none=True))
    ).model_dump()


async def _invoke(operation: Any, payload: Any) -> Any:
    try:
        return await invoke_workflow(operation, payload)
    except DocumentProcessingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
