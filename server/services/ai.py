"""AI operation boundary: configured models, deadlines, and usage collection."""

import asyncio
from collections.abc import Awaitable, Callable

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
from ..extractors import DocumentProcessingError, positive_env


class AIService:
    def __init__(self, config: Config):
        self._text_model, self._vision_model = agents.build_models(
            config.provider, config.api_key, config.text_model, config.vision_model
        )
        self._limit = asyncio.Semaphore(positive_env("AI_AGENT_MAX_CONCURRENCY", 4))

    async def _run[ResultT](
        self, operation: Callable[[], Awaitable[ResultT]]
    ) -> tuple[ResultT, list[ModelCallUsage]]:
        with agents.collect_usage() as usage:
            try:
                async with asyncio.timeout(180):
                    async with self._limit:
                        result = await operation()
            except TimeoutError as exc:
                raise DocumentProcessingError(
                    504,
                    "AI operation exceeded the 180-second deadline",
                    "AI_TIMEOUT",
                    usage,
                ) from exc
            except DocumentProcessingError as exc:
                exc.usage = list(usage)
                raise
            return result, usage

    async def parse_document(
        self, request: DocumentParseRequest
    ) -> tuple[DocumentParseResult, list[ModelCallUsage]]:
        return await self._run(
            lambda: agents.parse_document(self._text_model, self._vision_model, request)
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
                self._text_model, request.model_dump(exclude_none=True)
            )
        )
