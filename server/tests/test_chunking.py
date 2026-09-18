from itertools import pairwise

import pytest

from practiq_ai.contracts import ParsedGroup, ParsedOption, ParsedQuestion
from practiq_ai.graphs.chunking import (
    ChunkSpan,
    merge_chunk_results,
    split_chunk_spans,
    split_into_chunks,
)


def question(stem: str) -> ParsedQuestion:
    return ParsedQuestion.model_validate(
        {
            'stem': stem,
            'sourceText': stem,
            'answerMode': 'short_answer',
            'questionTypeId': 'imported-short',
            'options': [],
            'contentBlocks': [{'partType': 'text', 'textValue': stem}],
            'confidence': 0.9,
            'needsReview': False,
        }
    )


def test_split_keeps_small_text_whole_and_cuts_on_question_boundaries() -> None:
    text = '\n'.join(f'{index}. Question {index} ' + 'x' * 90 for index in range(1, 101))

    assert split_into_chunks(text) == [text]

    chunks = split_into_chunks(text, target_chars=1_000)
    assert len(chunks) > 1
    # 除首块外每块都从题号边界开始
    assert all(chunk.lstrip()[0].isdigit() for chunk in chunks[1:])
    # 相邻块重叠：上一块的最后一题也出现在下一块开头
    for previous, current in pairwise(chunks):
        overlap_stem = current.lstrip().splitlines()[0].strip()
        assert overlap_stem in previous


def test_merge_dedupes_overlap_and_remaps_group_indexes() -> None:
    q1, q2, q3 = question('1. First'), question('2. Second'), question('3. Third')
    group_a = ParsedGroup(title='Part A', questionIndexes=[0, 1])
    group_b = ParsedGroup(title='Part B', questionIndexes=[0, 1])

    questions, groups, warnings, truncated, sources, _quality = merge_chunk_results(
        [
            (0, [q1, q2], [group_a]),
            (1, [q2, q3], [group_b]),  # q2 是重叠区重复题
        ], source_text="1. First\n2. Second\n3. Third",
        chunk_spans=[{"start": 0, "end": 19, "overlapStart": 0, "overlapEnd": 0},
                     {"start": 9, "end": 27, "overlapStart": 9, "overlapEnd": 19}],
    )

    assert [q.stem for q in questions] == ['1. First', '2. Second', '3. Third']
    assert groups[0].questionIndexes == [0, 1]
    assert groups[1].questionIndexes == [1, 2]
    assert warnings == []
    assert not truncated
    assert [s.unitIndex for s in sources if s.questionIndex == 1] == [0, 1]


def test_merge_keeps_same_stem_outside_adjacent_overlap() -> None:
    repeated_a = question("1. Explain X")
    repeated_b = question("99. Explain X")

    questions, *_ = merge_chunk_results(
        [
            (0, [repeated_a], []),
            (1, [question("2. Different")], []),
            (2, [repeated_b], []),
        ]
    )

    assert [item.stem for item in questions] == [
        "1. Explain X",
        "2. Different",
        "99. Explain X",
    ]


def test_merge_caps_questions_at_schema_limit() -> None:
    questions = [question(f'{index}. Q{index}') for index in range(1, 1_051)]

    merged, groups, warnings, truncated, sources, quality = merge_chunk_results([(0, questions, [])])

    assert len(merged) == len(sources) == quality.reviewQuestionCount == 1_000
    assert groups == []
    assert any('first 1000' in warning for warning in warnings)
    assert truncated


def test_split_falls_back_to_bounded_chunks_without_question_numbers() -> None:
    text = "x" * 2_501

    chunks = split_into_chunks(text, target_chars=1_000)

    assert [len(chunk) for chunk in chunks] == [1_000, 1_000, 501]
    assert "".join(chunks) == text


def test_merge_caps_groups_at_schema_limit() -> None:
    item = question("1. Question")
    groups = [
        ParsedGroup(title=f"Group {index}", questionIndexes=[0])
        for index in range(1_001)
    ]

    _, merged_groups, warnings, truncated, _sources, _quality = merge_chunk_results(
        [(0, [item], groups)]
    )

    assert len(merged_groups) == 1_000
    assert any("first 1000" in warning for warning in warnings)
    assert truncated


def test_spans_identify_overlap_even_with_repeated_text():
    text = '\n'.join(f'{i}. Repeated content' for i in range(10))
    spans = split_chunk_spans(text, target_chars=40)
    assert [text[s['start']:s['end']] for s in spans] == split_into_chunks(text, 40)
    for previous, current in pairwise(spans):
        assert current['overlapStart'] == current['start']
        assert current['overlapEnd'] == previous['end']
    assert split_chunk_spans('   ') == []
    assert len(split_chunk_spans('long preamble\n1. Q\n2. R', 10)) > 1


