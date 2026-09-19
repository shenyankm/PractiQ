"""Strict public contracts for PractiQ."""

from math import isfinite
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    TypeAdapter,
    field_validator,
    model_validator,
)

AnswerMode = Literal["choice", "true_false", "fill_blank", "short_answer", "ordering", "matching"]
DocumentSourceType = Literal["csv", "image", "text", "pdf"]
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
    "image": {"image/png", "image/jpeg"},
    "csv": {"text/csv"},
    "pdf": {"application/pdf"},
    "text": {"text/plain"},
}


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _non_blank(value: str) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError("must not be blank")
    return stripped


def _media_type_matches(source_type: DocumentSourceType, media_type: str) -> bool:
    return media_type in DOCUMENT_MEDIA_TYPES[source_type]


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
    label: str | None = Field(default=None, max_length=32)
    content: str | None = Field(default=None, max_length=20_000)
    isCorrect: StrictBool | None = None

    @field_validator("label", "content", mode="before")
    @classmethod
    def normalize_blank(cls, value):
        return (value.strip() or None) if isinstance(value, str) else value


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


class OrderingAnswerPayload(StrictModel):
    order: list[StrictInt] = Field(min_length=1, max_length=100)


class MatchPair(StrictModel):
    left: StrictInt
    right: StrictInt


class MatchingAnswerPayload(StrictModel):
    matches: list[MatchPair] = Field(min_length=1, max_length=100)


class MultipleChoiceAnswerPayload(StrictModel):
    correct: list[str] = Field(min_length=1, max_length=100)


class ParsedItem(StrictModel):
    id: StrictInt | None = None
    side: Literal["left", "right"] | None = None
    content: str | None = Field(default=None, max_length=20_000)

    @field_validator("content", mode="before")
    @classmethod
    def blank_to_null(cls, value):
        return (value.strip() or None) if isinstance(value, str) else value


AnswerPayload = (
    ChoiceAnswerPayload
    | TrueFalseAnswerPayload
    | FillBlankAnswerPayload
    | ShortAnswerPayload
    | OrderingAnswerPayload
    | MatchingAnswerPayload
    | MultipleChoiceAnswerPayload
)


MissingField = Literal["stem", "questionTypeId", "answerMode", "choiceVariant", "matchingVariant", "options", "items", "answerPayload", "analysis", "sourceText", "media", "material"]
ANSWER_TYPES = {"choice": ChoiceAnswerPayload, "true_false": TrueFalseAnswerPayload,
                "fill_blank": FillBlankAnswerPayload, "short_answer": ShortAnswerPayload, "ordering": OrderingAnswerPayload, "matching": MatchingAnswerPayload}


