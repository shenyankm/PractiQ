from datetime import datetime
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)

from practiq_ai.contracts import (
    ANSWER_TYPES,
    AnswerPayload,
    ArtifactReference,
    ChoiceAnswerPayload,
    DocumentProcessing,
    MissingField,
    ModelCallUsage,
    ParsedItem,
    answer_references_missing,
    normalize_answer,
    question_missing_fields,
)
from practiq_ai.contracts import (
    ParsedOption as NativeParsedOption,
)
from practiq_ai.contracts import (
    ParsedQuestion as NativeParsedQuestion,
)

__all__ = ["ModelCallUsage"]

AnswerMode = Literal["choice", "true_false", "fill_blank", "short_answer", "ordering", "matching"]
DocumentSourceType = Literal["csv", "docx", "image", "text", "pdf", "xlsx"]
ContentPartType = Literal[
    "text",
    "formula",
    "image",
    "table",
    "list",
    "html",
    "markdown",
    "chart",
    "diagram",
    "qr_code",
]
VisualKind = Literal["image", "table", "chart", "diagram", "qr_code"]
RiskLevel = Literal["low", "medium", "high"]
ReportScope = Literal["individual", "class", "bank"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DocumentParseRequest(StrictModel):
    sourceType: DocumentSourceType
    fileName: str | None = Field(default=None, max_length=255)
    text: str | None = None
    fileBase64: str | None = None
    mimeType: str | None = Field(default=None, max_length=255)

    @model_validator(mode="after")
    def validate_content(self) -> Self:
        if self.sourceType == "text":
            if not self.text or not self.text.strip():
                raise ValueError("text is required for text sources")
            if self.fileBase64 is not None:
                raise ValueError("fileBase64 is not allowed for text sources")
        elif not self.fileBase64:
            raise ValueError("fileBase64 is required for binary sources")
        return self


class ParsedOption(NativeParsedOption):
    pass


class ParsedQuestion(NativeParsedQuestion):
    pass


class ParsedGroup(StrictModel):
    title: str = Field(min_length=1, max_length=1_000)
    instructions: str | None = Field(default=None, max_length=20_000)
    questionIndexes: list[int] = Field(max_length=1_000)

    @field_validator("title")
    @classmethod
    def reject_blank_title(cls, value: str) -> str:
        return _non_blank(value)


class VisualElement(StrictModel):
    kind: VisualKind
    label: str | None = Field(default=None, max_length=1_000)
    description: str = Field(min_length=1, max_length=20_000)
    extractedText: str | None = Field(default=None, max_length=100_000)
    page: int | None = Field(default=None, ge=0)
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    imageRef: ArtifactReference | None = None
    imageBase64: str | None = Field(default=None, max_length=400_000)

    @field_validator("description")
    @classmethod
    def reject_blank_description(cls, value: str) -> str:
        return _non_blank(value)


class DocumentParseResult(StrictModel):
    status: Literal["SUCCEEDED", "PARTIAL"] = "SUCCEEDED"
    processing: DocumentProcessing | None = None
    questions: list[ParsedQuestion] = Field(min_length=1, max_length=1_000)
    groups: list[ParsedGroup] = Field(max_length=1_000)
    visualElements: list[VisualElement] = Field(max_length=1_000)
    warnings: list[str] = Field(max_length=1_000)
    qualityScore: float = Field(ge=0, le=100)

    @model_validator(mode="after")
    def validate_group_indexes(self) -> Self:
        question_count = len(self.questions)
        if any(
            index < 0 or index >= question_count
            for group in self.groups
            for index in group.questionIndexes
        ):
            raise ValueError("questionIndexes must reference a parsed question")
        return self


def _non_blank(value: str) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError("must not be blank")
    return stripped


class AnswerGenerationRequest(StrictModel):
    stem: str | None = Field(default=None, max_length=120_000)
    answerMode: AnswerMode | None = None
    questionTypeId: str | None = Field(default=None, max_length=128)
    choiceVariant: Literal["single", "multiple"] | None = None
    matchingVariant: Literal["one_to_one", "many_to_one"] | None = None
    items: list[ParsedItem] = Field(default_factory=list, max_length=100)
    options: list[ParsedOption] = Field(default_factory=list, max_length=100)
    analysis: str | None = Field(default=None, max_length=100_000)
    sourceText: str | None = Field(default=None, max_length=120_000)
    missingFields: list[MissingField] = Field(default_factory=list)

    @field_validator("options", "items", "missingFields", mode="before")
    @classmethod
    def absent_list(cls, value):
        return [] if value is None else value

    @field_validator("stem", "questionTypeId", "answerMode", "choiceVariant", "matchingVariant", "analysis", "sourceText", mode="before")
    @classmethod
    def blank_to_null(cls, value):
        return None if isinstance(value, str) and not value.strip() else value

    @model_validator(mode="after")
    def validate_shape(self) -> Self:
        if self.answerMode is not None and self.answerMode != "choice" and (self.options or self.choiceVariant):
            raise ValueError("options are only allowed for choice questions")
        if self.answerMode is not None and self.answerMode not in {"ordering", "matching"} and self.items:
            raise ValueError("items require ordering or matching mode")
        if self.answerMode is not None and self.answerMode != "matching" and self.matchingVariant:
            raise ValueError("matchingVariant requires matching mode")
        if self.answerMode == "ordering" and any(i.side is not None for i in self.items):
            raise ValueError("Ordering items must be sideless")
        labels = [o.label.casefold() for o in self.options if o.label]
        if len(set(labels)) != len(labels):
            raise ValueError("option labels must be unique")
        return self


class ReportMastery(StrictModel):
    label: str = Field(min_length=1, max_length=1_000)
    attempts: int = Field(gt=0)
    correct: int = Field(ge=0)

    @field_validator("label")
    @classmethod
    def reject_blank_label(cls, value: str) -> str:
        return _non_blank(value)

    @model_validator(mode="after")
    def validate_counts(self) -> Self:
        if self.correct > self.attempts:
            raise ValueError("correct must not exceed attempts")
        return self


class ReportStats(StrictModel):
    attemptCount: int = Field(gt=0)
    correctCount: int = Field(ge=0)
    accuracy: float = Field(ge=0, le=1)
    startedAt: datetime
    endedAt: datetime
    mastery: list[ReportMastery] = Field(min_length=1, max_length=10_000)

    @field_validator("startedAt", "endedAt")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("must include a timezone")
        return value

    @model_validator(mode="after")
    def validate_totals(self) -> Self:
        if self.correctCount > self.attemptCount:
            raise ValueError("correctCount must not exceed attemptCount")
        if self.endedAt <= self.startedAt:
            raise ValueError("endedAt must be after startedAt")
        return self


class AccuracyTrendItem(StrictModel):
    label: str = Field(min_length=1, max_length=1_000)
    accuracy: float = Field(ge=0, le=1)

    @field_validator("label")
    @classmethod
    def reject_blank_label(cls, value: str) -> str:
        return _non_blank(value)


class DistributionItem(StrictModel):
    label: str = Field(min_length=1, max_length=1_000)
    count: int = Field(gt=0)

    @field_validator("label")
    @classmethod
    def reject_blank_label(cls, value: str) -> str:
        return _non_blank(value)


class IndividualReportStats(ReportStats):
    accuracyTrend: list[AccuracyTrendItem] = Field(min_length=1, max_length=10_000)
    weakKnowledgePoints: list[str] = Field(min_length=1, max_length=10_000)

    @field_validator("weakKnowledgePoints")
    @classmethod
    def reject_blank_knowledge_points(cls, value: list[str]) -> list[str]:
        return [_non_blank(item) for item in value]


class BankReportStats(ReportStats):
    questionCount: int = Field(gt=0)
    questionTypeDistribution: list[DistributionItem] = Field(
        min_length=1, max_length=10_000
    )


class ClassReportStats(ReportStats):
    learnerCount: int = Field(gt=0)
    scoreDistribution: list[DistributionItem] = Field(min_length=1, max_length=10_000)


class LearningReportRequest(StrictModel):
    scope: ReportScope = "individual"
    stats: IndividualReportStats | BankReportStats | ClassReportStats

    @model_validator(mode="after")
    def validate_scope(self) -> Self:
        expected = (
            "individual"
            if isinstance(self.stats, IndividualReportStats)
            else "bank"
            if isinstance(self.stats, BankReportStats)
            else "class"
        )
        if self.scope != expected:
            raise ValueError("scope does not match stats")
        return self


ANSWER_PAYLOAD_TYPES = ANSWER_TYPES


class AnswerGenerationResult(StrictModel):
    answerPayload: AnswerPayload | dict[str, Any] | None = None
    canonicalAnswer: str | None = None
    explanation: str | None = None
    steps: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0, ge=0, le=1)
    educationalValue: str | None = None
    missingFields: list[MissingField] = Field(default_factory=list)

    @field_validator("canonicalAnswer", "explanation", "educationalValue", mode="before")
    @classmethod
    def blank_to_null(cls, value):
        return (value.strip() or None) if isinstance(value, str) else value

    @field_validator("steps", "missingFields", mode="before")
    @classmethod
    def absent_list(cls, value):
        return [] if value is None else value

    @model_validator(mode="after")
    def validate_answer_payload(self, info: ValidationInfo) -> Self:
        if info.context is None:
            return self
        context = info.context
        mode = context.get("answerMode")
        self.answerPayload = normalize_answer(mode, self.answerPayload, context.get("choiceVariant"))
        answer_references_missing(mode, self.answerPayload, context)
        if isinstance(self.answerPayload, ChoiceAnswerPayload):
            labels = {o["label"].strip().casefold(): o["label"].strip() for o in context.get("options", []) if o.get("label")}
            canonical = labels.get(self.answerPayload.correctOption.casefold())
            if canonical is None:
                raise ValueError("correctOption must reference a supplied option label")
            self.answerPayload.correctOption = canonical
        data = {**context, "answerPayload": self.answerPayload,
                "analysis": self.explanation or context.get("analysis"),
                "missingFields": list(set(context.get("missingFields", [])) | set(self.missingFields))}
        self.missingFields = question_missing_fields(data)
        return self


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

    @model_validator(mode="after")
    def ground_mastery(self, info: ValidationInfo) -> Self:
        if info.context is None:
            return self
        stats = info.context["stats"]
        rows = {row["label"]: row for row in stats["mastery"]}
        labels = [item.label for item in self.mastery]
        if len(labels) != len(set(labels)) or set(labels) != set(rows):
            raise ValueError("mastery must include every supplied label exactly once")
        allowed = set(rows) | set(stats.get("weakKnowledgePoints", []))
        if any(item.label not in allowed for item in self.weakPoints):
            raise ValueError("weakPoints must reference supplied labels")
        for item in self.mastery:
            row = rows[item.label]
            item.score = row["correct"] / row["attempts"]
            item.evidence = f"{row['correct']}/{row['attempts']} 次作答正确；仅反映已提供的练习记录。"
        return self


class BankMetadataRequest(StrictModel):
    name: str = Field(min_length=1, max_length=100, pattern=r"\S")


class BankMetadataResult(StrictModel):
    description: str = Field(min_length=1, max_length=500, pattern=r"[\s\S]*\S[\s\S]*")
    tags: list[Annotated[str, Field(min_length=1, max_length=64, pattern=r"[\s\S]*\S[\s\S]*")]] = (
        Field(min_length=3, max_length=6)
    )

    @field_validator("tags")
    @classmethod
    def unique_tags(cls, tags: list[str]) -> list[str]:
        tags = [tag.strip() for tag in tags]
        if len({tag.casefold() for tag in tags}) != len(tags):
            raise ValueError("tags must be unique")
        return tags
