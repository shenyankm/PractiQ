from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


AnswerMode = Literal['choice', 'true_false', 'fill_blank', 'short_answer']
DocumentSourceType = Literal['docx', 'txt', 'text']
ContentPartType = Literal['text', 'formula', 'image', 'table', 'list', 'html', 'markdown', 'chart', 'diagram', 'qr_code']
VisualKind = Literal['image', 'table', 'chart', 'diagram', 'qr_code']
RiskLevel = Literal['low', 'medium', 'high']


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class DocumentParseRequest(StrictModel):
    importJobId: int | None = None
    bankId: int | None = None
    sourceType: DocumentSourceType
    fileName: str | None = None
    text: str | None = None
    fileBase64: str | None = None
    mimeType: str | None = None


class ParsedOption(StrictModel):
    label: str
    content: str
    isCorrect: bool | None = None


class ContentBlock(StrictModel):
    partType: ContentPartType
    role: str | None = None
    textValue: str | None = None
    markdownValue: str | None = None
    latexValue: str | None = None
    jsonValue: dict[str, Any] | None = None


class ParsedQuestion(StrictModel):
    stem: str
    answerMode: AnswerMode
    questionTypeId: str
    options: list[ParsedOption]
    answerPayload: dict[str, Any] | None = None
    analysis: str | None = None
    contentBlocks: list[ContentBlock]
    sourceText: str | None = None
    confidence: float = Field(ge=0, le=1)
    needsReview: bool


class ParsedGroup(StrictModel):
    title: str
    instructions: str | None = None
    questionIndexes: list[int]


class VisualElement(StrictModel):
    kind: VisualKind
    label: str | None = None
    description: str
    extractedText: str | None = None


class DocumentParseResult(StrictModel):
    questions: list[ParsedQuestion]
    groups: list[ParsedGroup]
    visualElements: list[VisualElement]
    warnings: list[str]
    qualityScore: float = Field(ge=0, le=100)


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
