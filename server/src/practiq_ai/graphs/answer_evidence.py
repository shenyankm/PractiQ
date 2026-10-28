"""Conservative source proofs for extracted answers, never question solving."""

import json
import re

from ..contracts import ParsedQuestion, question_missing_fields
from .chunking import (
    _INLINE_LOCAL_FIELD,
    _QUESTION_LABELS,
    QUESTION_BOUNDARY_PATTERN,
    _reference_supplied,
)

_ANSWER = re.compile(r'^(?:(?:reference|supplied|correct|standard|model)\s+)?answers?$|^(?:参考|正确|标准)?答案$', re.IGNORECASE)
_ANALYSIS = re.compile(r'^(?:supplied\s+)?(?:explanation|analysis|solution)$|^(?:答案解析|解析|解答|分析)$', re.IGNORECASE)
_KEY = re.compile(r'^\s*(?:#{1,6}\s*)?(?:Answers?|Answer key|参考答案|标准答案|答案)\s*[:：]?\s*$', re.IGNORECASE | re.MULTILINE)
_TYPE = re.compile(r'^\s*(?:' + '|'.join(map(re.escape, _QUESTION_LABELS)) + r')\s*[:：]\s*', re.IGNORECASE)


def _literal(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip()


def _table_records(text: str) -> list[tuple[str | None, str]] | None:
    rows = [line.split('\t') for line in text.splitlines() if line.strip()]
    if not rows or len(rows[0]) < 2 or any(len(row) != len(rows[0]) for row in rows):
        return None
    headers = [cell.strip().casefold() for cell in rows[0]]
    stems = [index for index, name in enumerate(headers) if name in {'stem', 'question', '题干', '題幹', '题目', '題目'}]
    if len(stems) != 1 or len(set(headers)) != len(headers):
        return None
    records = []
    for row in rows[1:]:
        cells = dict(zip(headers, row, strict=True))
        record = row[stems[0]]
        if prefix := QUESTION_BOUNDARY_PATTERN.match(record):
            record = record[prefix.end():]
        record = _TYPE.sub('', record)
        for name, value in cells.items():
            label = name.replace('_', ' ')
            if (_ANSWER.fullmatch(label) or _ANALYSIS.fullmatch(label)) and (
                not _ANSWER.fullmatch(label) or cells.get('answer_status', 'supplied') == 'supplied'
            ):
                record += f'\n{label}: {value}'
        if cells.get('evidence'):
            try:
                evidence = json.loads(cells['evidence'])
                if isinstance(evidence, dict) and isinstance(evidence.get('analysis'), str):
                    record += '\nAnalysis: ' + evidence['analysis']
            except (ValueError, RecursionError):
                pass
        records.append((cells.get('id'), record))
    return records


def _records(text: str) -> list[tuple[str | None, str]]:
    table = _table_records(text)
    if table is not None:
        return table
    starts = list(QUESTION_BOUNDARY_PATTERN.finditer(text))
    records = []
    for index, match in enumerate(starts):
        number = re.search(r'\d+', match[0])
        end = starts[index + 1].start() if index + 1 < len(starts) else len(text)
        records.append((number[0] if number else None, _TYPE.sub('', text[match.end():end])))
    return records or [(None, text)]


def _fields(record: str) -> dict[str, list[str]]:
    matches = list(_INLINE_LOCAL_FIELD.finditer(record))
    fields: dict[str, list[str]] = {'answerPayload': [], 'analysis': []}
    for index, match in enumerate(matches):
        label = match[0][:-1].strip()
        name = 'answerPayload' if _ANSWER.fullmatch(label) else 'analysis' if _ANALYSIS.fullmatch(label) else None
        if name:
            value = record[match.end():matches[index + 1].start() if index + 1 < len(matches) else len(record)].strip()
            if value:
                fields[name].append(value)
    return fields


def _answer_matches(question: ParsedQuestion, printed: str) -> bool:
    if question.answerPayload is None:
        return True
    if question.answerMode in {'choice', 'true_false'}:
        printed = re.sub(r'[.。．]$', '', printed.strip()).rstrip()
    try:
        supplied = _reference_supplied(printed)
    except RecursionError:
        return False
    if not supplied:
        return False
    payload = question.model_dump(include={'answerPayload'})['answerPayload']
    try:
        decoded = json.loads(printed)
    except (ValueError, RecursionError):
        decoded = printed
    # JSON forms preserve pair identities, ordering and false/zero distinctions.
    if isinstance(decoded, dict):
        return json.dumps(decoded, sort_keys=True) == json.dumps(payload, sort_keys=True)
    if question.answerMode == 'true_false':
        aliases = {True: {'true', '正确', '对', '是', '√', '✓'}, False: {'false', '错误', '错', '否', '×', '✗'}}
        return isinstance(payload.get('value'), bool) and printed.strip().casefold() in aliases[payload['value']]
    if question.answerMode == 'choice':
        labels = decoded if isinstance(decoded, list) else re.split(r'[\s,，、;；]+', str(decoded).strip())
        if labels == payload.get('correct'):
            return True
        if len(labels) == 1 and isinstance(labels[0], str) and re.fullmatch(r'[A-Z]+', labels[0]):
            labels = list(labels[0])
        expected = payload.get('correct')
        return isinstance(expected, list) and all(isinstance(label, str) for label in [*labels, *expected]) and {
            label.casefold() for label in labels
        } == {label.casefold() for label in expected}
    if question.answerMode == 'short_answer':
        value = decoded if isinstance(decoded, str) else printed
        return isinstance(payload.get('text'), str) and isinstance(decoded, (str, int, float)) and _literal(value) == _literal(payload['text'])
    if question.answerMode == 'fill_blank':
        answers = decoded if isinstance(decoded, list) else [decoded if isinstance(decoded, str) else printed]
        expected = payload.get('answers')
        return isinstance(expected, list) and all(isinstance(item, str) for item in [*answers, *expected]) and [_literal(item) for item in answers] == [_literal(item) for item in expected]
    if question.answerMode == 'ordering':
        return isinstance(decoded, list) and json.dumps(decoded) == json.dumps(payload.get('order'))
    if question.answerMode == 'matching':
        return isinstance(decoded, list) and json.dumps(decoded, sort_keys=True) == json.dumps(payload.get('matches'), sort_keys=True)
    return False


def retain_source_answers(
    questions: list[ParsedQuestion], primary: str, contexts: list[str],
) -> list[tuple[int, list[str]]]:
    """Clear fields without a literal, question-scoped proof in trusted input.

    shortcut: unfamiliar answer layouts are retained only in source evidence for
    review; extend proofs when a real source format supplies an unambiguous link.
    """
    primary_key = _KEY.search(primary)
    records = [(number, record, _literal(_INLINE_LOCAL_FIELD.split(record, maxsplit=1)[0]))
               for number, record in _records(primary[:primary_key.start()] if primary_key else primary)]
    source_numbers = []
    answer_keys: dict[str, list[str]] = {}
    for text in [primary, *contexts]:
        headings = list(_KEY.finditer(text))
        source_numbers.extend(number for number, _ in _records(text[:headings[0].start()] if headings else text) if number)
        if len(headings) == 1:
            for number, body in _records(text[headings[0].end():]):
                if number:
                    answer_keys.setdefault(number, []).append(body)
    changes = []
    for index, question in enumerate(questions):
        if question.answerPayload is None and question.analysis is None:
            continue
        stem = _literal(question.stem or '')
        pattern = re.compile(r'(?<![\w-])' + re.escape(stem) + r'(?![\w-])') if stem else None
        candidates = [(number, record) for number, record, body in records if pattern and pattern.search(body)
                      and (number is not None or body == stem)]
        if len(candidates) > 1 and question.id:
            candidates = [(number, record) for number, record in candidates if number == question.id.rsplit(':', 1)[-1]]
        fields = {'answerPayload': [], 'analysis': []}
        if len(candidates) == 1:
            number, record = candidates[0]
            fields = _fields(record)
            # Only explicit answer-only sections may supply a numbered answer
            # from context. A neighboring ordinary question is never evidence.
            if number and source_numbers.count(number) == 1 and len(answer_keys.get(number, [])) == 1:
                body = answer_keys[number][0]
                marker = _INLINE_LOCAL_FIELD.search(body)
                if prefix := body[:marker.start() if marker else len(body)].strip():
                    fields['answerPayload'].append(prefix)
                for name, values in _fields(body).items():
                    fields[name].extend(values)
        removed = []
        if question.answerPayload is not None and not (fields['answerPayload'] and all(_answer_matches(question, value) for value in fields['answerPayload'])):
            question.answerPayload = None
            removed.append('answerPayload')
        if question.analysis is not None and not (fields['analysis'] and all(_literal(question.analysis) == _literal(value) for value in fields['analysis'])):
            question.analysis = None
            removed.append('analysis')
        if removed:
            question.needsReview = True
            question.missingFields = question_missing_fields(question.model_dump())
            changes.append((index, removed))
    return changes
