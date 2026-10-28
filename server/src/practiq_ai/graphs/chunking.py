import hashlib
import json
import re
from bisect import bisect_right
from typing import Any, NotRequired, TypedDict, cast

from pydantic import ValidationError

from ..contracts import (
    DocumentQuality,
    ParsedGroup,
    ParsedOption,
    ParsedQuestion,
    QualityIssue,
    QuestionSource,
    QuestionTreeError,
    VisualElement,
    question_missing_fields,
    validate_question_tree,
)
from ..errors import DocumentProcessingError
from ..json_repair import unique_json_object

CHUNK_TARGET_CHARS = 30_000
CHUNK_MAX_CHARS = 40_000
CHUNK_TARGET_NODES = 16
# Question and section starts: Arabic numerals or Chinese section numbers.
QUESTION_BOUNDARY_PATTERN = re.compile(
    r'^\s*(?:\d{1,4}\s*[.、)．]|[一二三四五六七八九十]{1,3}\s*[、.．])',
    re.MULTILINE,
)


class ChunkSpan(TypedDict):
    start: int
    end: int
    overlapStart: int
    overlapEnd: int


_TYPED_QUESTION = re.compile(
    r'^[ \t]*([1-9]\d{0,8})\.[ \t]+(Single choice|True or false|Multiple choice|'
    r'Fill in the blank|Short answer|Writing|Reading comprehension|Word bank|Cloze|'
    r'Ordering|Matching|Listening|Grammar fill|Sentence selection|Paragraph matching|Translation):',
    re.MULTILINE,
)
_PARENT_LINE = re.compile(r'Parent ID: ([1-9]\d{0,8})\.(?: Shared option owner: ([1-9]\d{0,8})\.)?')
_BLANK_REFERENCE = re.compile(r'\[blank:([^\]]+)\]')
_QUESTION_LABELS = {'Single choice', 'True or false', 'Multiple choice', 'Fill in the blank', 'Short answer',
                    'Writing', 'Reading comprehension', 'Word bank', 'Cloze', 'Ordering', 'Matching', 'Listening',
                    'Grammar fill', 'Sentence selection', 'Paragraph matching', 'Translation'}
_COMPOSITE_LABELS = {'Reading comprehension', 'Word bank', 'Cloze', 'Listening', 'Grammar fill', 'Sentence selection'}
_BANK_LABELS = {'Word bank', 'Sentence selection'}
_UNNUMBERED_EXERCISE = re.compile(
    r'^[ \t]*(?:' + '|'.join(sorted(_QUESTION_LABELS)) + r')[ \t]*[:—–-]',
    re.MULTILINE | re.IGNORECASE,
)


class _SourceFrame(TypedDict):
    start: int
    contentStart: int
    end: int
    id: str
    parent: str
    owner: str
    refs: set[str]
    group: str
    kind: str


def _closed_root_blocks(frames: list[_SourceFrame]) -> list[tuple[int, int, int]] | None:
    if not {frame['id'] for frame in frames if frame['kind'] in _COMPOSITE_LABELS} <= {frame['parent'] for frame in frames}:
        return None
    roots: dict[str, str] = {}
    kinds: dict[str, str] = {}
    blocks: list[tuple[int, int, int]] = []
    ids: set[str] = set()
    refs: set[str] = set()
    seen_groups: set[str] = set()
    current_root = current_group = ''
    start = end = count = 0
    for frame in frames:
        identifier, parent = frame['id'], frame['parent']
        if identifier in roots or (parent and parent not in roots):
            return None
        kind, parent_kind, owner = frame['kind'], kinds.get(parent), frame['owner']
        if parent:
            if parent_kind not in _COMPOSITE_LABELS or kind in {'Reading comprehension', 'Listening'}:
                return None
            if parent_kind in _BANK_LABELS | {'Cloze'} and kind != 'Single choice':
                return None
            if parent_kind == 'Grammar fill' and kind != 'Fill in the blank':
                return None
            if parent_kind == 'Listening' and kind not in {'Single choice', 'Multiple choice', 'Fill in the blank', 'Short answer', 'Writing', 'Translation'}:
                return None
            if parent_kind in _BANK_LABELS and owner != parent:
                return None
        if owner and (owner != parent or parent_kind not in _BANK_LABELS or kind != 'Single choice'):
            return None
        root = roots[parent] if parent else identifier
        if root != current_root:
            if parent or (current_root and not refs <= ids):
                return None
            if count:
                blocks.append((start, end, count))
            current_root, current_group = root, frame['group']
            if current_group and current_group in seen_groups:
                return None
            seen_groups.add(current_group)
            start, count, ids, refs = frame['start'], 0, set(), set()
        if frame['group'] != current_group:
            return None
        roots[identifier] = root
        kinds[identifier] = kind
        if frame['owner'] and roots.get(frame['owner']) != root:
            return None
        ids.add(identifier)
        refs.update(frame['refs'])
        end, count = frame['end'], count + 1
    if not count or not refs <= ids:
        return None
    blocks.append((start, end, count))
    return blocks


def _table_frames(text: str) -> tuple[list[_SourceFrame], str] | None:
    lines = text.splitlines(keepends=True)
    if len(lines) < 2:
        return None
    header = lines[0].rstrip('\r\n')
    columns = header.split('\t')
    required = {'id', 'root_task', 'parent_id', 'option_owner', 'question_type', 'stem'}
    if not required <= set(columns) or len(set(columns)) != len(columns):
        return None
    positions = {name: columns.index(name) for name in required}
    frames: list[_SourceFrame] = []
    offset = len(lines[0])
    for line in lines[1:]:
        cells = line.rstrip('\r\n').split('\t')
        if len(cells) != len(columns):
            return None
        values = {name: cells[index] for name, index in positions.items()}
        if not values['root_task'] or values['question_type'] not in _QUESTION_LABELS or any(
            not re.fullmatch(r'[1-9]\d{0,8}', values[name])
            for name in ('id', 'parent_id', 'option_owner') if name == 'id' or values[name]
        ):
            return None
        frames.append({'start': offset if frames else 0, 'contentStart': offset, 'end': offset + len(line),
                       'id': values['id'], 'parent': values['parent_id'], 'owner': values['option_owner'],
                       'refs': set(_BLANK_REFERENCE.findall(line)), 'group': values['root_task'],
                       'kind': values['question_type']})
        offset += len(line)
    return (frames, header) if _closed_root_blocks(frames) is not None else None