@pytest.mark.parametrize('left,right', [
    ('x' * 201 + 'A', 'x' * 201 + 'B'),
    ('Record A', 'Record a'),
    ('Repeated', 'Repeated'),
])
def test_distinct_source_positions_preserve_questions(left, right):
    text = f'1. {left}\n2. {right}'
    boundary = text.index('2.')
    spans: list[ChunkSpan] = [{'start': 0, 'end': boundary, 'overlapStart': 0, 'overlapEnd': 0},
             {'start': boundary, 'end': len(text), 'overlapStart': boundary, 'overlapEnd': boundary}]
    a, b = question(left), question(right)
    a.sourceText, b.sourceText = text[:boundary], text[boundary:]
    questions, _, _, _, sources, _ = merge_chunk_results([(0, [a], []), (1, [b], [])], source_text=text, chunk_spans=spans)
    assert [q.stem for q in questions] == [left, right]
    assert [(s.questionIndex, s.unitIndex) for s in sources] == [(0, 0), (1, 1)]


@pytest.mark.parametrize('conflict', ['stem', 'options'])
def test_same_source_conflicting_content_is_kept_and_flagged(conflict):
    text = 'Select one. A. red B. blue'
    a = ParsedQuestion(stem='Select one.', answerMode='choice', choiceVariant='single', questionTypeId='choice',
                       options=[ParsedOption(label='A', content='red'), ParsedOption(label='B', content='blue')], sourceText=text)
    b = a.model_copy(deep=True)
    if conflict == 'stem':
        b.stem = 'Different extraction'
    else:
        b.options[0].content = 'green'
    spans: list[ChunkSpan] = [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0},
             {'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': len(text)}]
    questions, _, _, _, _, quality = merge_chunk_results([(0, [a], []), (1, [b], [])], source_text=text, chunk_spans=spans)
    assert len(questions) == 2 and all(q.needsReview for q in questions)
    assert {(i.questionIndex, i.code) for i in quality.issues if i.code == 'OVERLAP_CONFLICT'} == {(0, 'OVERLAP_CONFLICT'), (1, 'OVERLAP_CONFLICT')}


@pytest.mark.parametrize('quote,code', [('Repeat', 'AMBIGUOUS_OVERLAP'), ('not in source', 'SOURCE_TEXT_NOT_FOUND')])
def test_unverified_source_retains_questions(quote, code):
    text = 'Repeat Repeat'
    q = question('Repeat')
    q.sourceText = quote
    spans: list[ChunkSpan] = [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0},
             {'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': len(text)}]
    questions, _, _, _, _, quality = merge_chunk_results([(0, [q], []), (1, [q], [])], source_text=text, chunk_spans=spans)
    assert len(questions) == quality.reviewQuestionCount == 2
    assert {i.questionIndex for i in quality.issues if i.code == code} == {0, 1}


def test_whitespace_only_source_matching_and_many_to_one_ambiguity():
    text = 'First question'
    a = question(text)
    b = a.model_copy(update={'sourceText': 'First\n question'})
    spans: list[ChunkSpan] = [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0},
             {'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': len(text)}]
    result = merge_chunk_results([(0, [a], []), (1, [b], [])], source_text=text, chunk_spans=spans)
    assert len(result[0]) == 1
    result = merge_chunk_results([(0, [a, a], []), (1, [b], [])], source_text=text, chunk_spans=spans)
    assert len(result[0]) == 3
    assert sum(i.code == 'AMBIGUOUS_OVERLAP' for i in result[5].issues) == 3


def test_page_provenance_is_not_text_verification():
    q = ParsedQuestion(stem='Question', answerMode='short_answer', questionTypeId='short_answer',
                       answerPayload={'text': 'answer'}, analysis='printed analysis', sourceText='Question', needsReview=False)
    questions, _, _, _, sources, quality = merge_chunk_results([(0, [q], []), (1, [q], [])], overlapping=False)
    assert len(questions) == 2
    assert [s.stage for s in sources] == ['vision_parse', 'vision_parse']
    assert not quality.reviewRequired and not quality.issues
    q.needsReview = True
    result = merge_chunk_results([(0, [q], [])], overlapping=False)
    assert result[5].issues[0].code == 'NEEDS_REVIEW'
