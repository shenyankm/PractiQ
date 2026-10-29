"""Conservative source proofs for extracted answers, never question solving."""

import json
import re

from ..contracts import ParsedItem, ParsedQuestion, question_missing_fields
from ..json_repair import unique_json_object
from .chunking import (
    _INLINE_LOCAL_FIELD,
    _PARENT_LINE,
    _QUESTION_LABELS,
    _UNNUMBERED_EXERCISE,
    QUESTION_BOUNDARY_PATTERN,
    _reference_supplied,
)

_ANSWER = re.compile(r'^(?:(?:reference|supplied|correct|standard|model)\s+)?answers?$|^answer\s+order$|^(?:参考|正确|标准)?答案$', re.IGNORECASE)
_ANALYSIS = re.compile(r'^(?:supplied\s+)?(?:explanation|analysis|solution)$|^(?:答案解析|解析|解答|分析)$', re.IGNORECASE)
_KEY = re.compile(
    r'^[^\S\r\n]*(?:#{1,6}[^\S\r\n]*)?(?:Answers?|Answer key|参考答案|标准答案|答案)'
    r'(?:[^\S\r\n]*[:：])?[^\S\r\n]*\r?$'
    r'(?=\s*\d{1,4}\s*(?:[、)]|[.．](?!\d)))',
    re.IGNORECASE | re.MULTILINE,
)
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
                evidence = json.loads(cells['evidence'], object_pairs_hook=unique_json_object)
                if isinstance(evidence, dict) and isinstance(evidence.get('analysis'), str):
                    record += '\nAnalysis: ' + evidence['analysis']
            except (ValueError, RecursionError):
                pass
        records.append((cells.get('id'), record))
    return records


def _records(text: str, *, group_items: bool = False) -> list[tuple[str | None, str]]:
    table = _table_records(text)
    if table is not None:
        return table
    starts = [match for match in QUESTION_BOUNDARY_PATTERN.finditer(text)
              if not (match[0].rstrip().endswith(('.', '．')) and text[match.end():match.end() + 1].isdigit())]
    starts = sorted([*starts, *_UNNUMBERED_EXERCISE.finditer(text)], key=lambda match: match.start())
    filtered = []
    structured = False
    begin = 0
    fields = iter(marker.start() for marker in _INLINE_LOCAL_FIELD.finditer(text)
                  if _ANSWER.fullmatch(marker[0][:-1].strip()) or _ANALYSIS.fullmatch(marker[0][:-1].strip())) if group_items else iter(())
    field = next(fields, None)
    for match in starts:
        if match.re is _UNNUMBERED_EXERCISE:
            structured = match[0].strip().casefold().startswith(('ordering', 'matching', 'paragraph matching'))
        else:
            typed = _TYPE.match(text[match.end():match.end() + 128])
            while field is not None and field < begin:
                field = next(fields, None)
            if group_items and structured and typed is None and (field is None or field >= match.start()):
                continue
            structured = bool(typed and typed[0].strip().casefold().startswith(('ordering', 'matching', 'paragraph matching')))
        filtered.append(match)
        begin = match.end()
    starts = filtered
    records = []
    for index, match in enumerate(starts):
        number = re.search(r'\d+', match[0])
        end = starts[index + 1].start() if index + 1 < len(starts) else len(text)
        records.append((number[0] if number else None, _TYPE.sub('', text[match.end():end])))
    return records or [(None, _TYPE.sub('', text))]


def _fields(record: str) -> dict[str, list[str]]:
    record = re.split(r'^[ \t]*(?:Section:[ \t]*\S|Supplemental reading(?:,[^\r\n:]*)?:)',
                      record, maxsplit=1, flags=re.IGNORECASE | re.MULTILINE)[0]
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


def _scalar_matches(printed: str, expected: str) -> bool:
    return _literal(printed) == _literal(expected) or bool(
        re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\.', printed)
        and _literal(printed[:-1]) == _literal(expected))


def _item_parts(question: ParsedQuestion) -> list[tuple[str, list[ParsedItem]]]:
    return [('Items', question.items)] if question.answerMode == 'ordering' else [
        (side.title(), [item for item in question.items if item.side == side]) for side in ('left', 'right')]