def _table_blocks(text: str) -> tuple[list[tuple[int, int, int]], str] | None:
    table = _table_frames(text)
    blocks = _closed_root_blocks(table[0]) if table else None
    return (blocks, table[1]) if table and blocks is not None else None


def _typed_frames(text: str) -> list[_SourceFrame] | None:
    matches = list(_TYPED_QUESTION.finditer(text))
    if not matches or _UNNUMBERED_EXERCISE.search(text) or any(
        QUESTION_BOUNDARY_PATTERN.match(line) and not _TYPED_QUESTION.match(line)
        for line in text.splitlines()
    ):
        return None
    frames: list[_SourceFrame] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.end():end]
        if not body.strip():
            return None
        if any(marker in body.partition('\n')[0] for marker in ('Parent ID:', 'Shared option owner:')):
            return None
        lines = [line.strip() for line in body.splitlines()[1:] if line.strip()]
        declarations = [line for line in lines if line.startswith(('Parent ID:', 'Shared option owner:'))]
        parent = _PARENT_LINE.fullmatch(lines[0]) if lines else None
        if declarations and (parent is None or len(declarations) != 1):
            return None
        frames.append({'start': match.start() if index else 0, 'contentStart': match.start(), 'end': end, 'id': match[1],
                       'parent': parent[1] if parent else '', 'owner': (parent[2] or '') if parent else '',
                       'refs': set(_BLANK_REFERENCE.findall(body)), 'group': '',
                       'kind': match[2]})
    return frames if _closed_root_blocks(frames) is not None else None


def _typed_blocks(text: str) -> list[tuple[int, int, int]] | None:
    frames = _typed_frames(text)
    # Unscoped text may introduce the following section, not belong to the previous record.
    if frames and (text[:frames[0]['contentStart']].strip() or not _record_body_scope_known(text, frames)):
        return None
    return _closed_root_blocks(frames) if frames is not None else None


class SourcePresenceHint(TypedDict):
    need_stem: bool
    need_options: bool
    need_analysis: bool
    stem_sha256: NotRequired[str]
    need_answer: NotRequired[bool]
    answer_source: NotRequired[str]


def _reference_supplied(value: str) -> bool:
    """Recognize a supplied value without constructing an answer payload."""
    value = value.strip()
    if not value or value.casefold() in {'none', 'null', 'n/a', 'unknown', 'unavailable', 'not supplied'}:
        return False
    try:
        decoded = json.loads(value, object_pairs_hook=unique_json_object)
    except (ValueError, RecursionError):
        # A malformed container or quotation is not an unambiguous answer value.
        return not value.startswith(('[', '{', '"', "'")) or (
            len(value) > 2 and value[0] == value[-1] == "'" and bool(value[1:-1].strip())
        )

    def nonempty(item: Any) -> bool:
        if item is None:
            return False
        if isinstance(item, str):
            return bool(item.strip())
        if isinstance(item, (list, dict)):
            return any(nonempty(entry) for entry in (item.values() if isinstance(item, dict) else item))
        return isinstance(item, (bool, int, float))

    try:
        return nonempty(decoded)
    except RecursionError:
        return False


def source_presence_plan(
    text: str, spans: list[ChunkSpan], *, source_type: str = 'text',
    tabular_rows_safe: bool = False, complete: bool = True,
) -> list[dict[str, SourcePresenceHint] | None]:
    """Field presence and literal stems from verified source record boundaries."""
    if not complete:
        return [None] * len(spans)
    table = _table_frames(text) if tabular_rows_safe else None
    frames = table[0] if table else _typed_frames(text) if source_type == 'text' else None
    if frames is None:
        return [None] * len(spans)
    result: dict[str, SourcePresenceHint] = {}
    body_scope_known = table is not None or _record_body_scope_known(text, frames)
    parents = {frame['parent'] for frame in frames if frame['parent']}
    choice_labels = {'Single choice', 'Multiple choice', 'Word bank', 'Sentence selection',
                     'choice', 'single_choice', 'multiple_choice', 'word_bank', 'sentence_selection'}
    for frame in frames:
        raw = text[frame['contentStart']:frame['end']].rstrip('\r\n')
        has_options = has_analysis = False
        has_answer = False
        literal_stem = body_scope_known
        if table:
            cells = dict(zip(table[1].split('\t'), raw.split('\t'), strict=True))
            stem, kind = cells.get('stem', ''), cells.get('question_type', '')
            has_answer = (cells.get('answer_status', 'supplied') == 'supplied'
                          and _reference_supplied(cells.get('reference_answer', '')))
            try:
                options = json.loads(cells.get('options', ''))
                has_options = isinstance(options, list) and bool(options) and all(
                    isinstance(option, dict) and isinstance(content := ParsedOption.model_validate(option).content, str)
                    and bool(content.strip()) for option in options
                )
            except (ValueError, ValidationError):
                pass
            try:
                evidence = json.loads(cells.get('evidence', ''))
                analysis = evidence.get('analysis') if isinstance(evidence, dict) else None
                has_analysis = isinstance(analysis, str) and bool(analysis.strip())
            except ValueError:
                pass
        else:
            match = _TYPED_QUESTION.match(raw)
            assert match is not None
            stem, kind = raw.partition('\n')[0][match.end():], match[2]
            literal_stem = (body_scope_known and not _INLINE_LOCAL_FIELD.search(stem)
                            and not any(declaration in stem for declaration in _LOCAL_DECLARATIONS))
            reference_lines = [line.strip().removeprefix('Reference answer:') for line in raw.splitlines()[1:]
                               if line.strip().startswith('Reference answer:')]
            has_answer = (literal_stem and len(reference_lines) == 1 and _reference_supplied(reference_lines[0])
                          and not any(line.strip().startswith(('Answer:', 'Supplied answer:')) for line in raw.splitlines()[1:])
                          and all(line.strip() != 'No reference answer is supplied for this question.' for line in raw.splitlines())
                          and all(line.strip() == 'Answer status: supplied' for line in raw.splitlines()
                                  if line.strip().startswith('Answer status:')))
            option_lines = list(re.finditer(r'(?m)^[ \t]*([A-Z])[.、)](?:[ \t]+([^\r\n]*))?[ \t]*$', raw))
            has_options = (len({option[1] for option in option_lines}) >= 2
                           and all((option[2] or '').strip() for option in option_lines))
            has_analysis = any(line.strip().startswith(('Supplied explanation:', 'Analysis:')) and bool(line.partition(':')[2].strip())
                               for line in raw.splitlines())
        result[frame['id']] = {'need_stem': bool(stem.strip()),
                              'need_options': has_options and kind in choice_labels and not frame['owner'],
                              'need_analysis': has_analysis,
                              'need_answer': has_answer and kind not in _COMPOSITE_LABELS and frame['id'] not in parents}
        if literal_stem and stem.strip():
            result[frame['id']]['stem_sha256'] = hashlib.sha256(stem.strip().encode('utf-8')).hexdigest()
        if has_answer and not table:
            result[frame['id']]['answer_source'] = raw
    plan = []
    for span in spans:
        selected = [frame for frame in frames if frame['end'] > span['start'] and frame['contentStart'] < span['end']]
        known = (not any(frame['contentStart'] < span['start'] or frame['end'] > span['end'] for frame in selected)
                 and _closed_root_blocks(selected) is not None)
        plan.append({frame['id']: result[frame['id']] for frame in selected} if known else None)
    return plan


