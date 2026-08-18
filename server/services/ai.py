"""AI operation boundary: configured models and agent invocation."""

from .. import agents
from ..ai_schemas import (
    AnswerGenerationRequest,
    AnswerGenerationResult,
    DocumentParseRequest,
    DocumentParseResult,
    LearningReportRequest,
    LearningReportResult,
)
from ..config import Config


class AIService:
    def __init__(self, config: Config):
        self._text_model, self._vision_model = agents.build_models(
            config.provider, config.api_key, config.text_model, config.vision_model
        )

    async def parse_document(self, request: DocumentParseRequest) -> DocumentParseResult:
        return await agents.parse_document(self._text_model, self._vision_model, request)

    async def generate_answer(self, request: AnswerGenerationRequest) -> AnswerGenerationResult:
        return await agents.generate_answer(
            self._text_model, request.model_dump(exclude_none=True)
        )

    async def learning_report(self, request: LearningReportRequest) -> LearningReportResult:
        return await agents.learning_report(
            self._text_model, request.model_dump(exclude_none=True)
        )