def _answer_matches(question: ParsedQuestion, printed: str, *, verified_items: bool = False) -> bool:
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
    labels = {side: {item.id if item.id is not None else index: item.label or str(item.id if item.id is not None else index)
                     for index, item in enumerate(items)} for side, items in _item_parts(question)} if verified_items else {}
    if verified_items and isinstance(decoded, (dict, list)) and any(
        label != str(identifier) for side in labels.values() for identifier, label in side.items()
    ):
        return False
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
        return isinstance(payload.get('text'), str) and isinstance(decoded, (str, int, float)) and _scalar_matches(value, payload['text'])
    if question.answerMode == 'fill_blank':
        answers = decoded if isinstance(decoded, list) else [decoded if isinstance(decoded, str) else printed]
        expected = payload.get('answers')
        return isinstance(expected, list) and len(answers) == len(expected) and all(isinstance(item, str) for item in [*answers, *expected]) and all(
            _scalar_matches(actual, supplied) for actual, supplied in zip(answers, expected, strict=True))
    if question.answerMode == 'ordering':
        if isinstance(decoded, list):
            return json.dumps(decoded) == json.dumps(payload.get('order'))
        order = payload.get('order')
        if verified_items:
            if not order or any(item not in labels['Items'] for item in order):
                return False
            order = [labels['Items'][item] for item in order]
            return re.fullmatch(r'\s*' + r'\s*,\s*'.join(map(re.escape, order)) + r'\s*[.。．]?\s*', printed) is not None
        return bool(order) and all(type(item) is int for item in order) and re.fullmatch(
            r'\s*' + r'\s*,\s*'.join(map(str, order)) + r'\s*[.。．]?\s*', printed) is not None
    if question.answerMode == 'matching':
        if isinstance(decoded, list):
            return json.dumps(decoded, sort_keys=True) == json.dumps(payload.get('matches'), sort_keys=True)
        pairs = payload.get('matches')
        if verified_items:
            if not pairs or any(not isinstance(pair, dict) or pair.get('left') not in labels['Left'] or pair.get('right') not in labels['Right'] for pair in pairs):
                return False
            entries = [(re.escape(labels['Left'][pair['left']]), re.escape(labels['Right'][pair['right']])) for pair in pairs]
            patterns = [left + r'\s*-\s*' + right if question.questionKind == 'paragraph_matching' else
                        rf'left\s+{left}\s*->\s*right\s+{right}' for left, right in entries]
            return re.fullmatch(r'\s*' + r'\s*[,，;；]\s*'.join(patterns) + r'\s*[.。．]?\s*', printed, re.IGNORECASE) is not None
        return bool(pairs) and all(isinstance(pair, dict) and type(pair.get('left')) is int and type(pair.get('right')) is int
                                   for pair in pairs) and re.fullmatch(
            r'\s*' + r'\s*;\s*'.join(rf'left\s+{pair["left"]}\s*->\s*right\s+{pair["right"]}' for pair in pairs)
            + r'\s*[.。．]?\s*', printed, re.IGNORECASE) is not None
    return False


