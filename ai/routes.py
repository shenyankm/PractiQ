from __future__ import annotations

import hmac
import os
from typing import Any, Awaitable

from fastapi import APIRouter, HTTPException

import agents
from extractors import DocumentProcessingError
from schemas import (
    AnswerGenerationRequest,
    DocumentParseRequest,
    LearningReportRequest,
)

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


# 认证由 main.DocumentGuardMiddleware 在读取请求体之前统一拦截。
@router.post('/internal/ai/parse-document')
async def parse_document(payload: DocumentParseRequest) -> dict[str, Any]:
    return (await _invoke(agents.parse_document(payload))).model_dump()


@router.post('/internal/ai/generate-answer')
async def generate_answer(payload: AnswerGenerationRequest) -> dict[str, Any]:
    return (
        await _invoke(agents.generate_answer(payload.model_dump(exclude_none=True)))
    ).model_dump()


@router.post('/internal/ai/learning-report')
async def learning_report(payload: LearningReportRequest) -> dict[str, Any]:
    return (
        await _invoke(agents.learning_report(payload.model_dump(exclude_none=True)))
    ).model_dump()


async def _invoke[ResultT](call: Awaitable[ResultT]) -> ResultT:
    try:
        return await call
    except DocumentProcessingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
