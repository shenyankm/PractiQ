"""Five sequential alternating release-binary pairs, reusing native workloads."""
import hashlib
import json
import os
import statistics
import subprocess
import sys
from pathlib import Path


def main():
    binaries = {"baseline": Path(sys.argv[1]), "candidate": Path(sys.argv[2])}
    test, variable, destination = sys.argv[3], sys.argv[4], Path(sys.argv[5])
    destination.mkdir(parents=True, exist_ok=True)
    trials = {name: [] for name in binaries}
    for pair in range(5):
        for name in (["baseline", "candidate"] if pair % 2 == 0 else ["candidate", "baseline"]):
            output = destination / f"{pair}-{name}.json"
            run = subprocess.run([str(binaries[name]), test, "--exact", "--ignored", "--nocapture", "--test-threads=1"],
                                 env={**os.environ, variable: str(output.resolve())}, capture_output=True, text=True, check=False)
            (destination / f"{pair}-{name}.log").write_text(run.stdout + run.stderr)
            assert run.returncode == 0, run.stdout + run.stderr
            report = json.loads(output.read_text())
            if "subsetCounts" in report:
                rows = {f"{row['roots']}:{row['weight']}": {**row["measurement"], "inputSha256": row["inputSha256"]}
                        for row in report["subsetCounts"]}
            elif "workloads" in report:
                rows = {f"{row['roots']}:{row['selection']}:random={row['random']}":
                        {"medianMs": row["medianMs"], "inputSha256": row["inputSha256"],
                         "outputSha256": row["samples"][0]["outputSha256"]}
                        for row in report["workloads"]}
            elif "backup" in report and "restore" in report:
                assert report["logicalBefore"]["sha256"] == report["inputSha256"]
                assert report["logicalBefore"]["schemaVersion"] == 11
                assert all(sample["logicalAfter"] == report["logicalBefore"] and sample["reopenPreservesAllTables"]
                           for sample in report["restore"])
                rows = {operation: {
                    "medianMs": statistics.median(sample["elapsedMs"] for sample in report[operation] if sample["phase"] == "warm"),
                    "firstInvocationMs": report[operation][0]["elapsedMs"],
                    "inputSha256": report["inputSha256"], "outputSha256": report["logicalBefore"]["sha256"]}
                    for operation in ("backup", "restore")}
            else:
                rows = {key: value for key, value in report.items()
                        if isinstance(value, dict) and "medianMs" in value}
            trials[name].append(rows)
    summary = {"alternatingPairs": 5, "test": test,
               "binarySha256": {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in binaries.items()},
               "workloads": {}}
    assert all(set(trial) == set(trials["baseline"][0]) for rows in trials.values() for trial in rows)
    for label in trials["baseline"][0]:
        measurements = {name: [trial[label] for trial in rows] for name, rows in trials.items()}
        hashes = {m["outputSha256"] for values in measurements.values() for m in values if "outputSha256" in m}
        assert len(hashes) <= 1, label
        assert len({m["inputSha256"] for values in measurements.values() for m in values if "inputSha256" in m}) <= 1
        times = {name: [m["medianMs"] for m in values] for name, values in measurements.items()}
        medians = {name: statistics.median(values) for name, values in times.items()}
        summary["workloads"][label] = {"pairMediansMs": times, "mediansMs": medians,
            "candidateReductionPercent": (1 - medians["candidate"] / medians["baseline"]) * 100,
            "outputSha256": next(iter(hashes), None)}
    (destination / "comparison.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