def _unnumbered_stem_matches(question: ParsedQuestion, record: str, stem: str) -> bool:
    if question.questionKind in {'translation', 'writing'}:
        lines = _INLINE_LOCAL_FIELD.split(record, maxsplit=1)[0].strip().splitlines()
        if not lines:
            return False
        title = lines[0].strip()
        score = re.search(r'\s*\((\d+(?:\.\d+)?)\s*points?\)\s*$', title, re.IGNORECASE)
        if score:
            if float(score[1]) != question.sourceScore:
                return False
            title = title[:score.start()].rstrip()
        material = [block for block in question.contentBlocks if block.role in {'material', 'source_text', 'starter_text'}]
        return title == stem and bool(material) and all(block.partType == 'text' and block.textValue for block in material) and (
            _literal('\n'.join(lines[1:])) == _literal('\n'.join(block.textValue or '' for block in material)))
    if question.answerMode in {'ordering', 'matching'}:
        parts = _item_parts(question)
        pattern = re.escape(stem)
        paragraphs = question.questionKind == 'paragraph_matching'
        if paragraphs and question.matchingVariant == 'many_to_one':
            pattern += r'\s+Paragraphs may be used more than once\.'
        for label, items in parts:
            if not items or any(not item.content for item in items):
                return False
            ids = [item.id if item.id is not None else index for index, item in enumerate(items)]
            anchors = [item.label or str(identifier) for item, identifier in zip(items, ids, strict=True)]
            if len(set(ids)) != len(ids) or len(set(anchors)) != len(anchors):
                return False
            entries = []
            for item, anchor in zip(items, anchors, strict=True):
                entries.append(re.escape(anchor) + r'[.．、)]\s*' + re.escape(_literal(item.content or '')))
            pattern += (r'\s+' if paragraphs else rf'\s+(?i:{label}):\s*') + (
                r'\s+' if paragraphs else r'\s*;\s*').join(entries) + r'[.。．]?'
        body = _INLINE_LOCAL_FIELD.split(record, maxsplit=1)[0]
        return re.fullmatch(pattern, _literal(body)) is not None
    if question.answerMode != 'choice':
        return False
    options = {option.label.casefold(): _literal(option.content) for option in question.options if option.label and option.content}
    remaining = []
    for line in _INLINE_LOCAL_FIELD.split(record, maxsplit=1)[0].splitlines():
        match = re.fullmatch(r'\s*([^\s.．、)]+)[.．、)]\s*(.*?)\s*', line)
        if match and options.get(match[1].casefold()) == _literal(match[2]):
            continue
        remaining.append(line)
    return _literal('\n'.join(remaining)) == stem


