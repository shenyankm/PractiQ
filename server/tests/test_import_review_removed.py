"""Extraction stays bounded while historical AI review artifacts remain readable."""

import json
from copy import deepcopy
from typing import cast

import pytest
from langgraph.runtime import Runtime

from practiq_ai import execution
from practiq_ai.contracts import ArtifactReference
from practiq_ai.graphs import document
from tests.support import FakeModel, FakeObjectStore, parsed, run_config, setup_graph


@pytest.mark.parametrize("legacy_setting", ["false", "true", "invalid"])
async def test_legacy_review_setting_cannot_add_calls_or_reservations(monkeypatch, legacy_setting):
    monkeypatch.setenv("AI_IMPORT_REVIEW", legacy_setting)
    graph, _, files, reference, model = setup_graph(monkeypatch, [parsed()])
    config = run_config()
    result = await graph.ainvoke({"document": reference}, config)
    assert result["status"] == "SUCCEEDED" and len(model.calls) == 1
    assert [call["callKind"] for call in result["usage"]] == ["document_parse"]
    state = (await graph.aget_state(config)).values
    assert state["reservedCalls"] == 4
    assert "import_review" not in execution.signature()["settings"]
    unit = state["chunkResults"][0]
    payload = json.loads(await files.get_verified(ArtifactReference.model_validate(unit["resultRef"])))
    assert "agentReview" not in unit and "agentReview" not in payload


@pytest.mark.parametrize("legacy_setting", ["false", "true", "invalid"])
async def test_visual_extraction_ignores_removed_review_setting(monkeypatch, legacy_setting):
    monkeypatch.setenv("AI_IMPORT_REVIEW", legacy_setting)
    model = FakeModel(responses=[{**parsed(), "figures": []}])
    files = FakeObjectStore({})
    evidence = await files.put_artifact(json.dumps({"page": 0, "elements": [{"text_info": {"content": "First"}}],
                                                  "figures": []}).encode(),
                                        source_sha256="a" * 64, kind="ocr-page", index=0, media_type="application/json")
    monkeypatch.setattr(document, "get_model", lambda: model)
    monkeypatch.setattr(document, "get_object_store", lambda: files)
    artifact = ArtifactReference(objectKey="page.png", sha256="a" * 64, mediaType="image/png", sizeBytes=1)
    result = await document._vision({"kind": "page", "index": 0, "artifact": artifact.model_dump(mode="json"),
                                     "ocrArtifact": evidence.model_dump(mode="json")}, Runtime())
    assert len(model.calls) == 1
    assert [item["callKind"] for item in result["usage"]] == ["vision_parse"]
    assert "agentReview" not in result["visionResults"][0]


@pytest.mark.parametrize("status", ["no_discrepancy", "repaired", "repair_rejected", "unreviewed"])
async def test_historical_audit_remains_readable_without_model_calls(monkeypatch, status):
    graph, _, files, reference, model = setup_graph(monkeypatch, [parsed()])
    config = run_config()
    await graph.ainvoke({"document": reference}, config)
    state = (await graph.aget_state(config)).values
    baseline = await document._merge(cast(document.DocumentState, deepcopy(state)), passive=True)
    unit = state["chunkResults"][0]
    payload = json.loads(await files.get_verified(ArtifactReference.model_validate(unit["resultRef"])))
    audit = {"status": status, "failureCode": None, "missingQuestions": status == "repair_rejected",
             "original": deepcopy(payload["parsed"]), "reports": [{"issues": [{
                 "code": "stem", "instruction": "Retain printed wording", "evidence": "First",
             }]}]}
    payload["agentReview"] = audit
    archived = await files.put_artifact(json.dumps(payload).encode(), source_sha256=reference["sha256"],
                                        kind="unit-result", index=unit["index"], media_type="application/json")
    historical = {**unit, "resultRef": archived.model_dump(mode="json")}
    loaded = await document.load_unit_result(historical, reference["sha256"])
    assert loaded["agentReview"] == audit
    state["chunkResults"] = [historical]
    result = await document._merge(cast(document.DocumentState, state), passive=True)
    assert result["result"]["questions"][0]["stem"] == "First"
    assert any(status in warning and "Retain printed wording" in warning
               for warning in result["result"]["warnings"])
    assert result["processing"]["quality"]["reviewRequired"] is (
        baseline["processing"]["quality"]["reviewRequired"] or status != "no_discrepancy"
    )
    if audit["missingQuestions"]:
        assert "questions" in result["result"]["missingFields"]
    assert len(model.calls) == 1
