"""Conservative fidelity checks against immutable Tencent reading-order evidence."""

import re
from collections import Counter

from practiq_ai.contracts import ParsedGroup, ParsedQuestion
from practiq_ai.tencent_bundle import evidence_text
from practiq_ai.unit_results import missing_formulas, rendered_text

from .answer_evidence import _records
from .chunking import _UNNUMBERED_EXERCISE
from .source_context import ANSWER_HEADING, NUMBER


def _formula_source(text: str, questions: list[ParsedQuestion]) -> tuple[str, str]:
    if not text:
        return '', ''
    heading = ANSWER_HEADING.search(text)
    source = text[:heading.start()] if heading else text
    numbers = {question.id.rsplit(':', 1)[-1] for question in questions if question.id}
    first = next((match.start() for match in NUMBER.finditer(source) if match[1] in numbers), None)
    starts = [] if first is None else [first]
    if 0 not in starts:
        for question in questions:
            if question.stem and (position := source.find(question.stem)) >= 0 and source.find(question.stem, position + 1) < 0:
                starts.append(position)
    start = min(starts, default=len(source))
    prefix, source = source[:start], source[start:]
    if heading is None:
        return source, prefix
    counts = Counter(NUMBER.findall(source))
    answers = _records(text[heading.end():])
    answer_counts = Counter(number for number, _ in answers)
    return '\n'.join([source, *(body for number, body in answers
                              if number in numbers and counts[number] == answer_counts[number] == 1)]), prefix


def question_issues(text: str, questions: list[ParsedQuestion], groups: list[ParsedGroup], *, native_table: bool = False,
                    figures: str = '', formula_text: str = '') -> list[str]:
    issues = []
    # Answer keys and numbered passage/item lists are not new question starts.
    heading = ANSWER_HEADING.search(text)
    source = text[:heading.start()] if heading else text
    material = '\n'.join(evidence_text(question.model_dump(include={'options', 'passage', 'items'})) for question in questions)
    material += '\n' + '\n'.join(evidence_text(block.model_dump()) for question in questions for block in question.contentBlocks
                                 if block.role in {'material', 'source_text', 'starter_text'})
    starts = [] if native_table else list(NUMBER.finditer(source))
    counts = Counter(match[1] for match in starts)
    stems = [re.sub(r'\s+', '', question.stem or '') for question in questions]
    rendered_questions = [rendered_text(question) for question in questions]
    shared_content = figures + '\n' + evidence_text([group.model_dump(include={'title', 'instructions'}) for group in groups])
    positions: dict[int, int] = {}
    by_number: dict[str, list[int]] = {}
    for index, question in enumerate(questions):
        if question.id:
            by_number.setdefault(question.id.rsplit(':', 1)[-1], []).append(index)
    for offset, match in enumerate(starts):
        end = starts[offset + 1].start() if offset + 1 < len(starts) else len(source)
        record = source[match.end():end].strip()
        first_line = record.splitlines()[0] if record else ''
        # shortcut: untyped statements need human review, extend only with proven source boundaries.
        if first_line in material:
            continue
        anchors = by_number.get(match[1], []) if counts[match[1]] == 1 else []
        line = re.sub(r'\s+', '', first_line)
        owners = anchors or [index for index, stem in enumerate(stems) if stem and stem in line]
        if not first_line or not (re.search(r'[?？]|_{2,}', first_line) or _UNNUMBERED_EXERCISE.match(first_line)):
            if len(owners) != 1:
                for question in questions:
                    question.needsReview = True
            elif owners[0] not in positions:
                positions[owners[0]] = match.start()
            continue
        if not owners:
            issues.append(f'Retain source question {match[1]}: {first_line[:200]}')
        elif len(owners) == 1:
            index = owners[0]
            if index in positions:
                issues.append(f'Retain source question {match[1]} as a separate record; repeated questions must not collapse')
            positions[index] = match.start()
            if missing_formulas(record, rendered_questions[index] + shared_content):
                issues.append(f'Retain every source formula for question {match[1]} in displayed content, not only sourceText')
    for index, question in enumerate(questions):
        if index in positions or not question.stem:
            continue
        position = source.find(question.stem)
        if position >= 0 and source.find(question.stem, position + 1) < 0:
            positions[index] = position
    if [positions[index] for index in sorted(positions)] != sorted(positions.values()):
        issues.append('Retain source reading order for questions; remap groups and figure indexes after correction')
    rendered = ' '.join(rendered_questions) + shared_content
    sources = [_formula_source(evidence, questions) for evidence in (text, formula_text)]
    if questions and any(missing_formulas(source, rendered) for source, _ in sources):
        issues.append('Retain every source formula in displayed content, not only sourceText')
    if any(missing_formulas(prefix, rendered) for _, prefix in sources):
        for question in questions:
            question.needsReview = True
    return issues
