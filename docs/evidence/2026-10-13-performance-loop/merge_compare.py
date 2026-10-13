"""Compare current source snapshots with fixed merge inputs; no model or database work."""

import argparse
import cProfile
import hashlib
import importlib.metadata
import json
import os
import platform
import pstats
import statistics
import subprocess
import sys
import time
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[3]
BASELINE = Path("/var/folders/1b/b19xbzjx7xqc4kl0k9x_y4y80000gp/T/practiq-perf-loop-qrdu2192/baseline")
CASES = ("pages", "text-overlap")


def canonical(value):
    return json.dumps(value, default=lambda item: item.model_dump(mode="json"),
                      ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def workload(case):
    from practiq_ai.contracts import ParsedGroup, ParsedQuestion

    lines = [f"Unique question {index:04d}." for index in range(1000)]
    questions = [ParsedQuestion(
        id=f"source-{index}", stem=line, sourceText=line, answerMode="choice", choiceVariant="single",
        questionTypeId="imported-choice",
        options=[{"label": label, "content": f"Supplied option {label} for {index}: " + "content " * 15}
                 for label in "ABCD"],
        answerPayload=None if index % 17 == 0 else {"correct": ["B"]},
        sourceScore=5.0, scoringRubric="Source rubric: choose the supplied answer.",
        scoreSourceText="5 points", analysis="Source explanation " * 30,
        contentBlocks=[{"partType": "text", "textValue": f"Block {block} of {index}: " + "material " * 20}
                       for block in range(8)],
        confidence=0.9, needsReview=index % 23 == 0,
    ) for index, line in enumerate(lines)]

    def groups(count):
        return [ParsedGroup(title=f"Material {index}", instructions="Supplied material instructions",
                            questionIndexes=list(range(index * 100, (index + 1) * 100)))
                for index in range(count // 100)]

    if case == "pages":
        chunks = [(0, questions[:500], groups(500)), (1, questions[500:], groups(500))]
        options = {"overlapping": False}
    else:
        text = "\n".join(lines)
        chunks = [(0, questions, groups(1000)), (1, questions, groups(1000))]
        options = {"source_text": text, "chunk_spans": [
            {"start": 0, "end": len(text), "overlapStart": 0, "overlapEnd": 0},
            {"start": 0, "end": len(text), "overlapStart": 0, "overlapEnd": len(text)},
        ]}
    return chunks, options, questions


def assert_output(result, case, originals):
    questions, groups, warnings, truncated, sources, quality = result
    assert len(questions) == 1000 and len(groups) == 10
    assert not warnings and not truncated
    assert [question.model_dump() for question in questions] == [question.model_dump() for question in originals]
    assert len(sources) == (1000 if case == "pages" else 2000)
    assert {source.stage for source in sources} == {"vision_parse" if case == "pages" else "document_parse"}
    assert quality.reviewQuestionCount == sum(question.needsReview for question in originals)
    for question, original in zip(questions, originals, strict=True):
        assert question is not original
        assert question.contentBlocks[0] is not original.contentBlocks[0]
        assert question.options[0] is not original.options[0]


def worker(source, case, profile_file):
    from practiq_ai.graphs import chunking
    from scripts.benchmark_processing import measure

    assert Path(chunking.__file__).resolve().is_relative_to(source.resolve())
    chunks, options, originals = workload(case)
    input_before = digest([chunks, options])
    results, samples = [], []

    def run():
        started = time.perf_counter()
        result = chunking.merge_chunk_results(chunks, **options)
        samples.append((time.perf_counter() - started) * 1000)
        results.append(result)
        return result

    if profile_file:
        profiler = cProfile.Profile()
        result = profiler.runcall(run)
        profiler.dump_stats(profile_file)
        stats = pstats.Stats(profiler)
        rows = [{"file": filename, "line": line, "function": function,
                 "primitiveCalls": entry[0], "calls": entry[1],
                 "selfSeconds": entry[2], "cumulativeSeconds": entry[3]}
                for (filename, line, function), entry in stats.stats.items()]
        profile = {"file": str(profile_file), "sha256": hashlib.sha256(profile_file.read_bytes()).hexdigest(),
                   "totalSeconds": stats.total_tt,
                   "contentFunctions": [row for row in rows if row["function"] == "_content"],
                   "topCumulative": sorted(rows, key=lambda row: row["cumulativeSeconds"], reverse=True)[:25]}
        measure_median = None
    else:
        result, measure_median = measure(run)
        assert len(samples) == 3
        profile = None

    output_hashes = []
    for output in results:
        assert_output(output, case, originals)
        output_hashes.append(digest(output))
    input_after = digest([chunks, options])
    assert input_before == input_after
    assert len(set(output_hashes)) == 1
    paths = ["server/src/practiq_ai/graphs/chunking.py", "server/src/practiq_ai/contracts.py",
             "server/scripts/benchmark_processing.py"]
    return {
        "case": case, "sourceRoot": str(source), "python": platform.python_version(),
        "executable": sys.executable, "platform": platform.platform(), "machine": platform.machine(),
        "pythonOptimization": sys.flags.optimize, "pythonHashSeed": os.environ.get("PYTHONHASHSEED"),
        "dependencies": {name: importlib.metadata.version(name) for name in ("pydantic", "Pillow")},
        "sourceHashes": {path: hashlib.sha256((source / path).read_bytes()).hexdigest() for path in paths},
        "harnessSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "uniqueInputQuestions": 1000, "inputOccurrences": sum(len(chunk[1]) for chunk in chunks),
        "chunkNodeCounts": [len(chunk[1]) for chunk in chunks], "inputSha256": input_before,
        "inputAfterSha256": input_after, "unchangedInputs": True,
        "outputSha256": output_hashes[0], "outputHashes": output_hashes,
        "retainedQuestions": len(result[0]), "retainedGroups": len(result[1]),
        "samplesMs": samples, "firstMeasuredCallMs": samples[0],
        "warmSamplesMs": samples[1:], "warmMedianMs": statistics.median(samples[1:]) if len(samples) > 1 else None,
        "benchmarkProcessingMeasureMedianMs": measure_median, "profile": profile,
        "realModelCalls": 0,
    }


def invoke(source, case, profile_file=None):
    command = [sys.executable, str(Path(__file__).resolve()), "--worker", "--source", str(source), "--case", case]
    if profile_file:
        command += ["--profile-file", str(profile_file.resolve())]
    environment = {**os.environ, "PYTHONPATH": os.pathsep.join([str(source / "server/src"), str(source / "server")]),
                   "PYTHONHASHSEED": "0", "PYTHONOPTIMIZE": "0"}
    completed = subprocess.run(command, cwd=source, env=environment, check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--baseline", type=Path, default=BASELINE)
    parser.add_argument("--candidate", type=Path, default=REPOSITORY)
    parser.add_argument("--pairs", type=int, default=5)
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--case", choices=CASES)
    parser.add_argument("--profile-file", type=Path)
    args = parser.parse_args()
    if args.worker:
        if args.source is None or args.case is None:
            parser.error("--worker requires --source and --case")
        print(json.dumps(worker(args.source.resolve(), args.case, args.profile_file), indent=2))
        return
    if args.output is None or args.pairs < 5:
        parser.error("--output and at least five pairs are required")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sources = {"baseline": args.baseline.resolve(), "candidate": args.candidate.resolve()}
    profiles = {case: invoke(sources["baseline"], case, args.output.with_name(f"merge-baseline-{case}.prof"))
                for case in CASES}
    rows = []
    for pair in range(args.pairs):
        order = ("baseline", "candidate") if pair % 2 == 0 else ("candidate", "baseline")
        for case in CASES:
            runs = {name: invoke(sources[name], case) for name in order}
            assert runs["baseline"]["inputSha256"] == runs["candidate"]["inputSha256"]
            assert runs["baseline"]["outputSha256"] == runs["candidate"]["outputSha256"]
            assert runs["baseline"]["outputSha256"] == profiles[case]["outputSha256"]
            rows.append({"pair": pair + 1, "case": case, "order": list(order), "runs": runs})
    summary = {}
    for case in CASES:
        selected = [row for row in rows if row["case"] == case]
        summary[case] = {name: {
            "firstCallMedianMs": statistics.median(row["runs"][name]["firstMeasuredCallMs"] for row in selected),
            "warmMedianMs": statistics.median(row["runs"][name]["warmMedianMs"] for row in selected),
            "warmPairMediansMs": [row["runs"][name]["warmMedianMs"] for row in selected],
        } for name in sources}
        summary[case]["pairedWarmChangePercent"] = [
            100 * (row["runs"]["candidate"]["warmMedianMs"] / row["runs"]["baseline"]["warmMedianMs"] - 1)
            for row in selected]
    report = {"method": "Sequential fresh CPython workers, alternating AB/BA source order, three calls through the existing benchmark_processing.measure per worker. Fixture construction/import and assertions/hashing excluded from raw merge timings. First measured call is separate from two warm calls; it is not OS-cache-cold startup. cProfile runs are outside paired timing.",
              "limitations": "CPU merge microbenchmark only; excludes extraction, model work, durable storage/checkpoints, HTTP and WebView. Rich synthetic questions are not a quality evaluation; no user files or database access.",
              "pairsPerCase": args.pairs, "profiles": profiles, "pairs": rows, "summary": summary}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
