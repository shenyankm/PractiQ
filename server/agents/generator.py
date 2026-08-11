from __future__ import annotations

import json
from typing import Any

from agentscope.message import SystemMsg, UserMsg

from ..extractors import DocumentProcessingError
from ..ai_schemas import AnswerGenerationResult, LearningReportResult

from .model import get_text_model, structured_call

VALIDATION_RETRIES = 1

ANSWER_PROMPT = (
    'You are a subject-matter tutor. Solve the supplied assessment question '
    'and produce the canonical answer, a clear explanation, and the solution '
    'steps. For choice questions, answerPayload must contain the correct '
    'option label under the key "correctOption".'
)
REPORT_PROMPT = (
    'You are a learning analyst. Produce a learning report for the supplied '
    'request context. Be honest about the limited context: base the mastery '
    'scores and weak points only on the information provided.'
)


async def generate_answer(payload: dict[str, Any]) -> AnswerGenerationResult:
    return await _generate(ANSWER_PROMPT, payload, AnswerGenerationResult)


async def learning_report(payload: dict[str, Any]) -> LearningReportResult:
    return await _generate(REPORT_PROMPT, payload, LearningReportResult)


async def _generate[ResultT](
    prompt: str, payload: dict[str, Any], schema: type[ResultT]
) -> ResultT:
    model = get_text_model()
    result = await structured_call(
        model,
        [
            SystemMsg(name='system', content=prompt),
            UserMsg(name='user', content=json.dumps(payload, ensure_ascii=False)),
        ],
        schema,
        VALIDATION_RETRIES,
    )
    if result is None:
        raise DocumentProcessingError(502, 'AI agent returned invalid JSON')
    return result