def normalize_missing_values(value):
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, list):
        return [normalize_missing_values(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize_missing_values(item) for key, item in value.items()}
    return value


def normalize_answer(mode, payload, variant=None):
    if isinstance(payload, BaseModel):
        payload = payload.model_dump()
    payload = normalize_missing_values(payload)
    if payload is None or payload == {}:
        return None
    if not isinstance(payload, dict):
        raise ValueError("answerPayload must be an object")  # noqa: TRY004 - Pydantic validation boundary
    schemas = [*ANSWER_TYPES.values(), MultipleChoiceAnswerPayload]
    schema = (next((item for item in schemas if set(payload) <= set(item.model_fields)), None)
              if mode is None else MultipleChoiceAnswerPayload if mode == "choice" and variant == "multiple" else ANSWER_TYPES[mode])
    if schema is None or set(payload) - set(schema.model_fields):
        raise ValueError("answerPayload does not match answerMode")
    partial = mode is None
    for key, field in schema.model_fields.items():
        value = payload.get(key)
        if value is None:
            partial = True
            continue
        if key in {"answers", "order", "matches", "correct"}:
            if not isinstance(value, list) or len(value) > 100:
                raise ValueError("answer lists must contain at most 100 entries")
            partial |= not value
            for entry in value:
                if entry is None:
                    partial = True
                elif key == "matches":
                    if not isinstance(entry, dict) or set(entry) - {"left", "right"}:
                        raise ValueError("matches must contain left/right pairs")
                    for side in ("left", "right"):
                        if entry.get(side) is None:
                            partial = True
                        else:
                            TypeAdapter(StrictInt).validate_python(entry[side], strict=True)
                else:
                    TypeAdapter(StrictInt if key == "order" else str).validate_python(entry, strict=True)
        else:
            TypeAdapter(Annotated[field.annotation, *field.metadata]).validate_python(value, strict=True)
    return payload if partial else schema.model_validate(payload)


def answer_references_missing(mode, answer, data):
    if answer is None:
        return True
    partial = isinstance(answer, dict)
    payload = answer if partial else answer.model_dump()
    if mode == "choice":
        selected = payload.get("correct") or [payload.get("correctOption")]
        selected = [v for v in selected if v is not None]
        labels = {o["label"].casefold(): o["label"] for o in data.get("options", []) if o.get("label")}
        if len({v.casefold() for v in selected}) != len(selected):
            raise ValueError("correct options must be unique")
        if labels and any(v.casefold() not in labels for v in selected):
            raise ValueError("correctOption must reference an option label")
        if isinstance(answer, MultipleChoiceAnswerPayload) and labels:
            answer.correct = [labels[v.casefold()] for v in selected]
    items = data.get("items") or []
    if mode == "ordering" and items:
        ids = [i.get("id") if i.get("id") is not None else n for n, i in enumerate(items)]
        order = [v for v in payload.get("order") or [] if v is not None]
        if len(set(order)) != len(order) or not set(order) <= set(ids):
            raise ValueError("order must reference distinct supplied items")
        return partial or len(order) != len(ids)
    if mode == "matching" and items:
        sides = {side: [i for i in items if i.get("side") == side] for side in ("left", "right")}
        ids = {side: [i.get("id") if i.get("id") is not None else n for n, i in enumerate(values)] for side, values in sides.items()}
        matches = [m for m in payload.get("matches") or [] if m is not None]
        left = [m["left"] for m in matches if m.get("left") is not None]
        right = [m["right"] for m in matches if m.get("right") is not None]
        if len(set(left)) != len(left) or not set(left) <= set(ids["left"]) or not set(right) <= set(ids["right"]):
            raise ValueError("matches must reference supplied left/right items once")
        if data.get("matchingVariant") == "one_to_one" and len(set(right)) != len(right):
            raise ValueError("one-to-one matches require distinct right items")
        return partial or len(left) != len(ids["left"])
    return partial


def question_missing_fields(data):
    missing = []
    for field in ("stem", "questionTypeId", "answerMode"):
        if not data.get(field):
            missing.append(field)
    mode = data.get("answerMode")
    if mode == "choice":
        if not data.get("choiceVariant"):
            missing.append("choiceVariant")
        options = data.get("options") or []
        if len(options) < 2 or any(not o.get("label") or not o.get("content") for o in options):
            missing.append("options")
    if mode in {"ordering", "matching"}:
        items = data.get("items") or []
        if mode == "matching" and not data.get("matchingVariant"):
            missing.append("matchingVariant")
        if len(items)<2 or any(not item.get("content") for item in items) or mode == "matching" and (any(i.get("side") is None for i in items) or sum(i.get("side")=="left" for i in items)<2 or sum(i.get("side")=="right" for i in items)<2):
            missing.append("items")
    answer = normalize_answer(mode, data.get("answerPayload"), data.get("choiceVariant"))
    if answer_references_missing(mode, answer, data):
        missing.append("answerPayload")
    for field in ("analysis", "sourceText"):
        if not data.get(field):
            missing.append(field)
    missing.extend(field for field in ("media", "material") if field in data.get("missingFields", []))
    return missing


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
    stem: str | None = Field(default=None, max_length=120_000)
    answerMode: AnswerMode | None = None
    questionTypeId: str | None = Field(default=None, max_length=128)
    choiceVariant: Literal["single", "multiple"] | None = None
    matchingVariant: Literal["one_to_one", "many_to_one"] | None = None
    items: list[ParsedItem] = Field(default_factory=list, max_length=100)
    options: list[ParsedOption] = Field(default_factory=list, max_length=100)
    answerPayload: AnswerPayload | dict[str, Any] | None = Field(default=None, description="Extract only an answer explicitly supplied by the source; never solve the question. Use null when absent.")
    analysis: str | None = Field(default=None, max_length=100_000)
    contentBlocks: list[ContentBlock] = Field(default_factory=list, max_length=1_000)
    sourceText: str | None = Field(default=None, max_length=120_000, description="Literal source text for locating this question; do not summarize or paraphrase.")
    confidence: float = Field(default=0, ge=0, le=1, description="Reliability of extraction, not confidence that the answer is correct.")
    needsReview: StrictBool = Field(default=True, description="True when extraction is uncertain; missing fields also force review during validation.")
    missingFields: list[MissingField] = Field(default_factory=list)

    @field_validator("options", "items", "contentBlocks", "missingFields", mode="before")
    @classmethod
    def absent_list(cls, value):
        return [] if value is None else value

    @field_validator("stem", "questionTypeId", "answerMode", "choiceVariant", "matchingVariant", "analysis", "sourceText", mode="before")
    @classmethod
    def blank_to_null(cls, value):
        return (value.strip() or None) if isinstance(value, str) else value

    @model_validator(mode="after")
    def validate_answer(self) -> Self:
        if self.answerMode is not None and self.answerMode != "choice" and (self.options or self.choiceVariant):
            raise ValueError("options are only allowed for choice questions")
        if self.answerMode is not None and self.answerMode not in {"ordering", "matching"} and self.items:
            raise ValueError("items require ordering or matching mode")
        if self.answerMode is not None and self.answerMode != "matching" and self.matchingVariant:
            raise ValueError("matchingVariant requires matching mode")
        if self.answerMode == "ordering" and any(i.side is not None for i in self.items):
            raise ValueError("Ordering items must be sideless")
        labels = [o.label.casefold() for o in self.options if o.label]
        if len(labels) != len(set(labels)):
            raise ValueError("option labels must be unique")
        self.answerPayload = normalize_answer(self.answerMode, self.answerPayload, self.choiceVariant)
        if isinstance(self.answerPayload, ChoiceAnswerPayload) and labels:
            canonical = {o.label.casefold(): o.label for o in self.options if o.label}.get(self.answerPayload.correctOption.casefold())
            if canonical is None:
                raise ValueError("correctOption must reference an option label")
            self.answerPayload = ChoiceAnswerPayload(correctOption=canonical)
        answer_references_missing(self.answerMode, self.answerPayload, self.model_dump())
        self.missingFields = question_missing_fields(self.model_dump())
        if self.missingFields:
            self.needsReview = True
        if not any((self.stem, self.sourceText, self.options, self.items, self.contentBlocks, self.answerPayload, self.analysis)):
            raise ValueError("An empty object is not an identifiable question")
        return self


class ParsedGroup(StrictModel):
    title: str = Field(min_length=1, max_length=1_000)
    instructions: str | None = Field(default=None, max_length=20_000)
    questionIndexes: list[StrictInt] = Field(max_length=1_000, description="Zero-based positions in this fragment's questions, not printed question numbers.")

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


VisualLabel = Annotated[str, Field(max_length=1_000)]
VisualDescription = Annotated[str, Field(min_length=1, max_length=20_000), AfterValidator(_non_blank)]


class VisualElement(StrictModel):
    questionIndexes: list[StrictInt] = Field(default_factory=list, max_length=1_000)
    kind: VisualKind
    label: VisualLabel | None = None
    description: VisualDescription
    extractedText: str | None = Field(default=None, max_length=100_000)
    page: int | None = Field(default=None, ge=0)
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    imageRef: ArtifactReference | None = None

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
        if any(index < 0 or index >= question_count for visual in self.visualElements for index in visual.questionIndexes):
            raise ValueError("visual questionIndexes must reference a parsed question")
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
    retriesRemaining: int = Field(default=0, ge=0, le=2)


class QuestionSource(StrictModel):
    questionIndex: int = Field(ge=0)
    stage: Literal["document_parse", "vision_parse"]
    unitIndex: int = Field(ge=0)


class QualityIssue(StrictModel):
    questionIndex: int = Field(ge=0)
    code: Literal["SOURCE_TEXT_NOT_FOUND", "AMBIGUOUS_OVERLAP", "OVERLAP_CONFLICT", "MISSING_FIELDS", "NEEDS_REVIEW"]


class DocumentQuality(StrictModel):
    reviewRequired: bool = False
    reviewQuestionCount: int = Field(default=0, ge=0)
    issues: list[QualityIssue] = Field(default_factory=list)


class DocumentProcessing(StrictModel):
    chunks: UnitCounts
    visuals: UnitCounts
    truncated: bool
    failures: list[UnitFailure] = Field(max_length=2_000)
    questionSources: list[QuestionSource] = Field(default_factory=list)
    quality: DocumentQuality = Field(default_factory=DocumentQuality)


class FailedUnit(StrictModel):
    stage: Literal["vision_parse", "vision_describe", "document_parse"]
    index: StrictInt = Field(ge=0)


class RetryUnits(StrictModel):
    requestId: UUID
    units: list[FailedUnit] = Field(default_factory=list, max_length=2_000)


class DocumentParseInput(StrictModel):
    document: DocumentReference
    failurePolicy: Literal["return_partial", "review"] = "return_partial"
    retry: RetryUnits | None = None

    @model_validator(mode="after")
    def require_managed_storage_reference(self) -> Self:
        document = self.document
        expected_key = document_source_key(document.sourceType, document.sha256)
        if document.objectKey != expected_key:
            raise ValueError("document must reference a managed storage source object")
        if not _media_type_matches(document.sourceType, document.mediaType):
            raise ValueError("document mediaType does not match sourceType")
        return self


GraphId = Literal["document_parser", "text_csv_parser", "pdf_parser"]


class DocumentTaskCreate(StrictModel):
    requestId: UUID
    graphId: GraphId = "document_parser"
    document: DocumentReference
    failurePolicy: Literal["return_partial", "review"] = "return_partial"
    parentThreadId: UUID | None = None

    @model_validator(mode="after")
    def validate_document(self) -> Self:
        DocumentParseInput(document=self.document)
        return self


class DocumentTaskControl(StrictModel):
    requestId: UUID
    action: Literal["pause", "interrupt", "resume", "retry_failed", "accept_partial"]
    runId: UUID | None = None
    checkpointId: str | None = Field(default=None, min_length=1, max_length=128)
    units: list[FailedUnit] = Field(default_factory=list, max_length=2_000)

    @model_validator(mode="after")
    def validate_target(self) -> Self:
        if self.action in {"pause", "interrupt"}:
            if self.runId is None or self.checkpointId is not None:
                raise ValueError("pause/interrupt require runId and no checkpointId")
        elif self.checkpointId is None or self.runId is not None:
            raise ValueError("resume/retry/accept require checkpointId and no runId")
        if self.units and self.action != "retry_failed":
            raise ValueError("units are only accepted for retry_failed")
        return self


DocumentParseInput.model_rebuild()