def split_chunk_plan(text: str, target_chars: int = CHUNK_TARGET_CHARS, *, tabular_rows_safe: bool = False, source_type: str = 'text', complete: bool = True) -> tuple[list[ChunkSpan], str | None, list[int | None]]:
    """Keep verified trees whole; otherwise preserve legacy source spans exactly."""
    if not 0 < target_chars <= CHUNK_MAX_CHARS:
        raise ValueError("Chunk target must be within the hard input limit")
    table = _table_blocks(text) if complete and tabular_rows_safe else None
    blocks = table[0] if table is not None else _typed_blocks(text) if complete and source_type != 'csv' else None
    if blocks is None:
        spans = _legacy_split_chunk_spans(text, target_chars)
        return spans, None, [None] * len(spans)
    spans: list[ChunkSpan] = []
    node_counts: list[int | None] = []
    start = end = nodes = 0
    for block_start, block_end, block_nodes in blocks:
        header_chars = len(table[1]) + 1 if table is not None and block_start else 0
        if block_end - block_start + header_chars > CHUNK_MAX_CHARS:
            raise DocumentProcessingError(413, "A question exceeds the 40000-character fragment limit; split the source explicitly", "DOCUMENT_CHUNK_TOO_LARGE")
        context_chars = len(table[1]) + 1 if table is not None and start else 0
        if nodes and (nodes + block_nodes > CHUNK_TARGET_NODES or block_end - start + context_chars > target_chars):
            spans.append({'start': start, 'end': end, 'overlapStart': start, 'overlapEnd': start})
            node_counts.append(nodes)
            start, nodes = block_start, 0
        end, nodes = block_end, nodes + block_nodes
    spans.append({'start': start, 'end': end, 'overlapStart': start, 'overlapEnd': start})
    node_counts.append(nodes)
    return spans, table[1] if table is not None else None, node_counts


def _legacy_split_chunk_spans(text: str, target_chars: int) -> list[ChunkSpan]:
    """Persist source offsets; overlap is source identity, never a stem heuristic."""
    ranges: list[tuple[int, int]] = []
    boundaries = [match.start() for match in QUESTION_BOUNDARY_PATTERN.finditer(text)]
    if len(text) <= target_chars:
        ranges = [(0, len(text))]
    elif not boundaries:
        ranges = [(start, min(start + target_chars, len(text))) for start in range(0, len(text), target_chars)]
    else:
        if boundaries[0] != 0:
            boundaries.insert(0, 0)
        boundaries.append(len(text))
        start = previous_boundary = 0
        for boundary in boundaries[1:]:
            if boundary - start >= target_chars:
                cut = previous_boundary if previous_boundary > start else boundary
                # Keep overlap only when it fits; multiple valid questions must
                # not become an oversized fragment merely because of overlap.
                end = boundary if boundary - start <= CHUNK_MAX_CHARS else cut
                ranges.append((start, end))
                start = cut
            previous_boundary = boundary
        if start < len(text):
            ranges.append((start, len(text)))
    spans: list[ChunkSpan] = []
    for start, end in ranges:
        if end - start > CHUNK_MAX_CHARS:
            raise DocumentProcessingError(413, "A question exceeds the 40000-character fragment limit; split the source explicitly", "DOCUMENT_CHUNK_TOO_LARGE")
        if text[start:end].strip():
            spans.append({"start": start, "end": end, "overlapStart": start,
                          "overlapEnd": min(end, spans[-1]["end"]) if spans else start})
    return spans


def _normalized_source(text: str, start: int) -> tuple[str, list[int]]:
    positions = [start + index for index, char in enumerate(text) if not char.isspace()]
    return re.sub(r"\s+", "", text), positions


def _source_locations(source: tuple[str, list[int]], quote: str | None) -> list[tuple[int, int]]:
    text, positions = source
    needle = re.sub(r"\s+", "", quote or "")
    if not needle:
        return []
    locations = []
    offset = text.find(needle)
    # Two matches suffice to prove ambiguity; do not scan repeated boilerplate.
    while offset >= 0 and len(locations) < 2:
        locations.append((positions[offset], positions[offset + len(needle) - 1] + 1))
        if len(locations) == 2:
            break
        offset = text.find(needle, offset + 1)
    return locations


def _content(question: ParsedQuestion) -> dict[str, Any]:
    # Compare built-in type labels as metadata; retain original values in results.
    content = question.model_dump(exclude={"confidence", "needsReview", "missingFields", "sourceText", "id"})
    if question.questionTypeId in {question.answerMode, question.questionKind}:
        content["questionTypeId"] = None
    return content


def _group_source_location(source: tuple[str, list[int]], group: ParsedGroup) -> tuple[int, int] | None:
    locations = [_source_locations(source, quote) for quote in (group.title, group.instructions) if quote]
    if any(len(matches) != 1 for matches in locations):
        return None
    return min(matches[0][0] for matches in locations), max(matches[0][1] for matches in locations)


