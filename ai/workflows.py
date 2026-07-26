from __future__ import annotations

from typing import Any, Literal, cast

import agents
from fallbacks import fallback_generate_answer, fallback_learning_report
from schemas import (
    AnswerGenerationResult,
    DocumentParseRequest,
    DocumentParseResult,
    LearningReportResult,
)

Operation = Literal['parse_document', 'generate_answer', 'learning_report']
Result = DocumentParseResult | AnswerGenerationResult | LearningReportResult
Payload = DocumentParseRequest | dict[str, Any]


async def invoke_workflow(operation: Operation, payload: Payload) -> Result:
    if operation == 'parse_document':
        return await agents.parse_document(cast(DocumentParseRequest, payload))
    if operation == 'generate_answer':
        if agents.get_text_model() is None:
            return fallback_generate_answer(cast(dict[str, Any], payload))
        return await agents.generate_answer(cast(dict[str, Any], payload))
    if operation == 'learning_report':
        if agents.get_text_model() is None:
            return fallback_learning_report(cast(dict[str, Any], payload))
        return await agents.learning_report(cast(dict[str, Any], payload))
    raise ValueError(f'Unsupported workflow operation: {operation}')