def _composite_fields(question: ParsedQuestion, questions: list[ParsedQuestion], records: list[tuple[str | None, str, str]]) -> dict[str, list[str]] | None:
    parents = [parent for parent in questions if parent.id == question.parentId and parent.answerMode in {'word_bank', 'cloze'}]
    if len(parents) != 1 or question.answerMode != 'choice' or not question.id:
        return None
    parent = parents[0]
    blanks = [block.questionId for block in parent.passage if block.partType == 'blank']
    if blanks.count(question.id) != 1 or len(set(blanks)) != len(blanks):
        return None
    if any(block.partType not in {'text', 'blank'} for block in parent.passage):
        return None
    marker = '\ue000'
    passage = ''.join(marker if block.partType == 'blank' else block.textValue or '' for block in parent.passage)
    if marker in ''.join(block.textValue or '' for block in parent.passage):
        return None
    pattern = re.escape(_literal(passage)).replace(marker, r'\[(\d{1,4})\]')
    if not blanks or not pattern:
        return None
    children = [child for child in questions if child.parentId == parent.id]
    candidates = []
    for index, (_, record, body) in enumerate(records):
        if not parent.stem or not re.match(re.escape(_literal(parent.stem)) + r'(?![\w-])', body):
            continue
        scope = [record]
        for number, following, following_body in records[index + 1:]:
            if number is None or not any(child.stem and following_body.startswith(_literal(child.stem)) for child in children):
                break
            scope.append(following)
        record = '\n'.join(scope)
        stop = next((match.start() for match in _INLINE_LOCAL_FIELD.finditer(record)
                     if _ANSWER.fullmatch(match[0][:-1].strip()) or _ANALYSIS.fullmatch(match[0][:-1].strip())), len(record))
        source_body = _literal(record[:stop])
        matches = list(re.finditer(pattern, source_body))
        if len(matches) == 1:
            candidates.append((record, source_body, matches[0]))
    if len(candidates) != 1:
        return None
    record, body, match = candidates[0]
    numbers = match.groups()
    if len(set(numbers)) != len(numbers):
        return None
    blank_index = blanks.index(question.id)
    before = ''
    current = 0
    for block in parent.passage:
        if block.partType == 'blank':
            if current == blank_index:
                break
            current += 1
            before = ''
        else:
            before += block.textValue or ''
    clause = re.split(r'[.!?]\s+|[。！？]', before.strip())[-1].lstrip('.!?;。！？； ').strip()
    if _literal(question.stem or '') != _literal(clause):
        return None
    options = parent.options if parent.answerMode == 'word_bank' else question.options
    option_source = body[:match.start()] if parent.answerMode == 'word_bank' else body[match.end():]
    if parent.answerMode == 'cloze':
        sections = list(re.finditer(r'(?<![\w.])(\d{1,4})\s*:\s*(?=[A-Za-z][.．、)])', option_source))
        selected = [index for index, section in enumerate(sections) if section[1] == numbers[blank_index]]
        if sections:
            if len(selected) != 1 or len({section[1] for section in sections}) != len(sections) or any(section[1] not in numbers for section in sections):
                return None
            index = selected[0]
            option_source = option_source[sections[index].end():sections[index + 1].start() if index + 1 < len(sections) else len(option_source)]
        elif len(blanks) != 1:
            return None
    if parent.answerMode == 'word_bank' and question.optionSourceId != parent.id:
        return None
    option_labels = '|'.join(re.escape(option.label) for option in options if option.label)
    if not options or any(not option.label or not option.content or not re.search(
        r'(?<!\w)' + re.escape(option.label) + r'[.．、)]\s*' + re.escape(_literal(option.content))
        + rf'[.。．]?(?=\s+(?:{option_labels})[.．、)]\s|\s+Do not reuse words\.\s*$|\s*$)', option_source)
        for option in options):
        return None
    supplied = _fields(record)
    fields: dict[str, list[str]] = {'answerPayload': [], 'analysis': supplied['analysis'] if len(blanks) == 1 else []}
    for value in supplied['answerPayload']:
        if len(blanks) == 1 and _answer_matches(question, value):
            fields['answerPayload'].append(value)
        elif re.fullmatch(r'\d{1,4}\s*[-:：]?\s*[A-Za-z]+(?:\s*[;；,，]\s*\d{1,4}\s*[-:：]?\s*[A-Za-z]+)*[.。．]?', value):
            entries = re.findall(r'(\d{1,4})\s*[-:：]?\s*([A-Za-z]+)', value)
            keys = [number for number, _ in entries]
            if len(set(keys)) != len(keys) or not set(keys) <= set(numbers):
                fields['answerPayload'].append('')
            else:
                fields['answerPayload'].extend(answer for number, answer in entries if number == numbers[blank_index])
        else:
            fields['answerPayload'].append('')
    return fields


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
    item_records = [(number, record, _literal(_INLINE_LOCAL_FIELD.split(record, maxsplit=1)[0]))
                    for number, record in _records(primary[:primary_key.start()] if primary_key else primary, group_items=True)] if any(
                        question.answerMode in {'ordering', 'matching'} for question in questions) else records
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
        composite_child = question.parentId and any(parent.id == question.parentId and parent.answerMode in {'word_bank', 'cloze'} for parent in questions)
        pattern = re.compile(r'(?<![\w-])' + re.escape(stem) + r'(?![\w-])') if stem else None
        # A stem-only match cannot certify a record expanded by item grouping.
        candidates = [(number, record) for number, record, body in (item_records if question.answerMode in {'ordering', 'matching'} else records) if pattern and pattern.match(body)
                      and (body == stem and (question.answerMode not in {'ordering', 'matching'} or (number, record, body) in records)
                           or _unnumbered_stem_matches(question, record, stem)
                           or number is not None and question.answerMode not in {'ordering', 'matching'}
                           and (not composite_child or _PARENT_LINE.search(record)))]
        if len(candidates) > 1 and question.id:
            candidates = [(number, record) for number, record in candidates if number == question.id.rsplit(':', 1)[-1]]
        fields = {'answerPayload': [], 'analysis': []}
        verified_items = False
        if len(candidates) == 1:
            number, record = candidates[0]
            verified_items = question.answerMode in {'ordering', 'matching'} and _unnumbered_stem_matches(question, record, stem)
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
        elif question.parentId:
            fields = _composite_fields(question, questions, records) or fields
        removed = []
        if question.answerPayload is not None and not (fields['answerPayload'] and all(_answer_matches(question, value, verified_items=verified_items) for value in fields['answerPayload'])):
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
