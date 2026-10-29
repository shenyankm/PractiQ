"""Offline production preflight over matched quality, load, restore and monitoring evidence."""

import argparse
import hashlib
import json
import math
import os
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from practiq_ai.config import EVALUATION_SETTING_NAMES
from practiq_ai.execution import code_version, fingerprint
from practiq_ai.json_repair import unique_json_object

MANUAL_CHECKS = ["Verify delivery of a test alert to the configured receiver", "Inspect RabbitMQ dead letters",
                 "Verify restored task/artifact reads and service startup; record full recovery time"]


def _number(value: Any) -> float:
    if isinstance(value, bool):
        raise TypeError("Invalid numeric evidence")
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise ValueError("Invalid numeric evidence")
    return result


def check(inputs: dict[str, Any], *, code_hash: str, now: float,
          max_age: float = 86400, max_rpo: float = 900, max_restore: float = 900,
          max_completion: float = 1800) -> dict[str, Any]:
    reasons = []
    report = {"schemaVersion": 1, "kind": "production-preflight", "scope": "automated_preflight",
              "generatedAt": datetime.fromtimestamp(now, UTC).isoformat(), "codeHash": code_hash,
              "remainingManualChecks": MANUAL_CHECKS}
    if set(inputs) != {"quality", "capacity", "restore", "monitoring"}:
        return {**report, "status": "BLOCKED", "gateReasons": ["MISSING_EVIDENCE"]}
    try:
        quality, capacity, restore, monitoring = (inputs[name] for name in ("quality", "capacity", "restore", "monitoring"))
        if not all(isinstance(value, dict) for value in (quality, capacity, restore, monitoring)):
            raise ValueError("Evidence must be JSON objects")
        for name, value in (("QUALITY", quality), ("CAPACITY", capacity)):
            generated = datetime.fromisoformat(value["generatedAt"])
            if generated.tzinfo is None or not 0 <= now - generated.timestamp() <= max_age:
                reasons.append(f"{name}_EVIDENCE_STALE")
            if value.get("status") != "PASSED" or value.get("serviceCodeHash" if name == "QUALITY" else "codeHash") != code_hash:
                reasons.append(f"{name}_CANDIDATE_MISMATCH")
        if not re.fullmatch(r"[a-f0-9]{64}", str(quality.get("codeHash"))):
            reasons.append("QUALITY_CANDIDATE_MISMATCH")
        models, settings = quality.get("models"), quality.get("settings")
        configuration_hash = quality.get("configurationHash")
        if (not isinstance(models, dict) or set(models) != {"provider", "modelId", "endpointHash"}
                or any(not isinstance(models.get(key), str) or not models[key] for key in ("provider", "modelId"))
                or not re.fullmatch(r"[a-f0-9]{64}", str(models.get("endpointHash")))
                or not isinstance(settings, dict) or set(settings) != set(EVALUATION_SETTING_NAMES)
                or not re.fullmatch(r"[a-f0-9]{64}", str(configuration_hash))
                or configuration_hash != fingerprint({"models": models, "settings": settings})
                or capacity.get("serviceConfigurationHash") != configuration_hash):
            reasons.append("MODEL_CONFIGURATION_MISMATCH")
        else:
            report["configurationHash"] = configuration_hash
        provenance = quality.get("productionProvenance") or {}
        if not isinstance(provenance, dict):
            raise TypeError("Invalid provenance evidence")
        if (quality.get("schemaVersion") != 2 or quality.get("kind") != "evaluation"
                or quality.get("environment") != "local-real-services" or quality.get("repetitions", 0) < 3
                or provenance.get("kind") != "independent_human_review"):
            reasons.append("INDEPENDENT_HOLDOUT_REQUIRED")
        if (capacity.get("schemaVersion") != 1 or capacity.get("environment") != "production" or capacity.get("serviceCodeHash") != code_hash
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", str(capacity.get("imageDigest")))):
            reasons.append("CAPACITY_CANDIDATE_MISMATCH")
        if capacity.get("entrypointHttps") is not True:
            reasons.append("HTTPS_ENTRYPOINT_REQUIRED")
        if capacity.get("sourceSha256") not in provenance.get("sourceHashes", []):
            reasons.append("REPRESENTATIVE_LOAD_SOURCE_REQUIRED")
        try:
            if _number(capacity["results"]["completionP95Seconds"]) > max_completion:
                reasons.append("CAPACITY_TARGET_EXCEEDED")
        except (ValueError, TypeError):
            reasons.append("CAPACITY_TARGET_EXCEEDED")
        if (restore.get("schemaVersion") != 1 or restore.get("kind") != "service-backup-operation" or restore.get("action") != "restore"
                or restore.get("status") != "PASSED" or restore.get("codeHash") != code_hash
                or restore.get("image") != capacity.get("imageDigest")):
            reasons.append("RESTORE_CANDIDATE_MISMATCH")
        if not 0 <= now - _number(restore["completedUnix"]) <= max_age:
            reasons.append("RESTORE_EVIDENCE_STALE")
        if _number(restore["durationSeconds"]) > max_restore:
            reasons.append("RESTORE_TARGET_EXCEEDED")
        if not 0 <= _number(restore["completedUnix"]) - _number(restore["snapshotUnix"]) <= max_rpo:
            reasons.append("BACKUP_RECOVERY_POINT_EXCEEDED")
        if monitoring.get("status") != "success" or monitoring["data"]["resultType"] != "vector":
            raise ValueError("Invalid monitoring evidence")
        samples = monitoring["data"]["result"]
        metrics: dict[str, list[float]] = {}
        jobs: dict[str, list[float]] = {}
        for sample in samples:
            labels = sample["metric"]
            timestamp, value = sample["value"]
            if not 0 <= now - _number(timestamp) <= 60:
                reasons.append("MONITORING_STALE")
            name = labels["__name__"]
            expected_job = "practiq-ready" if name == "probe_success" else "practiq-backups" if name.startswith("practiq_backup_") else "practiq-ai"
            if labels.get("job") == expected_job:
                metrics.setdefault(name, []).append(_number(value))
            if labels["__name__"] == "up":
                jobs.setdefault(labels.get("job", ""), []).append(_number(value))
            if labels["__name__"] == "ALERTS" and labels.get("alertstate") == "firing":
                reasons.append("ACTIVE_ALERTS")
        for job in ("practiq-ai", "practiq-ready", "practiq-backups", "practiq-containers"):
            if not jobs.get(job) or any(value != 1 for value in jobs[job]):
                reasons.append("MONITORING_INCOMPLETE")
        required = {"probe_success": 1, "practiq_backup_last_attempt_success": 1,
                    "practiq_storage_healthy": 1, "practiq_broker_connected": 1,
                    "practiq_worker_sandbox_required": 1, "practiq_cost_budget_enabled": 1,
                    "practiq_tencent_unknown_jobs": 0}
        if any(not metrics.get(name) or any(value != expected for value in metrics[name]) for name, expected in required.items()):
            reasons.append("MONITORING_INCOMPLETE")
        if not metrics.get("practiq_cost_daily_limit_micros") or min(metrics["practiq_cost_daily_limit_micros"]) <= 0:
            reasons.append("COST_DAILY_LIMIT_REQUIRED")
        backup_times = metrics.get("practiq_backup_last_success_timestamp_seconds", [])
        if not backup_times or any(not 0 <= now - value <= max_rpo for value in backup_times):
            reasons.append("BACKUP_STALE")
        if not metrics.get("practiq_outbox_oldest_seconds") or max(metrics["practiq_outbox_oldest_seconds"]) > 120:
            reasons.append("OUTBOX_STALLED")
    except (KeyError, TypeError, ValueError, OverflowError):
        return {**report, "status": "BLOCKED", "gateReasons": [*dict.fromkeys(reasons), "INVALID_EVIDENCE"]}
    return {**report, "status": "FAILED" if reasons else "PASSED", "gateReasons": list(dict.fromkeys(reasons))}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("quality", "capacity", "restore", "monitoring"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-age-seconds", type=float, default=86400)
    parser.add_argument("--max-rpo-seconds", type=float, default=900)
    parser.add_argument("--max-restore-seconds", type=float, default=900)
    parser.add_argument("--max-completion-p95-seconds", type=float, default=1800)
    args = parser.parse_args(argv)
    if args.output.exists() or any(not math.isfinite(value) or value <= 0 for value in (
        args.max_age_seconds, args.max_rpo_seconds, args.max_restore_seconds, args.max_completion_p95_seconds)):
        parser.error("Use a new output path and finite positive acceptance targets")
    inputs, hashes = {}, {}
    try:
        for name in ("quality", "capacity", "restore", "monitoring"):
            path = getattr(args, name)
            if path.stat().st_size > 64 * 1024 * 1024:
                raise ValueError("Evidence exceeds byte limit")
            payload = path.read_bytes()
            inputs[name] = json.loads(payload, object_pairs_hook=unique_json_object)
            hashes[name] = hashlib.sha256(payload).hexdigest()
        report = check(inputs, code_hash=code_version(), now=time.time(), max_age=args.max_age_seconds,
                       max_rpo=args.max_rpo_seconds, max_restore=args.max_restore_seconds, max_completion=args.max_completion_p95_seconds)
    except (OSError, ValueError):
        report = {"schemaVersion": 1, "kind": "production-preflight", "scope": "automated_preflight",
                  "status": "BLOCKED", "gateReasons": ["MISSING_OR_INVALID_EVIDENCE"], "remainingManualChecks": MANUAL_CHECKS}
    report["evidenceHashes"] = hashes
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(json.dumps(report, indent=2) + "\n")
    print(report["status"])
    return {"PASSED": 0, "FAILED": 1, "BLOCKED": 2}[report["status"]]


if __name__ == "__main__":
    raise SystemExit(main())
