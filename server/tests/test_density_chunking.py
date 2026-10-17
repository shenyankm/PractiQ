import asyncio
import json
import re
from typing import Any, cast

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.runtime import Runtime
from pydantic import ValidationError

from practiq_ai import execution
from practiq_ai.contracts import ArtifactReference
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import extract
from practiq_ai.extractors.csv import extract as extract_csv
from practiq_ai.extractors.isolated import _read_result, _write_result
from practiq_ai.extractors.isolated import extract as isolated_extract
from practiq_ai.graphs import document
from practiq_ai.graphs.chunking import split_chunk_plan
from tests.support import (
    FakeModel,
    MemoryStore,
    local_graph,
    question,
    run_config,
    source,
    source_presence_hints,
)


def numbered_questions(count: int) -> str:
    return '\n'.join(f'{index}. Short answer: Q{index}\nReference answer: A{index}' for index in range(1, count + 1))


def table_questions(count: int) -> str:
    return 'id\troot_task\tparent_id\toption_owner\tstem\tquestion_type\n' + '\n'.join(
        f'{index}\t{index}\t\t\tQ{index}\tShort answer' for index in range(1, count + 1)
    )


def test_short_dense_source_uses_node_budget_without_source_overlap():
    text = numbered_questions(33)
    spans, _, _ = split_chunk_plan(text)
    assert len(spans) == 3
    assert ''.join(text[item['start']:item['end']] for item in spans) == text
    assert [len(re.findall(r'^\d+\. Short answer:', text[item['start']:item['end']], re.MULTILINE)) for item in spans] == [16, 16, 1]
    assert all(item['overlapStart'] == item['overlapEnd'] == item['start'] for item in spans)


@pytest.mark.parametrize('context', ['Section: Writing', 'Directions: Write complete sentences.',
                                   'Write an essay about your hometown.', '## Writing'])
@pytest.mark.parametrize('record', [1, 17])
def test_leading_section_context_disables_density_split(context, record):
    text = re.sub(rf'^{record}\. Short answer:', f'{context}\n{record}. Short answer:',
                  numbered_questions(33), count=1, flags=re.MULTILINE)
    spans, header, counts = split_chunk_plan(text)
    assert spans == [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0}]
    assert header is None and counts == [None]


def test_parent_tree_is_not_cut_at_node_budget():
    text = numbered_questions(15) + '\n16. Word bank: Complete the passage\nMaterial: [blank:17] [blank:18]\n' + (
        '17. Single choice: First\nParent ID: 16. Shared option owner: 16.\n'
        '18. Single choice: Second\nParent ID: 16. Shared option owner: 16.'
    )
    spans, _, _ = split_chunk_plan(text)
    assert len(spans) == 2
    assert text[spans[1]['start']:].startswith('16. Word bank:')
    assert spans[0]['end'] == spans[1]['start']


async def test_csv_header_reaches_each_later_model_fragment_without_changing_artifacts(monkeypatch):
    text = table_questions(33)
    files, reference = source(text)
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    artifact = {key: value for key, value in reference.items() if key not in {'sourceType', 'fileName'}}
    prepared = await document._assemble({'document': reference, 'textRef': artifact, 'tabularRowsSafe': True})
    assert len(prepared['chunkRefs']) == 3
    assert prepared['chunkHeaders'] == [None, text.splitlines()[0], text.splitlines()[0]]
    assert prepared['chunkNodeCounts'] == [16, 16, 1]
    chunks = [(await files.get_verified(ArtifactReference.model_validate(item))).decode() for item in prepared['chunkRefs']]
    assert ''.join(chunks) == text
    work = document._dispatch_chunks(cast(Any, {'document': reference, **prepared}))
    assert isinstance(work, list)
    assert work[0].arg.get('tableHeader') is None
    assert work[1].arg['tableHeader'] == text.splitlines()[0]
    assert work[1].arg['expectedNodeCount'] == 16
    model = FakeModel(responses=[{'questions': [{**question(f'Q{index}'), 'id': f'fragment:2:{index}'} for index in range(17, 33)]}])
    monkeypatch.setattr(document, 'get_model', lambda: model)
    await document._chunk(work[1].arg, Runtime(store=MemoryStore()))
    assert model.calls[0][1].content.endswith(chunks[1])
    assert 'Column header context' in model.calls[0][1].content
    assert 'exactly 16 validated source records' in model.calls[0][1].content
    assert document.EXPECTED_NODE_COUNT.get() is None


