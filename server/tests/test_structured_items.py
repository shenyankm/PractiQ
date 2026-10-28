"""Shared item identities and review flags; model/Tencent substitutes only."""

import io
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from zipfile import ZipFile

import pytest

from practiq_ai.bank_export import export_task_bank
from practiq_ai.contracts import (
    DocumentParseResult,
    DocumentProcessing,
    DocumentReference,
    ParsedQuestion,
)
from tests.support import run_config, setup_graph

CASES = json.loads((Path(__file__).parents[2] / "app/fixtures/structured-items.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_structured_item_completeness(case):
    question = ParsedQuestion.model_validate({
        "stem": "Use the supplied items", "questionTypeId": case["question"]["answerMode"],
        "sourceText": "Supplied items and answer", "analysis": "Supplied explanation",
        "needsReview": False, **case["question"],
    })
    assert question.missingFields == case["missingFields"]
    assert question.needsReview is bool(case["missingFields"])
    if "items" in case["question"]:
        assert question.model_dump()["items"] == [
            {"label": None, "id": None, "side": None, **item} for item in case["question"]["items"]
        ]
    assert question.model_dump()["answerPayload"] == case["question"]["answerPayload"]


async def test_duplicate_matching_ids_remain_reviewable_through_graph_and_export(monkeypatch):
    source = "Match hot with fire, and cold with ice. Right-hand choices: fire, ice. Answer: hot -> fire; cold -> ice."
    original = CASES[2]["question"]
    question = {"id": "matching-1", "stem": "Match hot and cold", "questionTypeId": "matching",
                "analysis": "hot matches fire; cold matches ice", "sourceText": source,
                "confidence": 0.95, "needsReview": False, **original}
    graph, _, files, reference, _ = setup_graph(monkeypatch, [{"questions": [question], "groups": []}], parts=[source])
    result = await graph.ainvoke({"document": reference}, run_config())
    parsed = result["result"]["questions"][0]
    assert parsed["needsReview"] is True
    assert parsed['answerPayload'] is None and parsed['analysis'] is None
    assert {"items", "answerPayload"} <= set(parsed["missingFields"])
    assert result["processing"]["quality"]["reviewRequired"] is True
    detail = SimpleNamespace(state="COMPLETED", checkpointId="synthetic", status=result["status"],
                             result=DocumentParseResult.model_validate(result["result"]),
                             processing=DocumentProcessing.model_validate(result["processing"]), fileName="items.txt")
    payload = await export_task_bank(cast(Any, detail), cast(Any, files), source=DocumentReference.model_validate(reference), title="Review items")
    with payload, ZipFile(io.BytesIO(payload.read())) as archive:
        exported = json.loads(archive.read("questions.json"))["result"]["questions"][0]
    assert exported["needsReview"] is True
    assert {"items", "answerPayload"} <= set(exported["missingFields"])
    assert exported["items"] == parsed["items"]
    assert exported["answerPayload"] is None and exported['analysis'] is None
