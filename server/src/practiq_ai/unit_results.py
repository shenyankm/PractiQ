"""Saved unit validation and verified reads, independent of graph execution."""

import json
import re
from copy import deepcopy
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .contracts import (
    COMPOSITE_MODES,
    ArtifactReference,
    ParsedGroup,
    ParsedQuestion,
    VisualElement,
    answer_source_conflict,
    question_missing_fields,
)
from .errors import DocumentProcessingError
from .extractors.isolated import _thread_io
from .storage import ObjectStore


def _rendered_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        value = list(value.values())
    return [text for item in value for text in _rendered_strings(item)] if isinstance(value, list) else []


def discard_model_audio(questions: list[ParsedQuestion]) -> None:
    # Import tasks never create audio artifacts; portable bank contracts still support them.
    for question in questions:
        if question.audioRef is not None:
            question.audioRef = None
            question.needsReview = True
            question.missingFields = question_missing_fields(question.model_dump())


class UnitParseResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    questions: list[ParsedQuestion] = Field(default_factory=list, max_length=1_000)
    groups: list[ParsedGroup] = Field(default_factory=list, max_length=1_000)

    @model_validator(mode="before")
    @classmethod
    def derive_review_labels(cls, value):
        # These flags are computed from validated fields, not source content. A model
        # naming an optional metadata field must not discard otherwise valid questions.
        if not isinstance(value, dict):
            return value
        value = deepcopy(value)
        if not isinstance(value.get("questions"), list):
            return value
        for question in value["questions"]:
            if not isinstance(question, dict):
                continue
            mode = question.get("answerMode")
            if mode in {"choice", "true_false", "fill_blank", "short_answer", "ordering", "matching", *COMPOSITE_MODES}:
                derived = []
                if mode != "fill_blank":
                    derived.append("blankCount")
                if mode not in {"choice", "word_bank"} and not question.get("options"):
                    derived.append("choiceVariant")
                for field in derived:
                    if question.get(field) is not None:
                        question[field] = None
                        question["needsReview"] = True
            flags = question.get("missingFields")
            if isinstance(flags, list) and all(isinstance(flag, str) for flag in flags):
                question["missingFields"] = [flag for flag in flags if flag in {"media", "material"}]
                if flags:
                    question["needsReview"] = True
        return value

    @model_validator(mode="after")
    def validate_group_indexes(self) -> Self:
        return self.validate_structure()

    def validate_structure(self) -> Self:
        discard_model_audio(self.questions)
        ids = [question.id for question in self.questions if question.id is not None]
        if len(ids) != len(set(ids)):
            raise ValueError("question IDs must be unique within this response")
        for question in self.questions:
            if answer_source_conflict(question.model_dump(mode='json')):
                question.needsReview = True
        if any(
            index < 0 or index >= len(self.questions)
            for group in self.groups
            for index in group.questionIndexes
        ):
            raise ValueError(f"questionIndexes must reference a fragment question: use 0 <= index < {len(self.questions)}. "
                             "Recalculate each group's offsets from the final questions array, including parent records; "
                             "do not add or remove questions to fit the indexes")
        by_id = {q.id: q for q in self.questions if q.id}
        for question in self.questions:
            parent = by_id.get(question.parentId or "")
            if parent is not None and parent.answerMode not in COMPOSITE_MODES:
                raise ValueError("parentId must reference a composite question; standalone questions have parentId=null")
            if question.answerMode != "listening":
                formulas = [formula for formula in re.findall(r"(?<!\\)\${1,2}([^$]+?)\${1,2}", question.sourceText or "")
                            if any(marker in formula for marker in (r"\begin{", r"\int", r"\sum"))]
                rendered = " ".join(_rendered_strings(question.model_dump(include={"stem", "instructions", "analysis", "scoringRubric", "answerPayload", "options", "items", "passage", "contentBlocks", "transcript"})))
                normalize = lambda text: re.sub(r"\s+|\\(?:quad|,)|[&]", "", text).replace(r"\geq", r"\ge").replace(r"\leq", r"\le")
                normalized_rendered = normalize(rendered) if formulas else ""
                for formula in formulas:
                    if normalize(formula) not in normalized_rendered:
                        question.needsReview = True
                        question.missingFields = list(dict.fromkeys([*question.missingFields, "material"]))
            # A review heuristic for new model output, not calibrated accuracy.
            if question.confidence < 0.5:
                question.needsReview = True
        return self


async def load_unit_result(item: dict[str, Any], source_sha256: str, store: ObjectStore) -> dict[str, Any]:
    if not item.get("resultRef") or item.get("parsed") is None:
        return item  # Existing checkpoints keep their inline unit records.
    try:
        reference = ArtifactReference.model_validate(item["resultRef"])
        if not reference.objectKey.startswith(f"practiq-agent/artifacts/{source_sha256}/unit-result/{item['index']}-") or reference.mediaType != "application/json":
            raise DocumentProcessingError(409, "Unit result reference is invalid", "UNIT_RESULT_INVALID")
        raw = await store.get_verified(reference)

        def decode() -> dict[str, Any]:
            payload = json.loads(raw)
            parsed = UnitParseResult.model_validate(payload["parsed"]).model_dump(mode="json")
            visuals = [VisualElement.model_validate(value).model_dump(mode="json") for value in payload.get("visuals", [])]
            return {**item, "parsed": parsed, "visuals": visuals, "agentReview": payload.get("agentReview", item.get("agentReview"))}

        return await _thread_io(decode)
    except (ValueError, KeyError, TypeError) as exc:
        raise DocumentProcessingError(409, "Stored unit result is invalid", "UNIT_RESULT_INVALID") from exc
