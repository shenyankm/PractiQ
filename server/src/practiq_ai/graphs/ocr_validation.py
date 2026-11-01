"""Conservative fidelity checks against immutable Tencent reading-order evidence."""

import re
from collections import Counter

from practiq_ai.contracts import ParsedQuestion
from practiq_ai.tencent_bundle import evidence_text
from practiq_ai.unit_results import missing_formulas, rendered_text

from .chunking import _UNNUMBERED_EXERCISE
from .source_context import ANSWER_HEADING, NUMBER


def question_issues(text: str, questions: list[ParsedQuestion], *, native_table: bool = False,
                    figures: str = '', formulas: list[str] | None = None) -> list[str]:
    issues = []
    # Answer keys and numbered passage/item lists are not new question starts.
    heading = ANSWER_HEADING.search(text)
    source = text[:heading.start()] if heading else text
    material = '\n'.join(evidence_text(question.model_dump(include={'passage', 'items'})) for question in questions)
    material += '\n' + '\n'.join(evidence_text(block.model_dump()) for question in questions for block in question.contentBlocks
                                 if block.role in {'material', 'source_text', 'starter_text'})
    starts = [] if native_table else list(NUMBER.finditer(source))
    counts = Counter(match[1] for match in starts)
    stems = [re.sub(r'\s+', '', question.stem or '') for question in questions]
    rendered_questions = [rendered_text(question) for question in questions]
    positions: dict[int, int] = {}
    for offset, match in enumerate(starts):
        end = starts[offset + 1].start() if offset + 1 < len(starts) else len(source)
        record = source[match.end():end].strip()
        first_line = record.splitlines()[0] if record else ''
        # shortcut: untyped statements need human review, extend only with proven source boundaries.
        if first_line in material:
            continue
        anchors = [index for index, question in enumerate(questions)
                   if counts[match[1]] == 1 and question.id and question.id.rsplit(':', 1)[-1] == match[1]]
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
            if missing_formulas(record, rendered_questions[index] + figures):
                issues.append(f'Retain every source formula for question {match[1]} in displayed content, not only sourceText')
    for index, question in enumerate(questions):
        if index in positions or not question.stem:
            continue
        position = source.find(question.stem)
        if position >= 0 and source.find(question.stem, position + 1) < 0:
            positions[index] = position
    if [positions[index] for index in sorted(positions)] != sorted(positions.values()):
        issues.append('Retain source reading order for questions; remap groups and figure indexes after correction')
    rendered = ' '.join(rendered_questions) + figures
    if questions and (missing_formulas(text, rendered) or any(missing_formulas(f'$${formula}$$', rendered) for formula in formulas or [])):
        issues.append('Retain every source formula in displayed content, not only sourceText')
    return issues