@pytest.mark.parametrize('text', [
    '1. Short answer: Q\n1. Short answer: Duplicate ID',
    '1. Short answer: Q\nParent ID: 2.\n2. Short answer: Future parent',
    '1. Short answer: Q\n2. Short answer: Q\nParent ID: 1. Shared option owner: 3.',
    '1. Word bank: Bank\nMaterial: [blank:99]\n2. Short answer: Child\nParent ID: 1.',
    '1. Word bank: Bank\n2. Short answer: Child\nParent ID: 1.\n3. Short answer: Q\n4. Short answer: Child\nParent ID: 1.',
    '1. Reading comprehension: Passage\n2. Single choice: Implicit child',
    '1.\tReading comprehension: Passage\n2. Single choice: Implicit child',
    '1. Short answer: Q Parent ID: 2.\n2. Short answer: Q',
    '1. Short answer: Q\nParent ID: broken',
    '1. Short answer:',
    '1.\nShort answer: Q',
])
def test_unverified_layout_preserves_legacy_spans_and_disables_count_gate(text):
    spans, header, counts = split_chunk_plan(text)
    assert spans == [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0}]
    assert header is None and counts == [None]


def test_closed_tree_over_node_target_remains_whole():
    text = '1. Word bank: Bank\nMaterial: ' + ' '.join(f'[blank:{index}]' for index in range(2, 19)) + '\n'
    text += '\n'.join(f'{index}. Single choice: Q{index}\nParent ID: 1. Shared option owner: 1.' for index in range(2, 19))
    spans, header, counts = split_chunk_plan(text)
    assert len(spans) == 1 and counts == [18] and header is None
    assert spans[0]['start'] == 0 and spans[0]['end'] == len(text)
    with pytest.raises(DocumentProcessingError) as invalid:
        split_chunk_plan('1. Short answer: ' + 'x' * 40_000)
    assert invalid.value.code == 'DOCUMENT_CHUNK_TOO_LARGE'


def test_verified_table_uses_named_columns_and_keeps_additional_fields():
    header = 'stem\toption_owner\troot_task\textra\tid\tparent_id\tquestion_type'
    text = header + '\n' + '\n'.join(f'Q{index}\t\tgroup-{index}\tkeep\t{index}\t\tShort answer' for index in range(1, 18))
    spans, context, counts = split_chunk_plan(text, tabular_rows_safe=True, source_type='csv')
    assert len(spans) == 2 and counts == [16, 1] and context == header
    assert ''.join(text[item['start']:item['end']] for item in spans) == text


@pytest.mark.parametrize('rows', [
    '1\tA\t\t\tQ\n2\tB\t\t\tQ\n3\tA\t\t\tQ',
    '1\tA\t\t\tQ\n1\tA\t1\t1\tQ',
    '1\tA\t\t\tQ\n2\tB\t1\t1\tQ',
    '1\tA\t\t\tQ\n2\tA\t1\t99\tQ',
    '1\tA\t2\t\tQ\n2\tA\t1\t\tQ',
    '1\tA\t\t\tQ\n2\tA\t1\t1',
])
def test_invalid_table_tree_falls_back_without_context_or_count(rows):
    text = 'id\troot_task\tparent_id\toption_owner\tstem\n' + rows
    spans, header, counts = split_chunk_plan(text, tabular_rows_safe=True, source_type='csv')
    assert len(spans) == 1 and header is None and counts == [None]


def test_csv_reader_provenance_rejects_rectangular_rows_forged_inside_a_cell(tmp_path):
    payload = b'id,root_task,parent_id,option_owner,stem\n1,A,,,"Q1\n2\tB\t\t\tQ2"'
    extracted = extract_csv(payload)
    assert not extracted.tabular_rows_safe
    assert all(len(line.split('\t')) == 5 for line in extracted.text.splitlines())
    assert split_chunk_plan(extracted.text, source_type='csv', tabular_rows_safe=extracted.tabular_rows_safe)[2] == [None]
    _write_result(tmp_path, extracted)
    assert _read_result(tmp_path) == extracted
    safe = extract_csv(b'id,root_task,parent_id,option_owner,stem\n1,A,,,Q')
    assert safe.tabular_rows_safe
    _write_result(tmp_path, safe)
    assert _read_result(tmp_path).tabular_rows_safe
    result = json.loads((tmp_path / 'result').read_text())
    result['document']['tabular_rows_safe'] = 1
    (tmp_path / 'result').write_text(json.dumps(result))
    with pytest.raises(DocumentProcessingError):
        _read_result(tmp_path)


