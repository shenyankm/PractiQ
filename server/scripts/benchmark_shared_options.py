"""Compare shared word-bank tree validation without model or storage work."""

import argparse
import hashlib
import inspect
import json
import platform
import subprocess
from pathlib import Path
from statistics import median
from time import perf_counter
from typing import Any
from unittest.mock import patch

from benchmark_web_server import ROOT, baseline_function, digest

from practiq_ai import contracts
from practiq_ai.contracts import (
    ContentBlock,
    DocumentParseResult,
    ParsedOption,
    ParsedQuestion,
)


def fixture(banks, children):
    questions = []
    for bank in range(banks):
        owner = f"bank-{bank}"
        rows = [ParsedQuestion(
            id=f"{owner}-{i}", parentId=owner, optionSourceId=owner,
            stem=f"Choose word {i}", answerMode="choice", choiceVariant="single",
            questionTypeId="choice", answerPayload={"correct": ["A"]},
            contentBlocks=[ContentBlock(partType="text", textValue=f"Supplied context {j}") for j in range(20)],
            sourceText=f"Source question {i}", analysis="Supplied analysis",
        ) for i in range(children)]
        questions.extend([ParsedQuestion(
            id=owner, stem="Choose words", answerMode="word_bank", allowReuse=True,
            options=[ParsedOption(label=chr(65 + i), content=f"Supplied word {i}") for i in range(20)],
            passage=[ContentBlock(partType="blank", questionId=row.id) for row in rows],
        ), *rows])
    if not banks:
        questions = [ParsedQuestion(id=f"q{i}", stem=f"Question {i}", answerMode="short_answer",
                                    answerPayload={"text": "Supplied reference"}) for i in range(children)]
    return questions


def measure(before, after, run, serialize):
    report: dict[str, dict[str, Any]] = {name: {"samplesMs": []} for name in ("before", "after")}
    expected = None
    for pair in range(3):
        functions = [("before", before), ("after", after)]
        for name, function in functions if pair % 2 == 0 else reversed(functions):
            with patch.object(contracts, "validate_question_tree", function):
                for iteration in range(8):
                    start = perf_counter()
                    result = run()
                    elapsed = (perf_counter() - start) * 1000
                    output = digest(serialize(result))
                    if expected is None:
                        expected = output
                    assert output == expected
                    if iteration:
                        report[name]["samplesMs"].append(elapsed)
                    del result
    for row in report.values():
        row.update(medianMs=median(row["samplesMs"]), outputSha256=expected)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    baseline = subprocess.check_output(["git", "rev-parse", args.baseline], cwd=ROOT, text=True).strip()
    before = baseline_function(baseline, contracts, "validate_question_tree")
    after = contracts.validate_question_tree
    workloads = []
    for banks, children in [(1, 20), (1, 100), (9, 100), (0, 1000)]:
        questions = fixture(banks, children)
        payload = DocumentParseResult(schemaVersion=3, questions=questions, groups=[],
                                      visualElements=[], warnings=[], confidenceScore=100).model_dump(mode="json")
        original = digest(payload)
        tree = measure(before, after, lambda questions=questions: contracts.validate_question_tree(questions),
                       lambda _, questions=questions: [q.model_dump(mode="json") for q in questions])
        full = measure(before, after, lambda payload=payload: DocumentParseResult.model_validate(payload),
                       lambda result: result.model_dump(mode="json"))
        assert digest({**payload, "questions": [q.model_dump(mode="json") for q in questions]}) == original
        assert full["before"]["outputSha256"] == original
        workloads.append({"banks": banks, "childrenPerBank": children, "questions": len(questions),
                          "inputSha256": original, "tree": tree, "resultValidation": full})
    report = {"baseline": baseline, "python": platform.python_version(), "platform": platform.platform(),
              "scope": "Synthetic valid word-bank trees and flat control. Three alternating pairs, one warmup and seven samples each; GC enabled. Setup, patching, assertions, output dumping/hashing and result destruction excluded. No models, DB, IPC, storage or end-to-end throughput claim.",
              "probeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "functionSha256": hashlib.sha256(inspect.getsource(after).encode()).hexdigest(), "workloads": workloads}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    for row in workloads:
        print(row["questions"], {key: {name: round(row[key][name]["medianMs"], 3) for name in ("before", "after")}
                                 for key in ("tree", "resultValidation")})


if __name__ == "__main__":
    main()
