"""Export wall time and event-loop stalls for real temporary storage and synthetic banks."""

import argparse
import asyncio
import binascii
import hashlib
import importlib.metadata
import io
import json
import os
import platform
import statistics
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

from merge_compare import BASELINE, REPOSITORY, canonical, digest, workload

CASES = ("no-resources", "image")


async def fixture(directory, case):
    from PIL import Image
    from practiq_ai.contracts import DocumentTaskDetail
    from tests.support import object_store, upload

    questions = workload("pages")[2]
    source_bytes = b"Synthetic supplied question bank; no model work.\n" + canonical(questions)
    store = object_store(directory)
    try:
        source = await store.put_document(source_bytes, upload(source_bytes))
        resources, visuals = {}, []
        if case == "image":
            dimensions = (2048, 1536)
            pixels = bytes(range(256)) * (dimensions[0] * dimensions[1] * 3 // 256)
            buffer = io.BytesIO()
            with Image.frombytes("RGB", dimensions, pixels) as image:
                image.save(buffer, "PNG", compress_level=0)
            image_bytes = buffer.getvalue()
            reference = await store.put_artifact(image_bytes, source_sha256=source.sha256,
                                                 kind="visual", index=0, media_type="image/png")
            resources[f"resources/{reference.objectKey}"] = (reference, image_bytes)
            visuals = [{"kind": "image", "description": "Synthetic supplied figure", "questionIds": [questions[0].id],
                        "imageRef": reference.model_dump(mode="json"), "sourceRef": reference.model_dump(mode="json")}]
        result = {"schemaVersion": 3, "questions": [question.model_dump(mode="json") for question in questions],
                  "groups": [{"title": f"Material {index}", "instructions": "Supplied material instructions",
                              "questionIds": [question.id for question in questions[index * 100:(index + 1) * 100]]}
                             for index in range(10)],
                  "visualElements": visuals, "warnings": ["Some supplied answers are unavailable"],
                  "confidenceScore": 90, "missingFields": []}
        counts = {"total": 1, "succeeded": 1, "failed": 0, "remaining": 0}
        visual_counts = counts if visuals else {key: 0 for key in counts}
        processing = {"chunks": {key: counts[key] for key in ("total", "succeeded")},
                      "visuals": {key: visual_counts[key] for key in ("total", "succeeded")},
                      "truncated": False, "failures": [],
                      "questionSources": [{"questionId": question.id, "stage": "document_parse", "unitIndex": 0}
                                          for question in questions],
                      "quality": {"reviewRequired": True, "reviewQuestionCount": sum(question.needsReview for question in questions),
                                  "issues": [{"questionId": question.id,
                                              "code": "MISSING_FIELDS" if question.missingFields else "NEEDS_REVIEW"}
                                             for question in questions if question.needsReview]}}
        detail = DocumentTaskDetail.model_validate({
            "threadId": "11111111-1111-4111-8111-111111111111", "runId": None, "parentThreadId": None,
            "modelConfigured": False, "resumeCompatible": False, "fileName": "quiz.txt", "state": "COMPLETED",
            "phase": "completed", "checkpointId": "synthetic-current-result", "updatedAt": "2026-10-13", "expiresAt": "2026-10-14",
            "allowedActions": [], "failures": [], "blocking": [], "progress": {"visuals": visual_counts, "chunks": counts},
            "status": "PARTIAL", "result": result, "modelBudget": {"limit": 0, "reserved": 0}, "processing": processing,
            "usage": [], "unknownUsageCalls": [],
        })
        return store, source, detail, resources
    except BaseException:
        store._executor.shutdown()
        raise


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()


def inspect_archive(payload, detail, resources):
    expected = {"manifest.json": json_bytes({"format": "practiq-question-bank", "version": 2,
                                            "bank": {"title": "quiz", "description": ""}}),
                "questions.json": json_bytes({"status": detail.status, "result": detail.result.model_dump(mode="json"),
                                               "processing": detail.processing.model_dump(mode="json")})}
    expected.update({name: content for name, (_reference, content) in sorted(resources.items())})
    payload.seek(0)
    archive_bytes = payload.read()
    entries = []
    with ZipFile(io.BytesIO(archive_bytes)) as archive:
        assert archive.namelist() == list(expected)
        assert archive.testzip() is None
        for entry in archive.infolist():
            content = archive.read(entry)
            assert content == expected[entry.filename]
            assert entry.CRC == binascii.crc32(content)
            assert entry.create_system == 3 and entry.external_attr >> 16 == 0o100600
            assert not entry.is_dir() and entry.compress_type == ZIP_DEFLATED
            if entry.filename in resources:
                reference = resources[entry.filename][0]
                assert len(content) == reference.sizeBytes
                assert hashlib.sha256(content).hexdigest() == reference.sha256
            entries.append({"name": entry.filename, "bytes": entry.file_size, "compressedBytes": entry.compress_size,
                            "crc32": entry.CRC, "sha256": hashlib.sha256(content).hexdigest(),
                            "permissions": oct(entry.external_attr >> 16), "createSystem": entry.create_system,
                            "compression": entry.compress_type, "dateTime": list(entry.date_time)})
    return {"archiveBytes": len(archive_bytes), "archiveSha256": hashlib.sha256(archive_bytes).hexdigest(),
            "entries": entries, "entriesSha256": digest(entries), "crcVerified": True,
            "resourceChecksumsVerified": True, "identicalExpectedEntries": True}


async def measured_export(store, source, detail, resources):
    from practiq_ai import bank_export

    gaps, running = [], True

    async def heartbeat():
        previous = time.perf_counter()
        while running:
            await asyncio.sleep(.001)
            current = time.perf_counter()
            gaps.append((current - previous) * 1000)
            previous = current

    ticker = asyncio.create_task(heartbeat())
    payload = None
    try:
        await asyncio.sleep(.005)
        gaps.clear()
        started = time.perf_counter()
        payload = await bank_export.export_task_bank(detail, store, source=source)
        elapsed = (time.perf_counter() - started) * 1000
        # Let the monitor record the export's last blocking interval before stopping.
        await asyncio.sleep(.002)
    finally:
        running = False
        await ticker
    try:
        assert gaps
        result = {"wallMs": elapsed, "maxHeartbeatGapMs": max(gaps),
                  "maxEventLoopStallMs": max(0, max(gaps) - 1), "heartbeatGapsMs": gaps,
                  "output": inspect_archive(payload, detail, resources)}
    finally:
        if payload is not None:
            payload.close()
    return result


async def localization(store, source, detail, resources):
    """Source-equivalent CPU phases plus an instrumented actual export, outside pairs."""
    from practiq_ai import bank_export
    from practiq_ai.contracts import DocumentParseResult, DocumentProcessing

    phases = {}
    started = time.perf_counter()
    result = DocumentParseResult.model_validate(detail.result.model_dump(mode="json"))
    processing = DocumentProcessing.model_validate(detail.processing.model_dump(mode="json"))
    phases["validationIncludingInputDumpsMs"] = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    ids = {question.id for question in result.questions}
    assert not any(item.questionId not in ids for item in [*processing.questionSources, *processing.quality.issues])
    phases["processingReferenceChecksMs"] = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    manifest = bank_export._json({"format": "practiq-question-bank", "version": 2,
                                 "bank": {"title": "quiz", "description": ""}})
    questions = bank_export._json({"status": detail.status, "result": result.model_dump(mode="json"),
                                  "processing": processing.model_dump(mode="json")})
    phases["serializationIncludingOutputDumpsMs"] = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    bank_export._limit(len(manifest), bank_export.MANIFEST_LIMIT, "Manifest JSON")
    bank_export._limit(len(questions), bank_export.JSON_LIMIT, "Questions JSON")
    references = bank_export._references(result, source)
    assert sorted(references) == sorted(resources)
    phases["limitsAndResourceReferenceChecksMs"] = (time.perf_counter() - started) * 1000
    thread_operations, storage_reads = [], []
    original_thread_io, original_read = bank_export._thread_io, store.get_verified
    actual_started = time.perf_counter()

    async def thread_io(function, *args):
        if not thread_operations:
            phases["actualBeforeFirstThreadOperationMs"] = (time.perf_counter() - actual_started) * 1000
        started = time.perf_counter()
        try:
            return await original_thread_io(function, *args)
        finally:
            thread_operations.append({"function": function.__name__,
                                      "entry": args[2] if function.__name__ == "_write_entry" else None,
                                      "wallMs": (time.perf_counter() - started) * 1000})

    async def read(reference):
        started = time.perf_counter()
        try:
            return await original_read(reference)
        finally:
            storage_reads.append({"objectKey": reference.objectKey, "bytes": reference.sizeBytes,
                                  "wallMs": (time.perf_counter() - started) * 1000})

    with patch.object(bank_export, "_thread_io", thread_io), patch.object(store, "get_verified", read):
        payload = await bank_export.export_task_bank(detail, store, source=source)
    phases["actualExportWallMs"] = (time.perf_counter() - actual_started) * 1000
    try:
        output = inspect_archive(payload, detail, resources)
    finally:
        payload.close()
    return {"phases": phases, "threadOperations": thread_operations, "verifiedStorageReads": storage_reads,
            "serializedManifestBytes": len(manifest), "serializedQuestionsBytes": len(questions), "output": output,
            "method": "CPU phases reproduce the current baseline preparation sequence; actual export separately records joined thread wait and verified storage wall time. Instrumentation and prior phase work warm caches. These are localization clues, not paired performance samples."}


async def worker(source_root, case, localize):
    os.environ.update(AI_READ_ONLY="1", AI_SERVICE_TOKEN="synthetic-export-benchmark")
    from practiq_ai import bank_export

    assert Path(bank_export.__file__).resolve().is_relative_to(source_root)
    with TemporaryDirectory(prefix="practiq-export-profile-") as directory:
        store, source, detail, resources = await fixture(Path(directory), case)
        try:
            input_before = digest([source, detail])
            if localize:
                result = {"localization": await localization(store, source, detail, resources)}
            else:
                samples = [await measured_export(store, source, detail, resources) for _ in range(3)]
                assert len({sample["output"]["archiveSha256"] for sample in samples}) == 1
                assert all(sample["output"] == samples[0]["output"] for sample in samples)
                result = {"samples": samples, "firstMeasuredCall": samples[0], "warmSamples": samples[1:],
                          "warmMedianWallMs": statistics.median(sample["wallMs"] for sample in samples[1:]),
                          "warmMedianMaxStallMs": statistics.median(sample["maxEventLoopStallMs"] for sample in samples[1:]),
                          "output": samples[0]["output"]}
            input_after = digest([source, detail])
            assert input_before == input_after
        finally:
            store._executor.shutdown()
    paths = ["server/src/practiq_ai/bank_export.py", "server/src/practiq_ai/contracts.py",
             "server/src/practiq_ai/storage.py", "server/src/practiq_ai/extractors/isolated.py", "server/tests/support.py"]
    result.update({
        "case": case, "sourceRoot": str(source_root), "questions": 1000, "resourceCount": len(resources),
        "resourceBytes": sum(reference.sizeBytes for reference, _content in resources.values()),
        "sourceReference": source.model_dump(mode="json"), "inputSha256": input_before,
        "inputAfterSha256": input_after, "unchangedInputs": True, "realModelCalls": 0,
        "python": platform.python_version(), "executable": sys.executable, "platform": platform.platform(),
        "pythonOptimization": sys.flags.optimize, "pythonHashSeed": os.environ.get("PYTHONHASHSEED"),
        "dependencies": {name: importlib.metadata.version(name) for name in ("pydantic", "Pillow")},
        "sourceHashes": {path: hashlib.sha256((source_root / path).read_bytes()).hexdigest() for path in paths},
        "evidenceHarnessHashes": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                  for name in ("export_compare.py", "merge_compare.py")},
    })
    return result