def merge_chunk_results(
    chunk_results: list[tuple[int, list[ParsedQuestion], list[ParsedGroup]]],
    *,
    overlapping: bool = True,
    source_text: str | None = None,
    chunk_spans: list[ChunkSpan] | None = None,
) -> tuple[list[ParsedQuestion], list[ParsedGroup], list[str], bool, list[QuestionSource], DocumentQuality]:
    """Merge only proven source overlap; retain ambiguous or conflicting extracts."""
    warnings: list[str] = []
    questions: list[ParsedQuestion] = []
    groups: list[ParsedGroup] = []
    sources: list[QuestionSource] = []
    issues: set[tuple[int, str]] = set()
    previous: list[tuple[int, tuple[int, int] | None, dict[str, Any]]] = []
    previous_chunk_index: int | None = None
    previous_groups: list[tuple[int, tuple[int, int] | None]] = []

    for chunk_index, chunk_questions, chunk_groups in chunk_results:
        span = chunk_spans[chunk_index] if chunk_spans is not None else None
        source = _normalized_source(source_text[span["start"]:span["end"]], span["start"]) if source_text is not None and span else None
        adjacent = previous_chunk_index is not None and chunk_index == previous_chunk_index + 1
        index_map: dict[int, int] = {}
        current = []
        used_previous: set[int] = set()
        previous_by_location: dict[tuple[int, int] | None, list[tuple[int, tuple[int, int] | None, dict[str, Any]]]] = {}
        for entry in previous:
            previous_by_location.setdefault(entry[1], []).append(entry)
        for local_index, original in enumerate(chunk_questions):
            question = original.model_copy(deep=True)
            locations = _source_locations(source, question.sourceText) if source else []
            location = locations[0] if len(locations) == 1 else None
            content = _content(question) if overlapping else {}
            codes: set[str] = set()
            if overlapping and not locations:
                codes.add("SOURCE_TEXT_NOT_FOUND")
            if overlapping and len(locations) > 1:
                codes.add("AMBIGUOUS_OVERLAP")
            candidates = []
            if overlapping and adjacent and span and span["overlapEnd"] > span["overlapStart"]:
                # Unlocated source fragments must still participate in ambiguity checks.
                prior_entries = previous if location is None else [*previous_by_location.get(location, []), *previous_by_location.get(None, [])]
                for prior_index, prior_location, prior_content in prior_entries:
                    if location and prior_location == location and span["overlapStart"] <= location[0] < location[1] <= span["overlapEnd"]:
                        if prior_content == content:
                            candidates.append(prior_index)
                        else:
                            codes.add("OVERLAP_CONFLICT")
                            issues.add((prior_index, "OVERLAP_CONFLICT"))
                    elif (location is None or prior_location is None) and prior_content == content:
                        codes.add("AMBIGUOUS_OVERLAP")
                        issues.add((prior_index, "AMBIGUOUS_OVERLAP"))
            if len(candidates) == 1 and candidates[0] not in used_previous and not codes:
                final_index = candidates[0]
                used_previous.add(final_index)
                questions[final_index].needsReview |= question.needsReview
                questions[final_index].missingFields = list(dict.fromkeys([*questions[final_index].missingFields, *question.missingFields]))
                questions[final_index].confidence = min(questions[final_index].confidence, question.confidence)
            else:
                if candidates:
                    codes.add("AMBIGUOUS_OVERLAP")
                    issues.update((index, "AMBIGUOUS_OVERLAP") for index in candidates)
                final_index = len(questions)
                questions.append(question)
            index_map[local_index] = final_index
            current.append((final_index, location, content))
            issues.update((final_index, code) for code in codes)
            sources.append(QuestionSource(questionIndex=final_index, stage="document_parse" if overlapping else "vision_parse", unitIndex=chunk_index))
        current_groups = []
        for group in chunk_groups:
            remapped = sorted({index_map[index] for index in group.questionIndexes if index in index_map})
            group_location = _group_source_location(source, group) if overlapping and source else None
            if remapped or not group.questionIndexes:
                matches = [index for index, prior_location in previous_groups if adjacent
                           and groups[index].title == group.title and groups[index].instructions == group.instructions
                           and (used_previous.intersection(remapped, groups[index].questionIndexes)
                                or (overlapping and span and group_location and group_location == prior_location
                                    and (not remapped or not groups[index].questionIndexes)
                                    and span["overlapStart"] <= group_location[0] < group_location[1] <= span["overlapEnd"]))]
                if len(matches) == 1:
                    index = matches[0]
                    groups[index] = groups[index].model_copy(update={"questionIndexes": sorted(set(groups[index].questionIndexes) | set(remapped))})
                else:
                    index = len(groups)
                    groups.append(group.model_copy(update={"questionIndexes": remapped}))
                current_groups.append((index, group_location))
        previous_groups = current_groups
        previous_chunk_index, previous = chunk_index, current

    truncated = len(questions) > 1_000
    if truncated:
        warnings.append(
            f'Parsed {len(questions)} questions; only the first 1000 were kept.'
        )
        # A boundary may not retain half an article or its gap children.
        by_id = {q.id: q for q in questions if q.id}
        roots = []
        for index, question in enumerate(questions):
            seen = set()
            while question.parentId in by_id and question.parentId not in seen:
                seen.add(question.parentId)
                question = by_id[question.parentId]
            roots.append(question.id or f"unidentified:{index}")
        crossing = set(roots[:1_000]) & set(roots[1_000:])
        cutoff = min((i for i, root in enumerate(roots[:1_000]) if root in crossing), default=1_000)
        warnings[-1] = f"Parsed {len(questions)} nodes; retained {cutoff} nodes without splitting a question group."
        kept = set(range(cutoff))
        questions = questions[:cutoff]
        groups = [
            group.model_copy(
                update={
                    'questionIndexes': [i for i in group.questionIndexes if i in kept]
                }
            )
            for group in groups
            if not group.questionIndexes or kept.intersection(group.questionIndexes)
        ]
    if len(groups) > 1_000:
        warnings.append(
            f"Merged {len(groups)} groups; only the first 1000 were kept."
        )
        groups = groups[:1_000]
        truncated = True
    for index, _ in issues:
        if index < len(questions):
            questions[index].needsReview = True
    for index, question in enumerate(questions):
        if question.missingFields:
            issues.add((index, "MISSING_FIELDS"))
        elif question.needsReview:
            issues.add((index, "NEEDS_REVIEW"))
    review_count = sum(question.needsReview for question in questions)
    quality = DocumentQuality(
        reviewRequired=bool(review_count), reviewQuestionCount=review_count,
        issues=[QualityIssue.model_validate({"questionIndex": index, "code": code})
                for index, code in sorted(issues) if index < len(questions)],
    )
    sources = list({(s.questionIndex, s.stage, s.unitIndex): s for s in sources if s.questionIndex < len(questions)}.values())
    return questions, groups, warnings, truncated, sources, quality


