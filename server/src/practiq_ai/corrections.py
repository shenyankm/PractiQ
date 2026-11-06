"""Human revisions of saved results, separate from immutable model checkpoints."""

from uuid import UUID

from pydantic import ValidationError

from .contracts import (
    DocumentCorrections,
    DocumentParseResult,
    ParsedQuestion,
    validate_question_tree,
)
from .errors import DocumentProcessingError

# Provenance, resource references, IDs and question relationships are never editable.
EDITABLE_FIELDS = frozenset({'stem', 'instructions', 'questionTypeId', 'answerMode', 'choiceVariant',
                            'matchingVariant', 'blankCount', 'questionKind', 'contentBlocks', 'options', 'items', 'answerPayload', 'analysis', 'scoringRubric'})


def corrected_result(original: DocumentParseResult, corrections: DocumentCorrections,
                     revision: UUID | None = None) -> DocumentParseResult:
    result = original.model_copy(deep=True)
    found = revision is None
    for edit in corrections.edits:
        if edit.questionIndex >= len(result.questions):
            raise DocumentProcessingError(409, 'Revision no longer matches its result', 'CORRECTION_CONFLICT')
        result.questions[edit.questionIndex] = edit.question.model_copy(deep=True)
        if edit.requestId == revision:
            found = True
            break
    if not found:
        raise DocumentProcessingError(404, 'Revision not found for this checkpoint', 'CORRECTION_NOT_FOUND')
    return result


def validate_edit(original: ParsedQuestion, edited: ParsedQuestion, result: DocumentParseResult,
                  index: int) -> ParsedQuestion:
    before, after = original.model_dump(mode='json'), edited.model_dump(mode='json')
    if any(before[key] != after[key] for key in before if key not in EDITABLE_FIELDS | {'needsReview', 'missingFields'}):
        raise DocumentProcessingError(422, 'Source evidence, resources and relationships cannot be edited', 'CORRECTION_PROTECTED_FIELD')
    old_blocks, new_blocks = before['contentBlocks'], after['contentBlocks']
    if len(old_blocks) != len(new_blocks) or any(
        any(block[key] != new[key] for key in block if key not in {'textValue', 'markdownValue', 'latexValue'})
        for block, new in zip(old_blocks, new_blocks, strict=True)
    ):
        raise DocumentProcessingError(422, 'Content structure and resource data cannot be edited', 'CORRECTION_PROTECTED_FIELD')
    candidate = ParsedQuestion.model_validate({**before, **{key: after[key] for key in EDITABLE_FIELDS}, 'needsReview': True})
    result.questions[index] = candidate
    try:
        validate_question_tree(result.questions)
    except ValueError as exc:
        raise DocumentProcessingError(422, 'Correction conflicts with the question group or answer references', 'CORRECTION_INVALID') from exc
    # Revalidate the complete result, including shared-option and material constraints.
    try:
        DocumentParseResult.model_validate(result.model_dump(mode='json'))
    except ValidationError as exc:
        raise DocumentProcessingError(422, 'Correction does not satisfy the question contract', 'CORRECTION_INVALID') from exc
    return candidate
