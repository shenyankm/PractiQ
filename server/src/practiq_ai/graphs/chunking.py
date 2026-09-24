import re
from typing import Any, TypedDict

from ..contracts import (
    DocumentQuality,
    ParsedGroup,
    ParsedQuestion,
    QualityIssue,
    QuestionSource,
)
from ..errors import DocumentProcessingError

CHUNK_TARGET_CHARS = 30_000
CHUNK_MAX_CHARS = 40_000
# 题号/大题起始行模式：阿拉伯数字编号、中文大题编号
QUESTION_BOUNDARY_PATTERN = re.compile(
    r'^\s*(?:\d{1,4}\s*[.、)．]|[一二三四五六七八九十]{1,3}\s*[、.．])',
    re.MULTILINE,
)


class ChunkSpan(TypedDict):
    start: int
    end: int
    overlapStart: int
    overlapEnd: int


def split_chunk_spans(text: str, target_chars: int = CHUNK_TARGET_CHARS) -> list[ChunkSpan]:
    """Persist source offsets; overlap is source identity, never a stem heuristic."""
    if not 0 < target_chars <= CHUNK_MAX_CHARS:
        raise ValueError("Chunk target must be within the hard input limit")
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


def split_into_chunks(text: str, target_chars: int = CHUNK_TARGET_CHARS) -> list[str]:
    return [text[span["start"]:span["end"]] for span in split_chunk_spans(text, target_chars)]


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
        offset = text.find(needle, offset + 1)
    return locations


def _content(question: ParsedQuestion) -> dict[str, Any]:
    # Confidence/review flags are metadata, not extracted content.
    return question.model_dump(exclude={"confidence", "needsReview", "missingFields", "sourceText", "id"})


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
    previous_groups: list[int] = []

    for chunk_index, chunk_questions, chunk_groups in chunk_results:
        span = chunk_spans[chunk_index] if chunk_spans is not None else None
        source = _normalized_source(source_text[span["start"]:span["end"]], span["start"]) if source_text is not None and span else None
        adjacent = previous_chunk_index is not None and chunk_index == previous_chunk_index + 1
        index_map: dict[int, int] = {}
        current = []
        used_previous: set[int] = set()
        for local_index, original in enumerate(chunk_questions):
            question = original.model_copy(deep=True)
            locations = _source_locations(source, question.sourceText) if source else []
            location = locations[0] if len(locations) == 1 else None
            content = _content(question)
            codes: set[str] = set()
            if overlapping and not locations:
                codes.add("SOURCE_TEXT_NOT_FOUND")
            if overlapping and len(locations) > 1:
                codes.add("AMBIGUOUS_OVERLAP")
            candidates = []
            if overlapping and adjacent and span and span["overlapEnd"] > span["overlapStart"]:
                # ponytail: scan at most 1000 prior questions; index locations if profiling warrants it.
                for prior_index, prior_location, prior_content in previous:
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
            if remapped:
                matches = [index for index in previous_groups if adjacent
                           and groups[index].title == group.title and groups[index].instructions == group.instructions
                           and used_previous.intersection(remapped, groups[index].questionIndexes)]
                if len(matches) == 1:
                    index = matches[0]
                    groups[index] = groups[index].model_copy(update={"questionIndexes": sorted(set(groups[index].questionIndexes) | set(remapped))})
                else:
                    index = len(groups)
                    groups.append(group.model_copy(update={"questionIndexes": remapped}))
                current_groups.append(index)
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
        ]
        groups = [group for group in groups if group.questionIndexes]
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
                raise ValueError("Composite continuation lacks adjacent source evidence")
            anchor_units[question.id] = current_units
            target = retained[prior]
            if target.answerMode != question.answerMode or target.parentId != question.parentId:
                raise ValueError("Conflicting composite source anchor")
            target.passage.extend(b for b in question.passage if b not in target.passage)
            target.transcript.extend(b for b in question.transcript if b not in target.transcript)
            for field in ("questionKind", "instructions", "audioRef", "audioEndSeconds"):
                value = getattr(question, field)
                old = getattr(target, field)
                if value is not None:
                    if old is not None and old != value:
                        raise ValueError("Conflicting composite metadata")
                    setattr(target, field, value)
            for field in ("audioStartSeconds", "examPlayCount"):
                value = getattr(question, field)
                old = getattr(target, field)
                default = ParsedQuestion.model_fields[field].default
                if value != default:
                    if old != default and old != value:
                        raise ValueError("Conflicting composite audio metadata")
                    setattr(target, field, value)
            target.needsReview |= question.needsReview
            target.missingFields = list(dict.fromkeys([*target.missingFields, *question.missingFields]))
            ParsedQuestion.model_validate(target.model_dump())
            index_map[index] = prior
        else:
            index_map[index] = len(retained)
            if question.id:
                if question.id in anchors:
                    raise ValueError("Duplicate source question ID")
                anchors[question.id] = len(retained)
                anchor_units[question.id] = source_units.get(index, set())
            retained.append(question)
    aliases = {key: f"q{value}" for key, value in anchors.items()}
    for index, q in enumerate(retained):
        q.id = f"q{index}"
        if q.parentId:
            if q.parentId not in aliases:
                q.parentId = None
                q.needsReview = True
                q.missingFields = list(dict.fromkeys([*q.missingFields, "material"]))
            else:
                q.parentId = aliases[q.parentId]
        if q.optionSourceId:
            q.optionSourceId = aliases.get(q.optionSourceId, q.optionSourceId)
        for block in q.passage:
            if block.questionId:
                block.questionId = aliases.get(block.questionId, block.questionId)
    for obj in [*groups, *visuals]:
        obj.questionIndexes = list(dict.fromkeys(index_map[i] for i in obj.questionIndexes))
    for obj in [*sources, *quality.issues]:
        obj.questionIndex = index_map[obj.questionIndex]
    return retained