class SourceQuestionConflict(ValueError):
    def __init__(self, message: str, question_index: int):
        super().__init__(message)
        self.question_index = question_index


class SourceEvidence(TypedDict):
    canonical_quote: Any
    full_source: Any


_LOCAL_FIELD_PREFIXES = tuple(f'{field}:' for field in (
    'Material', 'Reference answer', 'Supplied answer', 'Correct answer', 'Standard answer', 'Model answer', 'Answer',
    'Reference answers', 'Supplied answers', 'Correct answers', 'Standard answers', 'Model answers', 'Answers',
    'Answer order', 'Points', 'Score', 'Source score',
    'Rubric', 'Scoring rubric', 'Supplied explanation', 'Supplied analysis', 'Supplied solution',
    'Explanation', 'Analysis', 'Solution', 'Instructions',
    'Target language', 'Transcript', 'Play count', 'Matching policy', 'Choice variant', 'Blank count',
    'Allow reuse', 'Answer status', 'Audio status',
    'Genre', 'Minimum words', 'Maximum words', 'Source passage',
))
_INLINE_LOCAL_FIELD = re.compile(
    r'(?:' + '|'.join(re.escape(prefix[:-1]) for prefix in _LOCAL_FIELD_PREFIXES)
    + r'|(?:参考|正确|标准)?答案(?:解析)?|解析|解答|分析|评分(?:标准|细则)?)\s*[:：]', re.IGNORECASE,
)
_LOCAL_DECLARATIONS = {
    'Do not reuse options.', 'No reference answer is supplied for this question.', 'No audio file is supplied.',
}


def _record_body_scope_known(text: str, frames: list[_SourceFrame]) -> bool:
    """Eligibility only: unfamiliar body content may carry shared section context."""
    for frame in frames:
        body = text[frame['contentStart']:frame['end']].splitlines()[1:]
        for line in body:
            line = line.strip()
            if not line or line.startswith(_LOCAL_FIELD_PREFIXES) or line in _LOCAL_DECLARATIONS:
                continue
            if _PARENT_LINE.fullmatch(line):
                continue
            if (frame['kind'] in {'Single choice', 'Multiple choice', 'Word bank', 'Sentence selection'}
                    and re.fullmatch(r'[A-Z][.、)](?:[ \t]+.*)?', line)):
                continue
            if (frame['kind'] in {'Ordering', 'Matching', 'Paragraph matching'}
                    and re.fullmatch(r'Item (?:sequence|left|right) \d+ \((?:\d+|[A-Z])\):.*', line)):
                continue
            return False
    return True


def _material_references(raw: str, header: str | None) -> list[str]:
    if header is not None:
        columns = header.split('\t')
        material = raw.rstrip('\r\n').split('\t')[columns.index('material')] if 'material' in columns else ''
        return _BLANK_REFERENCE.findall(material)
    return [reference for line in raw.splitlines() if line.lstrip().startswith('Material: ')
            for reference in _BLANK_REFERENCE.findall(line)]


def _canonical_source_parts(raw: str, positions: dict[str, int], header: str | None, start: int = 0, end: int | None = None) -> list[Any]:
    """Separate proven identity slots from literal evidence; markers cannot collide."""
    end = len(raw) if end is None else end
    slots: list[tuple[int, int, str, int]] = []
    if header is not None:
        offset = 0
        for column, cell in zip(header.split('\t'), raw.split('\t'), strict=True):
            if column in {'id', 'root_task', 'parent_id', 'option_owner'} and re.fullmatch(r'[1-9]\d{0,8}', cell):
                target = 0 if column == 'root_task' else positions[cell]
                slots.append((offset, offset + len(cell), column, target))
            if column == 'material':
                slots.extend((offset + match.start(1), offset + match.end(1), 'blank', positions[match[1]])
                             for match in _BLANK_REFERENCE.finditer(cell))
            offset += len(cell) + 1
    else:
        own = _TYPED_QUESTION.match(raw)
        assert own is not None
        slots.append((*own.span(1), 'id', positions[own[1]]))
        offset = 0
        for line in raw.splitlines(keepends=True):
            stripped = line.strip()
            parent = _PARENT_LINE.fullmatch(stripped)
            if parent:
                leading = len(line) - len(line.lstrip())
                for group, kind in ((1, 'parent_id'), (2, 'option_owner')):
                    if parent[group]:
                        left, right = parent.span(group)
                        slots.append((offset + leading + left, offset + leading + right, kind, positions[parent[group]]))
            if line.lstrip().startswith('Material: '):
                slots.extend((offset + match.start(1), offset + match.end(1), 'blank', positions[match[1]])
                             for match in _BLANK_REFERENCE.finditer(line))
            offset += len(line)
    parts: list[Any] = []
    cursor = start
    for left, right, kind, target in sorted(slots):
        if start <= left and right <= end:
            parts.extend((raw[cursor:left], {'reference': kind, 'target': target}))
            cursor = right
    parts.append(raw[cursor:end])
    return parts


