"""Compare bounded native-table layout matching; no storage or provider calls."""

import argparse
import hashlib
import inspect
import json
import platform
import subprocess
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from statistics import median
from time import perf_counter
from zipfile import ZIP_DEFLATED, ZipFile

from benchmark_web_server import ROOT, baseline_function, digest

from practiq_ai import tencent_bundle
from practiq_ai.config import load


def fixture(count: int) -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
        archive.writestr("result_xml_full.xml", "<root>" + "".join(
            f"<table><caption>Sheet {index}</caption><tr><td>Question {index}</td></tr></table>"
            for index in range(count)) + "</root>")
        for index in range(count):
            archive.writestr(f"result_ocr_page{index}.json", json.dumps({
                "table_name": f"Sheet {index}", "fields": [], "rows": []}))
    return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    baseline = subprocess.check_output(["git", "rev-parse", args.baseline], cwd=ROOT, text=True).strip()
    before = baseline_function(baseline, tencent_bundle, "decode_bundle")
    after = tencent_bundle.decode_bundle
    workloads = []
    for count in (1, 30, 100, 300):
        payload = fixture(count)
        config = replace(load(), max_document_pages=max(100, count))
        expected = before(payload, config, page_count=count)
        assert len(expected) == count
        assert all(f"Question {index}" in page["elements"][0]["layout_xml"] for index, page in enumerate(expected))
        measurements = {label: [] for label in ("before", "after")}
        for pair in range(3):
            variants = [("before", before), ("after", after)]
            for label, decode in variants if pair % 2 == 0 else reversed(variants):
                for sample in range(8):
                    start = perf_counter()
                    result = decode(payload, config, page_count=count)
                    elapsed = (perf_counter() - start) * 1000
                    assert result == expected
                    if sample:
                        measurements[label].append(elapsed)
        workloads.append({"pages": count, "tables": count, "inputSha256": hashlib.sha256(payload).hexdigest(),
                          "outputSha256": digest(expected), **{label: {"samplesMs": values, "medianMs": median(values)}
                                                               for label, values in measurements.items()}})
    report = {"baseline": baseline, "python": platform.python_version(), "platform": platform.platform(),
              "scope": "Synthetic compressed Tencent native-table ZIP decode. 1/30/100 pages use default limits; 300 uses the supported maximum. Three alternating pairs, one warmup plus seven samples each, GC enabled. Setup, assertions and output hashing excluded. No models, storage, DB or end-to-end latency claim.",
              "probeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "functionSha256": hashlib.sha256(inspect.getsource(after).encode()).hexdigest(), "workloads": workloads}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    for row in workloads:
        print(row["pages"], {label: round(row[label]["medianMs"], 3) for label in ("before", "after")})


if __name__ == "__main__":
    main()
