"""Bounded source context remains deterministic across dispatch modes."""
from types import SimpleNamespace

import pytest

from practiq_ai.graphs import document


@pytest.mark.parametrize('index,expected', [
    (0, [0, 1]), (1, [0, 1, 2]), (2, [0, 1, 2, 3]),
    (3, [1, 2, 3, 4]), (4, [2, 3, 4]),
])
def test_context_retains_two_prior_material_pages_and_next_answer_page(monkeypatch, index, expected):
    monkeypatch.setattr(document, 'load', lambda: SimpleNamespace(graph_max_concurrency=10))
    pages = [{'objectKey': f'page-{i}'} for i in range(5)]
    state: document.DocumentState = {'pageRefs': pages, 'ocrPageRefs': [{'objectKey': f'ocr-{i}'} for i in range(5)], 'document': {'sha256': 'source', 'sourceType': 'pdf'}, 'round': 0}
    sent = document._dispatch_vision(state)
    assert isinstance(sent, list)
    task = sent[index].arg
    assert [item['index'] for item in task['neighbors']] == expected
    assert all(item['artifact'] is pages[item['index']] for item in task['neighbors'])
    assert all(item['ocrArtifact'] is state['ocrPageRefs'][item['index']] for item in task['neighbors'])
    assert task['ocrArtifact'] is state['ocrPageRefs'][index]
    assert len(task['neighbors']) <= 4
    monkeypatch.setattr(document, 'load', lambda: SimpleNamespace(graph_max_concurrency=1))
    state['visionResults'] = [{'kind': 'page', 'index': i} for i in range(index)]
    serial = document._dispatch_vision(state)
    assert isinstance(serial, list) and len(serial) == 1
    assert serial[0].arg['neighbors'] == task['neighbors']
