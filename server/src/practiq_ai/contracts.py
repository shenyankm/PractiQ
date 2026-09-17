"""Strict public contracts for PractiQ."""

from math import isfinite
from typing import Any, Literal, Self
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    field_validator,
    model_validator,
)

AnswerMode = Literal["choice", "true_false", "fill_blank", "short_answer"]
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
DOCUMENT_MEDIA_TYPES = {
    "csv": {"text/csv"},
    "docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    "pdf": {"application/pdf"},
    "text": {"text/plain"},
    "xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
}


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _non_blank(value: str) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError("must not be blank")
    return stripped


def _media_type_matches(source_type: DocumentSourceType, media_type: str) -> bool:
    return (
        media_type.startswith("image/")
        if source_type == "image"
        else media_type in DOCUMENT_MEDIA_TYPES[source_type]
    )


def document_source_key(source_type: DocumentSourceType, sha256: str) -> str:
    suffix = "txt" if source_type == "text" else source_type
    return f"practiq-agent/sources/{sha256}/source.{suffix}"


class ModelCallUsage(StrictModel):
    callKey: UUID
    modelId: str = Field(min_length=1, max_length=255)
    inputTokens: int = Field(ge=0)
    outputTokens: int = Field(ge=0)
    callKind: str = Field(min_length=1, max_length=64)


class DocumentUploadRequest(StrictModel):
    sourceType: DocumentSourceType
    fileName: str | None = Field(default=None, max_length=255)
    mediaType: str | None = Field(default=None, max_length=255)
    sizeBytes: int | None = Field(default=None, gt=0)
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @field_validator("fileName", "mediaType")
    @classmethod
    def reject_blank_optional_text(cls, value: str | None) -> str | None:
        return _non_blank(value) if value is not None else None

    @model_validator(mode="after")
    def validate_content(self) -> Self:
        if not all((self.fileName, self.mediaType, self.sizeBytes, self.sha256)):
            raise ValueError("fileName, mediaType, sizeBytes, and sha256 are required")
        assert self.mediaType is not None
        if not _media_type_matches(self.sourceType, self.mediaType):
            raise ValueError("mediaType does not match sourceType")
        return self


class ParsedOption(StrictModel):
    label: str = Field(min_length=1, max_length=32)
    content: str = Field(min_length=1, max_length=20_000)
    isCorrect: bool | None = None

    @field_validator("label", "content")
    @classmethod
    def reject_blank_values(cls, value: str) -> str:
        return _non_blank(value)


class ChoiceAnswerPayload(StrictModel):
    correctOption: str = Field(min_length=1, max_length=32)

    @field_validator("correctOption")
    @classmethod
    def reject_blank_option(cls, value: str) -> str:
        return _non_blank(value)


class TrueFalseAnswerPayload(StrictModel):
    value: StrictBool


class FillBlankAnswerPayload(StrictModel):
    answers: list[str] = Field(min_length=1, max_length=100)

    @field_validator("answers")
    @classmethod
    def reject_blank_answers(cls, value: list[str]) -> list[str]:
        return [_non_blank(item) for item in value]


class ShortAnswerPayload(StrictModel):
    text: str = Field(min_length=1, max_length=120_000)

    @field_validator("text")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        return _non_blank(value)


AnswerPayload = (
    ChoiceAnswerPayload
    | TrueFalseAnswerPayload
    | FillBlankAnswerPayload
    | ShortAnswerPayload
)


class ContentBlock(StrictModel):
    partType: ContentPartType
    role: str | None = Field(default=None, max_length=64)
    textValue: str | None = Field(default=None, max_length=120_000)
    markdownValue: str | None = Field(default=None, max_length=100_000)
    latexValue: str | None = Field(default=None, max_length=20_000)
    jsonValue: dict[str, Any] | None = None

    @model_validator(mode="after")
    def require_content(self) -> Self:
        strings = (self.textValue, self.markdownValue, self.latexValue)
        if (
            not any(value and value.strip() for value in strings)
            and self.jsonValue is None
        ):
            raise ValueError("content block must contain a value")
        return self


