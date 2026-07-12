from __future__ import annotations

import os
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException

from .schemas import DocumentParseRequest
from .workflows import invoke_workflow

app = FastAPI()


def _require_token(authorization: Annotated[str | None, Header()] = None) -> None:
    expected = os.getenv('AI_SERVICE_TOKEN', '').strip()
    if not expected:
        return
    if authorization != f'Bearer {expected}':
        raise HTTPException(status_code=401, detail='Unauthorized')


@app.get('/internal/health/live')
def live() -> dict[str, bool]:
    return {'ok': True}


@app.get('/internal/health/ready')
def ready() -> dict[str, bool]:
    return {'ok': True}


@app.post('/internal/ai/parse-document', dependencies=[Depends(_require_token)])
def parse_document(payload: DocumentParseRequest) -> dict[str, Any]:
    return invoke_workflow('parse_document', payload).model_dump()


@app.post('/internal/ai/generate-answer', dependencies=[Depends(_require_token)])
def generate_answer(payload: dict[str, Any]) -> dict[str, Any]:
    return invoke_workflow('generate_answer', payload).model_dump()


@app.post('/internal/ai/learning-report', dependencies=[Depends(_require_token)])
def learning_report(payload: dict[str, Any]) -> dict[str, Any]:
    return invoke_workflow('learning_report', payload).model_dump()
