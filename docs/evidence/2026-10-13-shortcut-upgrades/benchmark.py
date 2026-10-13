"""Synthetic tooling benchmark; run from server with PYTHONPATH=src:."""

import hashlib
import json
import platform
import statistics
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

from scripts import evaluate, review_queue


def measure(run):
    times = []
    digests = []
    for _ in range(5):
        start = time.perf_counter()
        result = run()
        times.append((time.perf_counter() - start) * 1000)
        digests.append(hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest())
    tracemalloc.start()
    result = run()
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert len(set(digests)) == 1
    assert digests[0] == hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    return {"medianMs": statistics.median(times), "samplesMs": times,
            "peakPythonBytes": peak, "outputSha256": digests[0]}


def main():
    questions = [{"stem": f"Question {i}", "answerMode": "short_answer",
                  "options": [], "answerPayload": {"text": str(i)}} for i in range(1000)]
    predictions = list(reversed(questions))

    def score():
        result = evaluate.score_document_case(questions, predictions)
        assert result["matched"] == result["answerCorrect"] == 1000
        return result

    with tempfile.TemporaryDirectory() as temporary:
        log = Path(temporary) / "events.jsonl"
        with log.open("w") as handle:
            for i in range(10000):
                event = {"event": "review_candidate", "threadId": f"thread-{i}",
                         "runId": f"run-{i}", "sourceType": "text", "status": "SUCCEEDED",
                         "reviewRequired": False, "messages": "SYNTHETIC" * 500}
                handle.write(json.dumps(event) + "\n")
        reports = []
        original = review_queue.select_reviews

        def capture(events):
            report = original(events)
            reports.append(report)
            return report

        review_queue.select_reviews = capture

        def review():
            output = Path(temporary) / "queue.json"
            assert review_queue.main([str(log), "--output", str(output)]) == 0
            output.unlink()
            output.with_suffix(".md").unlink()
            report = reports.pop()
            assert report["observedByFormat"] == {"text": 10000}
            assert "SYNTHETIC" not in json.dumps(report)
            return report

        report = {"python": platform.python_version(), "platform": platform.platform(),
                  "repetitions": 5, "evaluationQuestions": 1000, "reviewEvents": 10000,
                  "reviewLogBytes": log.stat().st_size,
                  "evaluation": measure(score), "reviewQueue": measure(review)}
        with log.open("w") as handle:
            for i in range(10000):
                handle.write(json.dumps({"event": "review_candidate", "threadId": f"thread-{i}",
                                         "runId": f"run-{i}", "sourceType": "text", "status": "SUCCEEDED",
                                         "reviewRequired": False}) + "\n")
        report["metadataLogBytes"] = log.stat().st_size
        report["reviewMetadata"] = measure(review)
        review_queue.select_reviews = original
    Path(sys.argv[1]).write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