def build_source_evidence(
    source_text: str | None, questions: list[ParsedQuestion], sources: list[QuestionSource],
    chunk_spans: list[ChunkSpan] | None, *, text_units: list[dict[str, Any]] | None = None,
    source_type: str = 'text', tabular_rows_safe: bool = False, complete: bool = True,
) -> dict[str, SourceEvidence | None]:
    """Prove a whole source/model tree bijection before normalizing printed IDs."""
    if not complete or source_text is None or not chunk_spans:
        return {}
    layouts = []
    layout_trees: list[dict[str, set[str]]] = []
    uncertain_layouts: set[int] = set()
    for unit in text_units or [{'start': 0, 'end': len(source_text), 'sourceType': source_type,
                              'sourceIndex': 0, 'tabularRowsSafe': tabular_rows_safe}]:
        text = source_text[unit['start']:unit['end']]
        table = _table_frames(text) if unit.get('tabularRowsSafe') else None
        frames = table[0] if table else _typed_frames(text) if unit['sourceType'] != 'csv' else None
        if frames is not None:
            roots: dict[str, str] = {}
            members: dict[str, set[str]] = {}
            for frame in frames:
                root = roots[frame['parent']] if frame['parent'] else frame['id']
                roots[frame['id']] = root
                members.setdefault(root, set()).add(frame['id'])
            layout_trees.append(members)
            if table is None and not _record_body_scope_known(text, frames):
                uncertain_layouts.add(len(layouts))
            layouts.append((unit, text, frames, table[1] if table else None,
                            [unit['start'] + frame['contentStart'] for frame in frames]))
    if not layouts:
        return {}
    result: dict[str, SourceEvidence | None] = {}
    matches: dict[int, tuple[int, int, int, int]] = {}
    normalized_chunks: dict[int, tuple[str, list[int]]] = {}
    by_source: dict[int, set[int]] = {}
    for source in sources:
        if source.stage == 'document_parse':
            by_source.setdefault(source.questionIndex, set()).add(source.unitIndex)
    for index, question in enumerate(questions):
        if question.id is None:
            continue
        units = by_source.get(index, set())
        possible = [(layout_index, span) for layout_index, (unit, *_rest) in enumerate(layouts)
                    for source_index in units if 0 <= source_index < len(chunk_spans)
                    if unit['start'] <= (span := chunk_spans[source_index])['start'] < span['end'] <= unit['end']]
        if not possible:
            continue
        result[question.id] = None
        if len(units) != 1 or len(possible) != 1:
            continue
        layout_index, span = possible[0]
        if layout_index in uncertain_layouts:
            continue
        unit, text, frames, header, frame_starts = layouts[layout_index]
        source_index = next(iter(units))
        if source_index not in normalized_chunks:
            normalized_chunks[source_index] = _normalized_source(source_text[span['start']:span['end']], span['start'])
        locations = _source_locations(normalized_chunks[source_index], question.sourceText)
        if len(locations) != 1:
            continue
        left, right = locations[0]
        # Source frames are ordered and disjoint; only the frame containing the quote can match.
        frame_index = bisect_right(frame_starts, left) - 1
        if frame_index < 0:
            continue
        frame = frames[frame_index]
        own_start, frame_end = frame_starts[frame_index], unit['start'] + frame['end']
        raw = text[frame['contentStart']:frame['end']].rstrip('\r\n')
        first_line = raw.partition('\n')[0]
        anchor = _TYPED_QUESTION.match(first_line) if header is None else None
        own_offset = len(first_line) - len(first_line.lstrip())
        has_stem = bool(first_line[anchor.end():].strip()) if anchor else (
            'stem' in header.split('\t') and bool(raw.split('\t')[header.split('\t').index('stem')])
            if header else False
        )
        required_end = own_start + (len(first_line.rstrip()) if header is None else len(raw.rstrip()))
        if (has_stem and left == own_start + own_offset and right >= required_end
                and span['start'] <= own_start and frame_end <= span['end'] and right <= own_start + len(raw)):
            matches[index] = (layout_index, frame_index, left - own_start, right - own_start)
    claims: dict[tuple[int, int], list[int]] = {}
    for index, (layout_index, frame_index, *_rest) in matches.items():
        claims.setdefault((layout_index, frame_index), []).append(index)
    for indexes in claims.values():
        if len(indexes) > 1:
            for index in indexes:
                del matches[index]
    by_id = {q.id: index for index, q in enumerate(questions)}
    trees: dict[int, list[int]] = {}
    for index, question in enumerate(questions):
        root, visited = index, set()
        while questions[root].parentId:
            if root in visited or questions[root].parentId not in by_id:
                return result
            visited.add(root)
            root = by_id[questions[root].parentId]
        trees.setdefault(root, []).append(index)
    for indexes in trees.values():
        if not all(index in matches for index in indexes):
            continue
        layout_indexes = {matches[index][0] for index in indexes}
        if len(layout_indexes) != 1:
            continue
        layout_index = next(iter(layout_indexes))
        unit, text, frames, header, _ = layouts[layout_index]
        selected = [frames[matches[index][1]] for index in indexes]
        physical = {frame['id']: local for local, frame in enumerate(selected)}
        if len(physical) != len(indexes):
            continue
        source_root = selected[0]
        if source_root['parent']:
            continue
        expected = layout_trees[layout_index][source_root['id']]
        if set(physical) != expected:
            continue
        local_ids = {questions[index].id: local for local, index in enumerate(indexes)}
        proven: dict[str, SourceEvidence | None] = {}
        for index, frame in zip(indexes, selected, strict=True):
            question = questions[index]
            raw = text[frame['contentStart']:frame['end']].rstrip('\r\n')
            refs = _material_references(raw, header)
            if (physical.get(frame['parent']) != local_ids.get(question.parentId)
                    or physical.get(frame['owner']) != local_ids.get(question.optionSourceId)
                    or [physical.get(reference) for reference in refs] != [local_ids.get(block.questionId) for block in question.passage if block.questionId]):
                break
            left, right = matches[index][2:]
            prefix = text[:frames[0]['contentStart']] if header is None else header
            proven[cast(str, question.id)] = {
                'canonical_quote': _canonical_source_parts(raw, physical, header, left, right),
                'full_source': {'context': prefix, 'record': _canonical_source_parts(raw, physical, header)},
            }
        else:
            result.update(proven)
    return result


def _whole_question_trees(questions: list[ParsedQuestion]) -> list[list[int]]:
    validate_question_tree([q.model_copy(deep=True) for q in questions])
    by_id = {q.id: q for q in questions}
    trees: dict[str, list[int]] = {}
    for index, question in enumerate(questions):
        root = question
        while root.parentId:
            root = by_id[root.parentId]
        trees.setdefault(cast(str, root.id), []).append(index)
    return list(trees.values())


