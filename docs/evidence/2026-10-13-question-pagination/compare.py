"""Compare baseline/candidate release test binaries with five alternating pairs."""

import json
import os
import platform
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    binaries = {"before": sys.argv[1], "after": sys.argv[2]}
    reports = {name: [] for name in binaries}
    with tempfile.TemporaryDirectory() as temporary:
        output = Path(temporary) / "result.json"
        for pair in range(5):
            for name in (["before", "after"] if pair % 2 == 0 else ["after", "before"]):
                output.unlink(missing_ok=True)
                subprocess.run([binaries[name], "store::search_tests::search_stress", "--exact", "--ignored"],
                               env={**os.environ, "PRACTIQ_SEARCH_PERF_OUTPUT": str(output)},
                               stdout=subprocess.DEVNULL, check=True)
                report = json.loads(output.read_text())
                assert report["questions"] == 10000 and report["repetitions"] == 3
                reports[name].append(report)
    destination = Path(sys.argv[3])
    destination.mkdir(parents=True, exist_ok=True)
    for name, trials in reports.items():
        summary = {"questions": 10000, "repetitions": 3, "alternatingPairs": 5,
                   "platform": platform.platform()}
        for workload in trials[0]:
            if workload in {"questions", "repetitions"}:
                continue
            values = [trial[workload] for trial in trials]
            assert len({value["outputSha256"] for value in values}) == 1
            assert values[0]["outputSha256"] == reports["before"][0][workload]["outputSha256"]
            times = [value["medianMs"] for value in values]
            summary[workload] = {"medianMs": statistics.median(times), "pairMediansMs": times,
                                 "jsonBytes": values[0]["jsonBytes"], "outputSha256": values[0]["outputSha256"]}
        (destination / f"{name}.json").write_text(json.dumps(summary, indent=2) + "\n")


if __name__ == "__main__":
    main()
