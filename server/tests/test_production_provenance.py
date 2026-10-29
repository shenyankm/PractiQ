"""A synthetic regression pass cannot silently become production-quality evidence."""

import hashlib
import json

import pytest

from scripts import evaluate


def dataset(tmp_path):
    source = tmp_path / "source.txt"
    source.write_text("1. Original question\nAnswer: supplied answer")
    manifest = tmp_path / "cases.json"
    manifest.write_text(json.dumps({"schemaVersion": 2, "cases": [{
        "id": "held-out", "sourceType": "text", "path": "source.txt", "split": "holdout",
        "expectedQuestions": [{"stem": "Original question", "answerMode": "short_answer", "answerPayload": {"text": "supplied answer"}}],
    }]}))
    provenance = tmp_path / "provenance.json"
    value = {"version": 1, "origin": "consented_real_documents", "labelMethod": "independent_human_review",
             "annotatorId": "annotator-1", "reviewerId": "reviewer-2", "frozenAt": "2026-01-01T00:00:00+00:00",
             "manifestSha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
             "sourceSha256": {"held-out": hashlib.sha256(source.read_bytes()).hexdigest()}}
    provenance.write_text(json.dumps(value))
    return manifest, provenance, value


def test_holdout_provenance_binds_labels_sources_and_independent_review(tmp_path):
    manifest, provenance, _ = dataset(tmp_path)
    result = evaluate.load_production_provenance(manifest, provenance)
    assert result["kind"] == "independent_human_review"
    assert result["manifestSha256"] == hashlib.sha256(manifest.read_bytes()).hexdigest()
    assert "annotatorId" not in result and "reviewerId" not in result
    (tmp_path / "source.txt").write_text("source changed")
    with pytest.raises(ValueError, match="source hash"):
        evaluate.load_production_provenance(manifest, provenance)


@pytest.mark.parametrize("field,value", [
    ("origin", "synthetic"), ("reviewerId", "annotator-1"),
    ("frozenAt", "2999-01-01T00:00:00+00:00"), ("manifestSha256", "0" * 64),
])
def test_unverified_production_labels_are_rejected(tmp_path, field, value):
    manifest, provenance, content = dataset(tmp_path)
    content[field] = value
    provenance.write_text(json.dumps(content))
    with pytest.raises(ValueError):
        evaluate.load_production_provenance(manifest, provenance)


async def test_missing_production_provenance_blocks_before_provider_configuration(tmp_path, monkeypatch):
    manifest, _, _ = dataset(tmp_path)
    monkeypatch.setattr(evaluate, "load", lambda: pytest.fail("provider configuration must remain passive"))
    report = await evaluate.run_evaluation(manifest, repetitions=3, split="holdout", provenance_path=tmp_path / "missing.json")
    assert report["status"] == "BLOCKED" and report["gateReasons"] == ["INDEPENDENT_HOLDOUT_REQUIRED"]


def test_production_cli_requires_a_complete_repeated_holdout(tmp_path):
    manifest, provenance, _ = dataset(tmp_path)
    with pytest.raises(SystemExit):
        evaluate.parse_args(["--manifest", str(manifest), "--production-provenance", str(provenance)])


@pytest.mark.usefixtures("disposable_databases")
async def test_evaluation_passes_owned_database_to_actual_graph_cost_admission(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    from practiq_ai.cost_budget import NAMESPACE
    from tests.db_support import new_database
    from tests.support import parsed, setup_graph

    manifest, _, _ = dataset(tmp_path)
    _, _, files, reference, model = setup_graph(monkeypatch, [parsed()])
    db = await new_database()
    for name, value in {"DATABASE_URI": db.uri, "AI_COST_CURRENCY": "CNY", "AI_TASK_COST_LIMIT": "100",
                        "AI_DAILY_COST_LIMIT": "1000", "AI_COST_INPUT_PER_MILLION": "2",
                        "AI_COST_OUTPUT_PER_MILLION": "8", "AI_COST_TENCENT_PER_PAGE": "0"}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(evaluate, "prepare_document", AsyncMock(return_value=reference))
    monkeypatch.setattr(evaluate, "get_object_store", lambda: files)
    report = await evaluate.run_evaluation(manifest)
    assert report["status"] != "BLOCKED" and model.calls
    receipts = await db.store.asearch(NAMESPACE, filter={"kind": "model"})
    assert receipts and all(item.value["reservedMicros"] > 0 for item in receipts)
