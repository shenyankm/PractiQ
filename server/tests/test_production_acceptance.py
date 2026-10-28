"""Production preflight rejects missing, synthetic, stale or mismatched evidence."""

import copy

import pytest

from scripts import production_acceptance


def evidence():
    now = 1_800_000_000.0
    code, image = "a" * 64, "sha256:" + "b" * 64
    quality = {"schemaVersion": 2, "kind": "evaluation", "environment": "local-real-services", "status": "PASSED",
               "generatedAt": "2027-01-15T08:00:00+00:00", "codeHash": code, "repetitions": 3,
               "productionProvenance": {"kind": "independent_human_review", "sourceHashes": ["c" * 64]}}
    capacity = {"schemaVersion": 1, "status": "PASSED", "environment": "production", "generatedAt": quality["generatedAt"],
                "codeHash": code, "serviceCodeHash": code, "imageDigest": image, "entrypointHttps": True,
                "sourceSha256": "c" * 64, "results": {"completionP95Seconds": 100}}
    restore = {"schemaVersion": 1, "kind": "service-backup-operation", "action": "restore", "status": "PASSED",
               "completedUnix": now, "snapshotUnix": now - 100, "durationSeconds": 20, "codeHash": code, "image": image}
    samples = [{"metric": {"__name__": "up", "job": job}, "value": [now, "1"]}
               for job in ("practiq-ai", "practiq-ready", "practiq-backups", "practiq-containers")]
    samples.extend({"metric": {"__name__": name, "job": "practiq-ready" if name == "probe_success" else "practiq-backups" if name.startswith("practiq_backup_") else "practiq-ai"}, "value": [now, str(value)]} for name, value in {
        "probe_success": 1, "practiq_backup_last_attempt_success": 1,
        "practiq_storage_healthy": 1, "practiq_broker_connected": 1,
        "practiq_worker_sandbox_required": 1, "practiq_cost_budget_enabled": 1,
        "practiq_cost_daily_limit_micros": 1_000_000,
        "practiq_backup_last_success_timestamp_seconds": now - 100,
        "practiq_outbox_oldest_seconds": 0, "practiq_tencent_unknown_jobs": 0,
    }.items())
    monitoring = {"status": "success", "data": {"resultType": "vector", "result": samples}}
    return {"quality": quality, "capacity": capacity, "restore": restore, "monitoring": monitoring}, code, now


def test_complete_matched_evidence_passes_only_the_automated_preflight():
    inputs, code, now = evidence()
    report = production_acceptance.check(inputs, code_hash=code, now=now)
    assert report["status"] == "PASSED" and report["scope"] == "automated_preflight"
    assert report["remainingManualChecks"]


@pytest.mark.parametrize("change,reason", [
    (lambda data: data["quality"].pop("productionProvenance"), "INDEPENDENT_HOLDOUT_REQUIRED"),
    (lambda data: data["capacity"].update(serviceCodeHash="d" * 64), "CAPACITY_CANDIDATE_MISMATCH"),
    (lambda data: data["capacity"].update(entrypointHttps=False), "HTTPS_ENTRYPOINT_REQUIRED"),
    (lambda data: data["capacity"].update(entrypointHttps="true"), "HTTPS_ENTRYPOINT_REQUIRED"),
    (lambda data: data["restore"].update(image="sha256:" + "d" * 64), "RESTORE_CANDIDATE_MISMATCH"),
    (lambda data: data["restore"].update(durationSeconds=1000), "RESTORE_TARGET_EXCEEDED"),
    (lambda data: data["capacity"]["results"].update(completionP95Seconds=float("nan")), "CAPACITY_TARGET_EXCEEDED"),
    (lambda data: data["monitoring"]["data"]["result"].clear(), "MONITORING_INCOMPLETE"),
])
def test_incomplete_evidence_cannot_pass(change, reason):
    inputs, code, now = evidence()
    change(inputs)
    assert reason in production_acceptance.check(inputs, code_hash=code, now=now)["gateReasons"]


def test_old_or_missing_evidence_is_blocked():
    inputs, code, now = evidence()
    original = copy.deepcopy(inputs)
    inputs["monitoring"]["data"]["result"][0]["value"][0] = now - 600
    assert "MONITORING_STALE" in production_acceptance.check(inputs, code_hash=code, now=now)["gateReasons"]
    original.pop("restore")
    assert production_acceptance.check(original, code_hash=code, now=now)["status"] == "BLOCKED"


def test_another_job_cannot_supply_missing_readiness_evidence():
    inputs, code, now = evidence()
    for sample in inputs["monitoring"]["data"]["result"]:
        if sample["metric"]["__name__"] == "probe_success":
            sample["metric"]["job"] = "unrelated-ready"
    assert "MONITORING_INCOMPLETE" in production_acceptance.check(inputs, code_hash=code, now=now)["gateReasons"]