def test_csv_normalization_retains_empty_edge_columns():
    extracted = extract('csv', b'id,root_task,question_type,stem,parent_id,option_owner\n1,A,Short answer,Q,,')
    assert extracted.text.endswith('\t\t') and extracted.tabular_rows_safe
    assert split_chunk_plan(extracted.text, tabular_rows_safe=True, source_type='csv')[2] == [1]


async def test_isolated_csv_preserves_boundary_evidence_and_empty_columns():
    extracted = await isolated_extract('csv', b'id,root_task,question_type,stem,parent_id,option_owner\n1,A,Short answer,Q,,')
    assert extracted.tabular_rows_safe and extracted.text.endswith('\t\t')
    assert split_chunk_plan(extracted.text, tabular_rows_safe=extracted.tabular_rows_safe, source_type='csv')[2] == [1]


@pytest.mark.parametrize('label', ['Reading comprehension', 'Word bank', 'Cloze', 'Listening', 'Grammar fill', 'Sentence selection'])
def test_csv_implicit_composite_is_not_treated_as_a_closed_root(label):
    text = f'id\troot_task\tparent_id\toption_owner\tquestion_type\tstem\n1\tA\t\t\t{label}\tImplicit leaves'
    assert split_chunk_plan(text, tabular_rows_safe=True, source_type='csv')[2] == [None]


@pytest.mark.parametrize('text', [
    'id\troot_task\tparent_id\toption_owner\n1\tA\t\t',
    'id\troot_task\tparent_id\toption_owner\tstem\n1\tA\t\t\tOrdinary data',
    'id\troot_task\tparent_id\toption_owner\tquestion_type\n1\tA\t\t\tShort answer',
    'id\troot_task\tparent_id\toption_owner\tquestion_type\tstem\n1\tA\t\t\tshort_answer\tQ',
    'id\troot_task\tparent_id\toption_owner\tquestion_type\tstem\n1\tA\t\t\tUnknown\tQ',
    'id\troot_task\tparent_id\toption_owner\tquestion_type\tstem\n1\tA\t\t\tShort answer\tParent\n2\tA\t1\t\tShort answer\tChild',
    'id\troot_task\tparent_id\toption_owner\tquestion_type\tstem\n1\tA\t\t\tWord bank\tBank\n2\tA\t1\t\tSingle choice\tChild',
    'id\troot_task\tparent_id\toption_owner\tquestion_type\tstem\n1\tA\t\t\tReading comprehension\tPassage\n2\tA\t1\t1\tSingle choice\tChild',
])
def test_table_without_explicit_question_semantics_has_no_source_gates(text):
    spans, header, counts = split_chunk_plan(text, tabular_rows_safe=True, source_type='csv')
    assert spans == [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0}]
    assert header is None and counts == [None]
    assert source_presence_hints(text, source_type='csv', tabular_rows_safe=True) is None


@pytest.mark.parametrize('text', [
    '1. Short answer: Parent\n2. Single choice: Child\nParent ID: 1.',
    '1. Word bank: Bank\n2. Single choice: Child\nParent ID: 1.',
    '1. Reading comprehension: Passage\n2. Single choice: Child\nParent ID: 1. Shared option owner: 1.',
    '1. Cloze: Passage\n2. Short answer: Child\nParent ID: 1.',
    '1. Grammar fill: Passage\n2. Single choice: Child\nParent ID: 1.',
    '1. Listening: Audio\n2. Ordering: Child\nParent ID: 1.',
])
def test_explicit_but_incompatible_parent_types_disable_source_gates(text):
    assert split_chunk_plan(text)[2] == [None]
    assert source_presence_hints(text) is None


