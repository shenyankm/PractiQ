"""Bounded source context remains deterministic across dispatch modes."""
from types import SimpleNamespace
from typing import Any

import pytest

from practiq_ai.graphs import document


def test_distant_context_uses_explicit_page_references_and_unique_answer_ids():
    from practiq_ai.graphs.source_context import source_context

    def page(text):
        return {"elements": [{"text_info": {"content": text}}], "figures": []}

    pages = [page("Passage: original material"), *[page("Other material") for _ in range(4)],
             page("17. Read the material; see page 1."), page("Other material"),
             page("Answer key\n17. B")]
    plan, incomplete = source_context(pages)
    assert 0 in plan[5] and 7 in plan[5] and not incomplete
    assert len(plan[5]) <= 8
    # Reused printed IDs do not establish which section an answer key belongs to.
    pages[2] = page("17. A different question")
    plan, _ = source_context(pages)
    assert 7 not in plan[5] and 0 in plan[5]
    split_plan, split_incomplete = source_context(pages, page_references=False)
    assert 0 not in split_plan[5] and 5 in split_incomplete


def test_context_never_crosses_failed_pages_or_exceeds_its_bound():
    from practiq_ai.graphs.source_context import source_context

    pages: list[dict[str, Any]] = [{"elements": [{"text_info": {"content": "material"}}]} for _ in range(20)]
    pages[10] = {"elements": [{"text_info": {"content": "1. 见第1至9页"}}]}
    plan, incomplete = source_context(pages)
    assert len(plan[10]) == 8 and 10 in incomplete
    pages[5] = {"failed": True}
    plan, incomplete = source_context(pages)
    assert all(index > 5 for index in plan[10]) and 10 in incomplete


def test_trajectory_requires_source_link_evidence_for_distant_context():
    from scripts.evaluate import score_trajectory

    case = {"sourceType": "pdf", "expectedProcess": {}}
    event = {"event": "page_context", "primaryPage": 5, "contextPages": [0, 3, 4, 5, 6, 9]}
    assert not score_trajectory(case, [event], [], 8)["passed"]
    assert score_trajectory(case, [{**event, "sourceLinkedPages": [0, 9]}], [], 8)["passed"]
    oversized = {**event, "contextPages": list(range(10)), "sourceLinkedPages": list(range(10))}
    assert not score_trajectory(case, [oversized], [], 8)["passed"]


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
