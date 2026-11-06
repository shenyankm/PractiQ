"""Printed-number suggestions and explicit supplied-answer associations; no model work."""
import re

from pydantic import BaseModel

from .contracts import (
    COMPOSITE_MODES,
    DocumentAnswerMatch,
    DocumentParseResult,
    ParsedQuestion,
)
from .errors import DocumentProcessingError


def printed_number(question: ParsedQuestion) -> str | None:
    for value in (question.stem, question.sourceText):
        match = re.match(r'^\s*(?:第\s*)?(\d{1,6})(?:\s*[.．、:：)）题]|\s*$)', value or '')
        if match:
            return str(int(match[1]))
    return None


def match_answers(target: DocumentParseResult, answers: DocumentParseResult) -> list[DocumentAnswerMatch]:
    by_number: dict[str, list[int]] = {}
    counts: dict[str, int] = {}
    for question in target.questions:
        if question.answerMode in COMPOSITE_MODES:
            continue
        if (number := printed_number(question)) is not None:
            counts[number] = counts.get(number, 0) + 1
    for index, question in enumerate(answers.questions):
        if question.answerPayload is not None and (number := printed_number(question)) is not None:
            by_number.setdefault(number, []).append(index)
    matches = []
    for index, question in enumerate(target.questions):
        if question.answerMode in COMPOSITE_MODES:
            continue
        number = printed_number(question)
        candidates = by_number.get(number, []) if number is not None else []
        status = ('has_answer' if question.answerPayload is not None else 'unmatched' if not candidates else
                  'unique' if len(candidates) == 1 and number is not None and counts.get(number, 0) == 1 else 'ambiguous')
        matches.append(DocumentAnswerMatch(questionIndex=index, candidates=candidates[:2_000], status=status))
    return matches


def associated_question(target: ParsedQuestion, supplied: ParsedQuestion) -> ParsedQuestion:
    if supplied.answerPayload is None:
        raise DocumentProcessingError(422, 'The selected answer record has no supplied answer', 'ANSWER_MATCH_INVALID')
    payload = supplied.answerPayload.model_dump(mode='json') if isinstance(supplied.answerPayload, BaseModel) else supplied.answerPayload
    if isinstance(payload, dict) and isinstance(text := payload.get('text'), str):
        if target.answerMode == 'choice':
            payload = {'correct': [value for value in re.split(r'[,，、;；\s]+', text.strip()) if value]}
        elif target.answerMode == 'true_false':
            labels = {'true': True, 'false': False, '正确': True, '错误': False, '对': True, '错': False, '√': True, '×': False}
            if text.strip().lower() in labels:
                payload = {'value': labels[text.strip().lower()]}
        elif target.answerMode == 'fill_blank' and target.blankCount == 1:
            payload = {'answers': [text]}
        elif target.answerMode == 'ordering':
            values = re.split(r'[,，、;；\s]+', text.strip())
            if all(re.fullmatch(r'\d+', value) for value in values):
                payload = {'order': [int(value) for value in values]}
        elif target.answerMode == 'matching':
            pairs = [re.fullmatch(r'\s*(\d+)\s*=\s*(\d+)\s*', value) for value in re.split(r'[\n;；]+', text.strip())]
            if pairs and all(pairs):
                payload = {'matches': [{'left': int(pair[1]), 'right': int(pair[2])} for pair in pairs if pair]}
    return target.model_copy(deep=True, update={'answerPayload': payload,
        'analysis': target.analysis if target.analysis is not None else supplied.analysis,
        'scoringRubric': target.scoringRubric if target.scoringRubric is not None else supplied.scoringRubric,
        'needsReview': True})
