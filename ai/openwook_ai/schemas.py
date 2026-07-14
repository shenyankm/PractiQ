from __future__ import annotations

from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


AnswerMode = Literal['choice', 'true_false', 'fill_blank', 'short_answer']
DocumentSourceType = Literal['docx', 'txt', 'text']
UploadSourceType = Literal['txt', 'docx', 'pdf', 'image']
ParseMethod = Literal['auto', 'ocr']
ContentPartType = Literal['text', 'formula', 'image', 'table', 'list', 'html', 'markdown', 'chart', 'diagram', 'qr_code']
VisualKind = Literal['image', 'table', 'chart', 'diagram', 'qr_code']
RiskLevel = Literal['low', 'medium', 'high']


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class DocumentParseRequest(StrictModel):
    importJobId: int | None = None
    bankId: int | None = None
    sourceType: DocumentSourceType
    fileName: str | None = Field(default=None, max_length=255)
    text: str | None = None
    fileBase64: str | None = None
    mimeType: str | None = Field(default=None, max_length=255)


class FileUploadWorkflowRequest(StrictModel):
    importJobId: int | None = Field(default=None, gt=0)
    bankId: int | None = Field(default=None, gt=0)
    sourceType: UploadSourceType
    fileName: str = Field(min_length=1, max_length=255)
    fileBytes: bytes = Field(min_length=1, repr=False)
    mimeType: str = Field(min_length=1, max_length=255)
    parseMethod: ParseMethod = 'auto'


class ParsedOption(StrictModel):
    label: str = Field(min_length=1, max_length=32)
    content: str = Field(min_length=1, max_length=20_000)
    isCorrect: bool | None = None

    @field_validator('label', 'content')
    @classmethod
    def reject_blank_values(cls, value: str) -> str:
        return _non_blank(value)


class ContentBlock(StrictModel):
    partType: ContentPartType
    role: str | None = Field(default=None, max_length=64)
    textValue: str | None = Field(default=None, max_length=120_000)
    markdownValue: str | None = Field(default=None, max_length=100_000)
    latexValue: str | None = Field(default=None, max_length=20_000)
    jsonValue: dict[str, Any] | None = None


class ParsedQuestion(StrictModel):
    stem: str = Field(min_length=1, max_length=120_000)
    answerMode: AnswerMode
    questionTypeId: str = Field(min_length=1, max_length=128)
    options: list[ParsedOption] = Field(max_length=100)
    answerPayload: dict[str, Any] | None = None
    analysis: str | None = Field(default=None, max_length=100_000)
    contentBlocks: list[ContentBlock] = Field(min_length=1, max_length=1_000)
    sourceText: str | None = Field(default=None, max_length=120_000)
    confidence: float = Field(ge=0, le=1)
    needsReview: bool

    @field_validator('stem', 'questionTypeId')
    @classmethod
    def reject_blank_values(cls, value: str) -> str:
        return _non_blank(value)

    @model_validator(mode='after')
    def validate_options(self) -> Self:
        if self.answerMode == 'choice' and not self.options:
            raise ValueError('options are required for choice questions')
        labels = [option.label.casefold() for option in self.options]
        if len(labels) != len(set(labels)):
            raise ValueError('option labels must be unique')
        answer_payload = self.answerPayload or {}
        correct_option = answer_payload.get('correctOption')
        if self.answerMode == 'choice' and correct_option is not None:
            if not isinstance(correct_option, str):
                raise ValueError('correctOption must be an option label')
            labels_by_key = {option.label.casefold(): option.label for option in self.options}
            canonical_label = labels_by_key.get(_non_blank(correct_option).casefold())
            if canonical_label is None:
                raise ValueError('correctOption must reference an option label')
            self.answerPayload = {**answer_payload, 'correctOption': canonical_label}
        return self


class ParsedGroup(StrictModel):
    title: str = Field(min_length=1, max_length=1_000)
    instructions: str | None = Field(default=None, max_length=20_000)
    questionIndexes: list[int] = Field(max_length=1_000)

    @field_validator('title')
    @classmethod
    def reject_blank_title(cls, value: str) -> str:
        return _non_blank(value)


class VisualElement(StrictModel):
    kind: VisualKind
    label: str | None = Field(default=None, max_length=1_000)
    description: str = Field(min_length=1, max_length=20_000)
    extractedText: str | None = Field(default=None, max_length=100_000)

    @field_validator('description')
    @classmethod
    def reject_blank_description(cls, value: str) -> str:
        return _non_blank(value)


class DocumentParseResult(StrictModel):
    questions: list[ParsedQuestion] = Field(min_length=1, max_length=1_000)
    groups: list[ParsedGroup] = Field(max_length=1_000)
    visualElements: list[VisualElement] = Field(max_length=1_000)
    warnings: list[str] = Field(max_length=1_000)
    qualityScore: float = Field(ge=0, le=100)

    @model_validator(mode='after')
    def validate_group_indexes(self) -> Self:
        question_count = len(self.questions)
        if any(
            index < 0 or index >= question_count
            for group in self.groups
            for index in group.questionIndexes
        ):
            raise ValueError('questionIndexes must reference a parsed question')
        return self


def _non_blank(value: str) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError('must not be blank')
    return stripped


class AnswerGenerationResult(StrictModel):
    answerPayload: dict[str, Any]
    canonicalAnswer: str
    explanation: str
    steps: list[str]
    confidence: float = Field(ge=0, le=1)
    educationalValue: str | None = None


class MasteryItem(StrictModel):
    label: str
    score: float = Field(ge=0, le=1)
    evidence: str


class WeakPoint(StrictModel):
    label: str
    reason: str
    suggestedAction: str


class LearningReportResult(StrictModel):
    summary: str
    mastery: list[MasteryItem]
    weakPoints: list[WeakPoint]
    recommendations: list[str]
    riskLevel: RiskLevel
