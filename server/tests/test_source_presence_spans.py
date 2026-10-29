import pytest

from practiq_ai.graphs.chunking import ChunkSpan, source_presence_plan, split_chunk_plan


@pytest.mark.parametrize('table', [False, True])
def test_source_presence_keeps_reordered_overlapping_and_partial_spans_conservative(table):
    text = ('id\troot_task\tparent_id\toption_owner\tquestion_type\tstem\treference_answer\n'
            + '\n'.join(f'{i}\t{i}\t\t\tShort answer\tQ{i}\tA{i}' for i in range(1, 34))
            if table else '\n'.join(f'{i}. Short answer: Q{i}\nReference answer: A{i}' for i in range(1, 34)))
    spans, _, _ = split_chunk_plan(text, source_type='csv' if table else 'text', tabular_rows_safe=table)
    reordered: list[ChunkSpan] = [spans[2], spans[0], spans[1], spans[0],
                 {**spans[0], 'end': spans[0]['end'] - 1},
                 {**spans[1], 'start': spans[1]['start'] + 1},
                 {**spans[0], 'end': spans[1]['end']}]
    plan = source_presence_plan(text, reordered, source_type='csv' if table else 'text', tabular_rows_safe=table)
    assert [list(item) if item else None for item in plan] == [
        ['33'], [str(i) for i in range(1, 17)], [str(i) for i in range(17, 33)],
        [str(i) for i in range(1, 17)], None, None, [str(i) for i in range(1, 33)],
    ]
    assert all(hint.get('need_answer') and hint.get('stem_sha256') for item in plan if item for hint in item.values())


def test_source_presence_rejects_child_without_parent_and_header_only_spans():
    text = ('id\troot_task\tparent_id\toption_owner\tquestion_type\tstem\n'
            '1\tA\t\t\tReading comprehension\tPassage\n'
            '2\tA\t1\t\tShort answer\tQuestion')
    header_end = text.index('\n') + 1
    child_start = text.rindex('\n') + 1
    spans: list[ChunkSpan] = [{'start': start, 'end': end, 'overlapStart': start, 'overlapEnd': start}
             for start, end in [(0, header_end), (child_start, len(text)), (0, len(text)),
                                (child_start, child_start), (len(text), len(text))]]
    plan = source_presence_plan(text, spans, source_type='csv', tabular_rows_safe=True)
    assert plan[:2] == [None, None]
    assert plan[2] is not None and list(plan[2]) == ['1', '2']
    assert plan[3:] == [None, None]
