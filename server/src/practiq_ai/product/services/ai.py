"""AI operation boundary: configured models, deadlines, and usage collection."""

import asyncio
from collections.abc import Awaitable, Callable

from practiq_ai import llm

from .. import agents
from ..ai_schemas import (
    AnswerGenerationRequest,
    AnswerGenerationResult,
    DocumentParseRequest,
    DocumentParseResult,
    LearningReportRequest,
    LearningReportResult,
    ModelCallUsage,
)
from ..config import Config
from ..document_parser import parse_document
from ..support import DocumentProcessingError, positive_env


class AIService:
    def __init__(self, config: Config):
        self._text_model, _ = agents.build_models(
            config.provider, config.api_key, config.text_model
        )
        self._limit = asyncio.Semaphore(positive_env("AI_AGENT_MAX_CONCURRENCY", 4))

    async def _run[ResultT](
        self, operation: Callable[[], Awaitable[ResultT]]
    ) -> tuple[ResultT, list[ModelCallUsage]]:
        with agents.collect_usage() as usage, llm.collect_usage() as document_usage:
            try:
                async with asyncio.timeout(180):
                    async with self._limit:
                        result = await operation()
            except TimeoutError as exc:
                raise DocumentProcessingError(
                    504,
                    "AI operation exceeded the 180-second deadline",
                    "AI_TIMEOUT",
                    [*usage, *document_usage],
                ) from exc
            except DocumentProcessingError as exc:
                exc.usage = [*usage, *document_usage]
                raise
            except Exception as exc:
                raise DocumentProcessingError(502, "AI operation failed", "AI_OPERATION_FAILED", [*usage, *document_usage]) from exc
            return result, [*usage, *document_usage]

    async def parse_document(
        self, request: DocumentParseRequest
    ) -> tuple[DocumentParseResult, list[ModelCallUsage]]:
        return await self._run(
            lambda: parse_document(request)
        )

    async def generate_answer(
        self, request: AnswerGenerationRequest
    ) -> tuple[AnswerGenerationResult, list[ModelCallUsage]]:
        return await self._run(
            lambda: agents.generate_answer(
                self._text_model, request.model_dump(exclude_none=True)
            )
        )

    async def learning_report(
        self, request: LearningReportRequest
    ) -> tuple[LearningReportResult, list[ModelCallUsage]]:
        return await self._run(
            lambda: agents.learning_report(
                self._text_model, request.model_dump(mode="json", exclude_none=True)
            )
        )