def find_source_duplicate_question_trees(
    questions: list[ParsedQuestion], *, source_evidence: dict[str, SourceEvidence | None] | None = None,
) -> list[list[list[str]]]:
    """Find proven original-source repeats for review, never for removal."""
    seen: dict[str, list[list[int]]] = {}
    for indexes in _whole_question_trees(questions):
        evidence = [(source_evidence or {}).get(cast(str, questions[index].id)) for index in indexes]
        if not all(proof and proof.get('full_source') for proof in evidence):
            continue
        original = [cast(SourceEvidence, proof)['full_source'] for proof in evidence]
        digest = hashlib.sha256(json.dumps(original, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
        seen.setdefault(digest, []).append(indexes)
    return [[[cast(str, questions[index].id) for index in indexes] for indexes in occurrences]
            for occurrences in seen.values() if len(occurrences) > 1]


def find_duplicate_question_trees(
    questions: list[ParsedQuestion], groups: list[ParsedGroup], visuals: list[VisualElement],
    *, source_evidence: dict[str, SourceEvidence | None] | None = None,
) -> list[list[list[str]]]:
    """Identify evidence-identical trees without changing any question or reference."""
    trees = _whole_question_trees(questions)
    tree_by_question = {index: tree for tree, indexes in enumerate(trees) for index in indexes}
    excluded: set[int] = set()
    groups_by_question: dict[int, list[ParsedGroup]] = {}
    for group in groups:
        members = set(group.questionIndexes)
        owners = {tree_by_question.get(index) for index in members}
        if len(owners) > 1 or None in owners:
            excluded.update(tree for tree in owners if tree is not None)
            if len(excluded) == len(trees):
                return []
            continue
        for index in members:
            groups_by_question.setdefault(index, []).append(group)
    visuals_by_question: dict[int, list[VisualElement]] = {}
    for visual in visuals:
        for index in set(visual.questionIndexes):
            visuals_by_question.setdefault(index, []).append(visual)
    seen: dict[str, list[list[int]]] = {}
    for tree, indexes in enumerate(trees):
        if tree in excluded:
            continue
        local_indexes = {index: position for position, index in enumerate(indexes)}
        evidence = [source_evidence.get(cast(str, questions[index].id)) for index in indexes] if source_evidence else []
        if source_evidence and any(questions[index].id in source_evidence for index in indexes):
            if not all(evidence):
                continue
        else:
            evidence = []
        local_ids = {questions[index].id: position for position, index in enumerate(indexes)}
        nodes = []
        for index in indexes:
            question = questions[index]
            node = question.model_dump(exclude={"id", "confidence", "needsReview", "missingFields"})
            # Printed question numbers locate occurrences; all other quoted evidence
            # must agree, including evidence the model omitted from business fields.
            quote = re.sub(r"^\s*\d{1,4}\s*[.、)．]\s*", "", question.sourceText or "")
            node["sourceText"] = re.sub(r"\s+", " ", quote).strip()
            if evidence:
                proof = cast(SourceEvidence, evidence[len(nodes)])
                node['sourceText'] = proof['canonical_quote']
                node['verifiedSource'] = proof['full_source']
            for field in ("parentId", "optionSourceId"):
                node[field] = local_ids.get(node[field]) if node[field] else None
            for block in node["passage"]:
                if block["questionId"]:
                    block["questionId"] = local_ids[block["questionId"]]
            node["groupEvidence"] = sorted(
                [(group.title, group.instructions, [local_indexes[member] for member in group.questionIndexes])
                 for group in groups_by_question.get(index, [])],
                key=lambda value: json.dumps(value, ensure_ascii=False),
            )
            node["visuals"] = [
                {"kind": visual.kind, "role": visual.role, "label": visual.label,
                 "description": visual.description, "extractedText": visual.extractedText,
                 "imageSha256": visual.imageRef.sha256 if visual.imageRef else None,
                 "sourceSha256": visual.sourceRef.sha256 if visual.sourceRef else None,
                 "sourceBbox": visual.bbox if visual.imageRef is None else None}
                for visual in visuals_by_question.get(index, [])
            ]
            nodes.append(node)
        digest = hashlib.sha256(json.dumps(nodes, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
        # Missing evidence cannot establish that two occurrences are the same task.
        if all(node["sourceText"] for node in nodes):
            seen.setdefault(digest, []).append(indexes)
    return [[[cast(str, questions[index].id) for index in indexes] for indexes in occurrences]
            for occurrences in seen.values() if len(occurrences) > 1]


def remove_duplicate_question_trees(questions, groups, visuals, sources, quality, candidates):
    """Apply the user's explicit opt-in to previously identified complete copies."""
    aliases = {duplicate: first for trees in candidates for copy in trees[1:]
               for first, duplicate in zip(trees[0], copy, strict=True)}
    if not aliases:
        return questions, []
    by_id = {q.id: q for q in questions}
    for duplicate, first in aliases.items():
        by_id[first].needsReview |= by_id[duplicate].needsReview
        by_id[first].confidence = min(by_id[first].confidence, by_id[duplicate].confidence)
        by_id[first].missingFields = list(dict.fromkeys([*by_id[first].missingFields, *by_id[duplicate].missingFields]))
    retained = [q for q in questions if q.id not in aliases]
    final_indexes = {q.id: index for index, q in enumerate(retained)}
    index_map = {index: final_indexes[aliases.get(q.id, q.id)] for index, q in enumerate(questions)}
    groups[:] = [group for group in groups if not group.questionIndexes
                 or any(questions[index].id not in aliases for index in group.questionIndexes)]
    for group in groups:
        group.questionIndexes = [index_map[index] for index in group.questionIndexes if questions[index].id not in aliases]
    for visual in visuals:
        visual.questionIndexes = list(dict.fromkeys(index_map[index] for index in visual.questionIndexes))
    for source in sources:
        source.questionIndex = index_map[source.questionIndex]
    sources[:] = list({(s.questionIndex, s.stage, s.unitIndex): s for s in sources}.values())
    quality.issues = [QualityIssue(questionIndex=index, code=code) for index, code in sorted(
        {(index_map[issue.questionIndex], issue.code) for issue in quality.issues})]
    validate_question_tree(retained)
    quality.reviewQuestionCount = sum(q.needsReview for q in retained)
    quality.reviewRequired = bool(quality.reviewQuestionCount)
    return retained, [f"Removed {len(aliases)} exact duplicate question nodes after explicit opt-in; retained their source associations."]


def _unresolved_blank_as_text(question: ParsedQuestion, block: Any) -> None:
    # A skipped unit may contain this blank's child. Keep its evidence as
    # noninteractive text, never invent a child. Only merged copies change;
    # retry reuses the original unit.
    block.partType = "text"
    block.questionId = None
    if not any(value and value.strip() for value in (block.textValue, block.markdownValue, block.latexValue)) and block.jsonValue is None:
        block.textValue = "[____]"
    question.needsReview = True
    question.missingFields = list(dict.fromkeys([*question.missingFields, "material"]))


def finalize_question_ids(questions, groups, visuals, sources, quality):
    """Resolve explicit source-anchored compound fragments in the merge stage only."""
    from practiq_ai.contracts import COMPOSITE_MODES

    retained = []
    anchors = {}
    index_map = {}
    anchor_units = {}
    source_units = {}
    for source in sources:
        source_units.setdefault(source.questionIndex, set()).add((source.stage, source.unitIndex))
    for index, question in enumerate(questions):
        # A compound ID emitted on consecutive pages names the same source material.
        # Ordinary repeated questions never merge on content or a printed label.
        prior = anchors.get(question.id) if question.id and question.id.startswith(("page:", "fragment:")) else None
        if prior is not None and question.answerMode in COMPOSITE_MODES:
            current_units = source_units.get(index, set())
            if not any(stage == old_stage and unit == old_unit + 1 for stage, unit in current_units for old_stage, old_unit in anchor_units.get(question.id, set())):
                raise SourceQuestionConflict("Composite continuation lacks adjacent source evidence", index)
            anchor_units[question.id] = current_units
            target = retained[prior]
            if target.answerMode != question.answerMode or target.parentId != question.parentId:
                raise SourceQuestionConflict("Conflicting composite source anchor", index)
            for field in ("passage", "transcript", "contentBlocks"):
                blocks = getattr(target, field)
                blocks.extend(block for block in getattr(question, field) if block not in blocks)
            for option in question.options:
                prior_option = next((old for old in target.options if old.label and option.label and old.label.casefold() == option.label.casefold()), None)
                if prior_option is not None:
                    if prior_option.content != option.content:
                        raise SourceQuestionConflict("Conflicting composite shared option", index)
                elif option not in target.options:
                    target.options.append(option)
            target.allowReuse |= question.allowReuse
            for field in ("questionKind", "questionTypeId", "instructions", "analysis", "scoringRubric",
                          "scoreSourceText", "sourceScore", "audioRef", "audioEndSeconds"):
                value = getattr(question, field)
                old = getattr(target, field)
                if value is not None:
                    if old is not None and old != value:
                        raise SourceQuestionConflict("Conflicting composite metadata", index)
                    setattr(target, field, value)
            for field in ("audioStartSeconds", "examPlayCount"):
                value = getattr(question, field)
                old = getattr(target, field)
                default = ParsedQuestion.model_fields[field].default
                if value != default:
                    if old != default and old != value:
                        raise SourceQuestionConflict("Conflicting composite audio metadata", index)
                    setattr(target, field, value)
            target.needsReview |= question.needsReview
            target.confidence = min(target.confidence, question.confidence)
            target.missingFields = list(dict.fromkeys([*target.missingFields, *question.missingFields]))
            try:
                retained[prior] = ParsedQuestion.model_validate(target.model_dump())
            except ValidationError as exc:
                raise SourceQuestionConflict("Composite continuation violates question constraints", index) from exc
            index_map[index] = prior
        else:
            index_map[index] = len(retained)
            if question.id:
                if question.id in anchors:
                    raise SourceQuestionConflict("Duplicate source question ID", index)
                anchors[question.id] = len(retained)
                anchor_units[question.id] = source_units.get(index, set())
            retained.append(question)
    for original_index, question in enumerate(questions):
        if question.parentId in anchors and retained[anchors[question.parentId]].answerMode not in COMPOSITE_MODES:
            raise SourceQuestionConflict("Parent source anchor must reference a composite question", original_index)
    aliases = {key: f"q{value}" for key, value in anchors.items()}
    for index, q in enumerate(retained):
        q.id = f"q{index}"
        if q.parentId:
            if q.parentId not in aliases:
                if q.optionSourceId == q.parentId:
                    q.optionSourceId = None
                q.parentId = None
                q.needsReview = True
                q.missingFields = list(dict.fromkeys([*q.missingFields, "material"]))
                q.missingFields = question_missing_fields(q.model_dump())
            else:
                q.parentId = aliases[q.parentId]
        if q.optionSourceId:
            q.optionSourceId = aliases.get(q.optionSourceId, q.optionSourceId)
        for block in q.passage:
            if block.questionId:
                if block.questionId in aliases:
                    block.questionId = aliases[block.questionId]
                else:
                    _unresolved_blank_as_text(q, block)
    by_id = {q.id: q for q in retained}

    def tree_root(qid: str) -> str:
        # A malformed ancestry is rejected by the final validation below; stop
        # walking here so a cycle cannot hang the merge.
        seen = {qid}
        while by_id[qid].parentId:
            qid = by_id[qid].parentId
            if qid in seen:
                return ""
            seen.add(qid)
        return qid

    for q in retained:
        # Reading and listening trees allow blanks without matching children, so a
        # blank left pointing outside its tree must not reach tree-scoped dedup.
        if q.answerMode in {"reading", "listening"}:
            for block in q.passage:
                if block.partType == "blank" and block.questionId and tree_root(block.questionId) != q.id:
                    _unresolved_blank_as_text(q, block)
    for obj in [*groups, *visuals]:
        obj.questionIndexes = list(dict.fromkeys(index_map[i] for i in obj.questionIndexes))
    for obj in [*sources, *quality.issues]:
        obj.questionIndex = index_map[obj.questionIndex]
    missing_indexes = {issue.questionIndex for issue in quality.issues if issue.code == "MISSING_FIELDS"}
    for index, question in enumerate(retained):
        if question.missingFields and index not in missing_indexes:
            quality.issues.append(QualityIssue(questionIndex=index, code="MISSING_FIELDS"))
    try:
        validate_question_tree(retained)
    except QuestionTreeError as exc:
        retained_index = next((i for i, q in enumerate(retained) if q.id == exc.question_id), None)
        if retained_index is None:
            raise
        # Sources already use retained indexes after continuation collapse.
        raise SourceQuestionConflict(str(exc), retained_index) from exc
    return retained