async def test_office_units_keep_headers_counts_and_offsets_sheet_scoped(monkeypatch):
    first, second = table_questions(17), table_questions(17).replace('Q', 'R')
    text = first + '\n\n' + second
    files, reference = source(text)
    artifact = {key: value for key, value in reference.items() if key not in {'sourceType', 'fileName'}}
    units = [{'start': start, 'end': start + len(content), 'fileName': f'Sheet{index}.csv',
              'sourceType': 'csv', 'sourceIndex': index, 'tabularRowsSafe': True}
             for index, (start, content) in enumerate(((0, first), (len(first) + 2, second)))]
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    result = await document._assemble({'document': reference, 'textRef': artifact, 'textUnits': units})
    assert result['chunkHeaders'] == [None, first.splitlines()[0], None, second.splitlines()[0]]
    assert result['chunkNodeCounts'] == [16, 1, 16, 1]
    assert [item['sourceIndex'] for item in result['chunkSources']] == [0, 0, 1, 1]
    assert result['chunkSpans'][2]['start'] == len(first) + 2
    contents = [(await files.get_verified(ArtifactReference.model_validate(ref))).decode() for ref in result['chunkRefs']]
    assert [text[item['start']:item['end']] for item in result['chunkSpans']] == contents


def test_incomplete_source_disables_density_and_exact_counts():
    text = numbered_questions(33)
    spans, header, counts = split_chunk_plan(text, complete=False)
    assert len(spans) == 1 and header is None and counts == [None]


@pytest.mark.parametrize('first_count', [15, 17])
async def test_missing_or_extra_record_is_corrected_with_durable_failed_usage(monkeypatch, first_count):
    text = numbered_questions(16)
    files, reference = source(text)
    model = FakeModel(responses=[{'questions': [{**question(f'Q{index}'), 'id': f'fragment:1:{index}',
                                               'answerPayload': {'text': f'A{index}'}} for index in range(1, first_count + 1)]},
                                 {'questions': [{**question(f'Q{index}'), 'id': f'fragment:1:{index}',
                                                 'answerPayload': {'text': f'A{index}'}} for index in range(1, 17)]}])
    store = MemoryStore()
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    graph = local_graph(InMemorySaver(), store=store)
    config = run_config()
    result = await graph.ainvoke({'document': reference}, config)
    assert result['status'] == 'SUCCEEDED' and len(result['result']['questions']) == 16
    assert len(model.calls) == 2
    state = (await graph.aget_state(config)).values
    assert len(state['usage']) == 2 and state['chunkNodeCounts'] == [16]
    records = await store.asearch(execution.namespace('thread-1', 'calls'))
    assert len(records) == 2 and all(item.value['durableResult'] and item.value['usageStatus'] == 'known' for item in records)
    assert {item.value['validation'] for item in records} == {'failed', 'passed'}
    assert document.EXPECTED_NODE_COUNT.get() is None


async def test_count_context_is_isolated_and_reset_after_exceptions(monkeypatch):
    files, reference = source('source')
    artifact = {key: value for key, value in reference.items() if key not in {'sourceType', 'fileName'}}
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: object())
    observed = []
    async def parse(_model, _messages, schema, _kind, **kwargs):
        before = document.EXPECTED_NODE_COUNT.get()
        await asyncio.sleep(0)
        assert document.EXPECTED_NODE_COUNT.get() == before
        observed.append(before)
        if before == 3:
            raise RuntimeError('controlled interruption')
        return schema.model_validate({'questions': [question('Q')] * (before or 1)}), [], None
    monkeypatch.setattr(document, 'structured_call', parse)
    tasks = [cast(Any, {'index': 0, 'total': 1, 'fileName': None, 'sourceType': 'text',
                       'artifact': artifact, 'expectedNodeCount': count}) for count in (2, 3)]
    outcomes = await asyncio.gather(*(document._chunk(task, Runtime()) for task in tasks), return_exceptions=True)
    assert sorted(observed) == [2, 3] and isinstance(outcomes[1], RuntimeError)
    assert document.EXPECTED_NODE_COUNT.get() is None
    assert len(document.ChunkParseResult.model_validate({'questions': [question('unknown source')]}).questions) == 1
    token = document.EXPECTED_NODE_COUNT.set(2)
    try:
        with pytest.raises(ValidationError, match='Expected exactly 2'):
            document.ChunkParseResult.model_validate({'questions': [question('Q')]})
    finally:
        document.EXPECTED_NODE_COUNT.reset(token)
