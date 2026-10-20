"""Bounded source context remains deterministic across dispatch modes."""
from types import SimpleNamespace

import pytest

from practiq_ai.graphs import document


def test_group_index_feedback_identifies_the_actual_array_bounds():
    from pydantic import ValidationError

    from tests.support import question

    with pytest.raises(ValidationError, match="0 <= index < 1"):
        document.ChunkParseResult.model_validate({"questions": [question("Printed question")],
                                                "groups": [{"title": "Printed group", "questionIndexes": [1]}]})


async def test_model_page_numbers_match_one_based_question_ids_without_rewriting_evidence(monkeypatch):
    import json

    from langgraph.runtime import Runtime

    from tests.support import FakeObjectStore, parsed

    files = FakeObjectStore({})
    evidence = {"page": 2, "elements": [], "figures": []}
    primary = await files.put_artifact(json.dumps(evidence).encode(), source_sha256="a" * 64,
                                       kind="ocr-page", index=2, media_type="application/json")
    neighbor = await files.put_artifact(json.dumps({**evidence, "page": 3}).encode(), source_sha256="a" * 64,
                                        kind="ocr-page", index=3, media_type="application/json")
    monkeypatch.setattr(document, "get_object_store", lambda: files)
    monkeypatch.setattr(document, "get_model", lambda: object())
    monkeypatch.setattr(document, "load", lambda: SimpleNamespace(import_review=False))
    calls = []

    async def call(_model, messages, schema, _kind, *, runtime):
        payload = json.loads(messages[1].content.rsplit("\n", 1)[1])
        assert payload["page"] == 3
        assert "PRIMARY is page 3" in messages[1].content
        if len(messages) == 3:
            context = json.loads(messages[-1].content.split("CONTEXT:\n")[1].split("\nPRIMARY DRAFT:")[0])
            assert [page["page"] for page in context] == [4]
        result = parsed("Question?")
        result["questions"][0]["id"] = "page:3:1"
        calls.append(messages)
        return schema.model_validate(result), [], None

    monkeypatch.setattr(document, "structured_call", call)
    result = await document._vision({"kind": "page", "index": 2, "artifact": primary.model_dump(), "ocrArtifact": primary.model_dump(),
                                    "neighbors": [{"index": 3, "ocrArtifact": neighbor.model_dump()}]}, Runtime(context=None))
    assert len(calls) == 2
    assert len(result["visionResults"][0]["parsed"]["questions"]) == 1
    assert json.loads(await files.get_verified(primary)) == evidence


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