def invoke(source, case, localize=False):
    command = [sys.executable, str(Path(__file__).resolve()), "--worker", "--source", str(source), "--case", case]
    if localize:
        command.append("--localize")
    environment = {**os.environ, "PYTHONPATH": os.pathsep.join([str(source / "server/src"), str(source / "server")]),
                   "PYTHONHASHSEED": "0", "PYTHONOPTIMIZE": "0", "AI_READ_ONLY": "1",
                   "AI_SERVICE_TOKEN": "synthetic-export-benchmark", "LLM_PROVIDER": "dashscope",
                   "LLM_API_KEY": "synthetic-export-benchmark", "LLM_MODEL": "synthetic"}
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
    parser.add_argument("--localize", action="store_true")
    args = parser.parse_args()
    if args.worker:
        if args.source is None or args.case is None:
            parser.error("--worker requires --source and --case")
        print(json.dumps(asyncio.run(worker(args.source.resolve(), args.case, args.localize)), indent=2))
        return
    if args.output is None or args.pairs < 5:
        parser.error("--output and at least five pairs are required")
    sources = {"baseline": args.baseline.resolve(), "candidate": args.candidate.resolve()}
    localization_results = {case: invoke(sources["baseline"], case, localize=True) for case in CASES}
    pairs = []
    for pair in range(args.pairs):
        order = ("baseline", "candidate") if pair % 2 == 0 else ("candidate", "baseline")
        for case in CASES:
            runs = {name: invoke(sources[name], case) for name in order}
            assert runs["baseline"]["inputSha256"] == runs["candidate"]["inputSha256"]
            assert runs["baseline"]["output"] == runs["candidate"]["output"]
            assert runs["baseline"]["output"] == localization_results[case]["localization"]["output"]
            pairs.append({"pair": pair + 1, "case": case, "order": list(order), "runs": runs})
    summary = {}
    for case in CASES:
        selected = [pair for pair in pairs if pair["case"] == case]
        summary[case] = {name: {
            "firstCallMedianWallMs": statistics.median(pair["runs"][name]["firstMeasuredCall"]["wallMs"] for pair in selected),
            "firstCallMedianMaxStallMs": statistics.median(pair["runs"][name]["firstMeasuredCall"]["maxEventLoopStallMs"] for pair in selected),
            "warmMedianWallMs": statistics.median(pair["runs"][name]["warmMedianWallMs"] for pair in selected),
            "warmMedianMaxStallMs": statistics.median(pair["runs"][name]["warmMedianMaxStallMs"] for pair in selected),
            "warmPairWallMediansMs": [pair["runs"][name]["warmMedianWallMs"] for pair in selected],
            "warmPairMaxStallMediansMs": [pair["runs"][name]["warmMedianMaxStallMs"] for pair in selected],
        } for name in sources}
        for field in ("warmMedianWallMs", "warmMedianMaxStallMs"):
            summary[case][f"pairedChangePercent_{field}"] = [
                100 * (pair["runs"]["candidate"][field] / pair["runs"]["baseline"][field] - 1)
                for pair in selected]
    report = {"method": "Five alternating AB/BA pairs per case by default, separate fresh sequential workers for each source/case, three complete export calls per worker, 1 ms heartbeat. First measured call separated from two warm calls; fixture creation, fsync writes and ZIP inspection are outside timed export. Storage source/image reads, checksums, image validation and private ZIP construction are inside timed export.",
              "limitations": "Real local ObjectStore and archive export only; excludes database snapshot lookup, account authorization, HTTP download/network and WebView. Fresh processes do not imply cold OS cache. Heartbeat reports scheduling gaps minus the 1 ms requested sleep; CPython GIL and timer scheduling can limit thread responsiveness. No real model calls or user data.",
              "pairsPerCase": args.pairs, "localization": localization_results, "pairs": pairs, "summary": summary}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
