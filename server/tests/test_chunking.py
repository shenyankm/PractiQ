from itertools import pairwise

from practiq_ai.contracts import ParsedGroup, ParsedQuestion
from practiq_ai.graphs.chunking import merge_chunk_results, split_into_chunks


def question(stem: str) -> ParsedQuestion:
    return ParsedQuestion.model_validate(
        {
            'stem': stem,
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

    questions, groups, warnings, truncated = merge_chunk_results(
        [
            (0, [q1, q2], [group_a]),
            (1, [q2, q3], [group_b]),  # q2 是重叠区重复题
        ]
    )

    assert [q.stem for q in questions] == ['1. First', '2. Second', '3. Third']
    assert groups[0].questionIndexes == [0, 1]
    assert groups[1].questionIndexes == [1, 2]
    assert warnings == []
    assert not truncated


def test_merge_keeps_same_stem_outside_adjacent_overlap() -> None:
    repeated_a = question("1. Explain X")
    repeated_b = question("99. Explain X")

    questions, _, _, _ = merge_chunk_results(
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

    merged, groups, warnings, truncated = merge_chunk_results([(0, questions, [])])

    assert len(merged) == 1_000
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

    _, merged_groups, warnings, truncated = merge_chunk_results(
        [(0, [item], groups)]
    )

    assert len(merged_groups) == 1_000
    assert any("first 1000" in warning for warning in warnings)
    assert truncated