class ParsedQuestion(StrictModel):
    stem: str = Field(min_length=1, max_length=120_000)
    answerMode: AnswerMode
    questionTypeId: str = Field(min_length=1, max_length=128)
    options: list[ParsedOption] = Field(max_length=100)
    answerPayload: AnswerPayload | None = None
    analysis: str | None = Field(default=None, max_length=100_000)
    contentBlocks: list[ContentBlock] = Field(min_length=1, max_length=1_000)
    sourceText: str | None = Field(default=None, max_length=120_000)
    confidence: float = Field(ge=0, le=1)
    needsReview: bool

    @field_validator("stem", "questionTypeId")
    @classmethod
    def reject_blank_values(cls, value: str) -> str:
        return _non_blank(value)

    @model_validator(mode="after")
    def validate_answer(self) -> Self:
        if self.answerMode == "choice" and not self.options:
            raise ValueError("options are required for choice questions")
        if self.answerMode != "choice" and self.options:
            raise ValueError("options are only allowed for choice questions")
        labels = [option.label.casefold() for option in self.options]
        if len(labels) != len(set(labels)):
            raise ValueError("option labels must be unique")
        expected = {
            "choice": ChoiceAnswerPayload,
            "true_false": TrueFalseAnswerPayload,
            "fill_blank": FillBlankAnswerPayload,
            "short_answer": ShortAnswerPayload,
        }[self.answerMode]
        if self.answerPayload is not None and not isinstance(
            self.answerPayload, expected
        ):
            raise ValueError("answerPayload does not match answerMode")
        if isinstance(self.answerPayload, ChoiceAnswerPayload):
            labels_by_key = {
                option.label.casefold(): option.label for option in self.options
            }
            canonical = labels_by_key.get(self.answerPayload.correctOption.casefold())
            if canonical is None:
                raise ValueError("correctOption must reference an option label")
            self.answerPayload = ChoiceAnswerPayload(correctOption=canonical)
        return self


class ParsedGroup(StrictModel):
    title: str = Field(min_length=1, max_length=1_000)
    instructions: str | None = Field(default=None, max_length=20_000)
    questionIndexes: list[int] = Field(max_length=1_000)

    @field_validator("title")
    @classmethod
    def reject_blank_title(cls, value: str) -> str:
        return _non_blank(value)


class ArtifactReference(StrictModel):
    objectKey: str = Field(min_length=1, max_length=1_024)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    mediaType: str = Field(min_length=1, max_length=255)
    sizeBytes: int = Field(ge=0)


class DocumentReference(ArtifactReference):
    sourceType: DocumentSourceType
    fileName: str | None = Field(default=None, max_length=255)


class LocalUpload(StrictModel):
    method: Literal["PUT"] = "PUT"
    url: str = Field(min_length=1)
    headers: dict[str, str]


class DocumentUploadResponse(StrictModel):
    document: DocumentReference
    upload: LocalUpload | None


class VisualElement(StrictModel):
    kind: VisualKind
    label: str | None = Field(default=None, max_length=1_000)
    description: str = Field(min_length=1, max_length=20_000)
    extractedText: str | None = Field(default=None, max_length=100_000)
    page: int | None = Field(default=None, ge=0)
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    imageRef: ArtifactReference | None = None

    @field_validator("description")
    @classmethod
    def reject_blank_description(cls, value: str) -> str:
        return _non_blank(value)

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, value: list[float] | None) -> list[float] | None:
        if value is None:
            return None
        x0, y0, x1, y1 = value
        if not all(isfinite(item) and 0 <= item <= 1 for item in value):
            raise ValueError("bbox values must be finite and normalized")
        if x1 <= x0 or y1 <= y0:
            raise ValueError("bbox must have positive area")
        return value


class DocumentParseResult(StrictModel):
    questions: list[ParsedQuestion] = Field(min_length=1, max_length=1_000)
    groups: list[ParsedGroup] = Field(max_length=1_000)
    visualElements: list[VisualElement] = Field(max_length=1_000)
    warnings: list[str] = Field(max_length=1_000)
    confidenceScore: float = Field(ge=0, le=100)

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


class UnitCounts(StrictModel):
    total: int = Field(ge=0)
    succeeded: int = Field(ge=0)
    skipped: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_counts(self) -> Self:
        if self.succeeded + self.skipped > self.total:
            raise ValueError("succeeded and skipped must not exceed total")
        return self


class UnitFailure(StrictModel):
    stage: str = Field(min_length=1, max_length=64)
    index: int = Field(ge=0)
    code: str = Field(min_length=1, max_length=64)
    retryable: bool


class DocumentProcessing(StrictModel):
    chunks: UnitCounts
    visuals: UnitCounts
    truncated: bool
    failures: list[UnitFailure] = Field(max_length=2_000)


class DocumentParseInput(StrictModel):
    document: DocumentReference

    @model_validator(mode="after")
    def require_managed_storage_reference(self) -> Self:
        document = self.document
        expected_key = document_source_key(document.sourceType, document.sha256)
        if document.objectKey != expected_key:
            raise ValueError("document must reference a managed storage source object")
        if not _media_type_matches(document.sourceType, document.mediaType):
            raise ValueError("document mediaType does not match sourceType")
        return self
