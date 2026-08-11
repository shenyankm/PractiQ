from server.chunking import merge_chunk_results, split_into_chunks
from server.ai_schemas import ParsedGroup, ParsedQuestion


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
    for previous, current in zip(chunks, chunks[1:]):
        overlap_stem = current.lstrip().splitlines()[0].strip()
        assert overlap_stem in previous


def test_merge_dedupes_overlap_and_remaps_group_indexes() -> None:
    q1, q2, q3 = question('1. First'), question('2. Second'), question('3. Third')
    group_a = ParsedGroup(title='Part A', questionIndexes=[0, 1])
    group_b = ParsedGroup(title='Part B', questionIndexes=[0, 1])

    questions, groups, warnings = merge_chunk_results(
        [
            ([q1, q2], [group_a]),
            ([q2, q3], [group_b]),  # q2 是重叠区重复题
        ]
    )

    assert [q.stem for q in questions] == ['1. First', '2. Second', '3. Third']
    assert groups[0].questionIndexes == [0, 1]
    assert groups[1].questionIndexes == [1, 2]
    assert warnings == []


def test_merge_caps_questions_at_schema_limit() -> None:
    questions = [question(f'{index}. Q{index}') for index in range(1, 1_051)]

    merged, groups, warnings = merge_chunk_results([(questions, [])])

    assert len(merged) == 1_000
    assert groups == []
    assert any('first 1000' in warning for warning in warnings)
