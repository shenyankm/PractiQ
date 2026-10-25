"""Paired synthetic runtime probes; never opens user state or calls providers."""

import argparse
import asyncio
import hashlib
import json
import os
import platform
import random
import statistics
import subprocess
import sys
import time
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, patch
from zipfile import ZipFile

from langgraph.store.memory import InMemoryStore
from PIL import Image, ImageDraw

from practiq_ai import bank_export, tencent, tencent_inputs
from practiq_ai.config import load
from practiq_ai.contracts import DocumentReference, ParsedQuestion
from practiq_ai.graphs import document

ROOT = Path(__file__).resolve().parents[2]


def historical(ref: str, path: str, package: str) -> ModuleType:
    source = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=ROOT, check=True, capture_output=True).stdout
    name = f"{package}._benchmark_baseline_{Path(path).stem}"
    module = ModuleType(name)
    module.__package__ = package
    module.__file__ = str(ROOT / path)
    sys.modules[name] = module
    exec(compile(source, module.__file__, "exec"), module.__dict__)  # noqa: S102 - explicit trusted local Git baseline only
    return module


def summary(samples: list[float]) -> dict[str, Any]:
    return {"samplesMs": samples, "medianMs": statistics.median(samples)}


async def retained(module: Any, size: int, cos: bool) -> dict[str, int]:
    payload = b"x" * size
    reference = DocumentReference(sourceType="image", mediaType="image/png", objectKey="synthetic",
                                  sha256=hashlib.sha256(payload).hexdigest(), sizeBytes=size)
    runtime = SimpleNamespace(store=InMemoryStore(), execution_info=SimpleNamespace(thread_id="benchmark", run_id="run"))
    config = replace(load(), tencent_cos_enabled=cos, tencent_cos_bucket="fixture-1250000000", tencent_cos_region="ap-guangzhou")
    entered = asyncio.Event()

    async def request(action, _data, _config):
        if action.startswith("Submit"):
            return {"TaskId": "synthetic-task"}
        entered.set()
        await asyncio.Event().wait()

    async def read(_runtime, _stage, operation):
        return await operation()

    with (patch.object(module, "load", return_value=config), patch.object(module, "request", request),
          patch.object(module, "get_object_store", return_value=SimpleNamespace(get_verified=AsyncMock(return_value=payload))),
          patch.object(module, "guard", AsyncMock()), patch.object(module, "run_remaining", AsyncMock(return_value=60)),
          patch.object(module, "_read", read), patch.object(module, "upload_source", AsyncMock()),
          patch.object(module, "source_url", return_value="https://synthetic.invalid/")):
        task = asyncio.create_task(module._parse_job(reference, runtime, key="source", source_type="image", source_sha256=reference.sha256))
        try:
            await asyncio.wait_for(entered.wait(), 5)
            values = cast(Any, task.get_coro()).cr_frame.f_locals
            return {"sourceBytes": len(values.get("payload", b"")), "base64Chars": len(values.get("data", {}).get("FileBase64", ""))}
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def merge_samples(module: Any, state: dict[str, Any]) -> dict[str, Any]:
    times, gaps, proof_calls = [], [], []
    expected = None
    original = module.find_source_duplicate_question_trees
    for sample in range(8):
        stopped = asyncio.Event()
        intervals: list[float] = []
        calls = 0

        async def heartbeat(stopped=stopped, intervals=intervals):
            last = time.perf_counter()
            while not stopped.is_set():
                await asyncio.sleep(.001)
                now = time.perf_counter()
                intervals.append((now - last) * 1000)
                last = now

        def source_duplicates(*args, **kwargs):
            nonlocal calls
            calls += 1
            return original(*args, **kwargs)

        ticker = asyncio.create_task(heartbeat())
        await asyncio.sleep(.005)
        try:
            with patch.object(module, "find_source_duplicate_question_trees", source_duplicates):
                start = time.perf_counter()
                result = await module._merge(state, passive=True)
                elapsed = (time.perf_counter() - start) * 1000
            await asyncio.sleep(.005)
        finally:
            stopped.set()
            await ticker
        assert len(result["result"]["questions"]) == 1000
        digest = hashlib.sha256(json.dumps(result, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if expected is not None:
            assert expected == digest
        expected = digest
        if sample:
            times.append(elapsed)
            gaps.append(max(intervals))
            proof_calls.append(calls)
    return {**summary(times), "maximumHeartbeatGap": summary(gaps), "sourceProofCalls": proof_calls, "outputSha256": expected}


def png_samples(module: Any, payload: bytes) -> dict[str, Any]:
    times = []
    parts = module.split_image(payload, 8 * 1024 * 1024, 100)
    for _ in range(7):
        start = time.perf_counter()
        parts = module.split_image(payload, 8 * 1024 * 1024, 100)
        elapsed = (time.perf_counter() - start) * 1000
        assert len(parts) == 1 and parts[0][2] == (0, 0, 1654, 2339)
        times.append(elapsed)
    with Image.open(BytesIO(payload)) as original, Image.open(BytesIO(parts[0][0])) as result:
        assert result.tobytes() == original.tobytes()
    return {**summary(times), "outputBytes": len(parts[0][0]), "reusesSourceObject": parts[0][0] is payload}


def zip_samples(module: Any, payload: bytes, *, current: bool) -> dict[str, Any]:
    times = []
    output = BytesIO()
    for sample in range(8):
        output = BytesIO()
        start = time.perf_counter()
        with ZipFile(output, "w") as archive:
            args = ("image/jpeg",) if current else ()
            module._write_entry(archive, output, "resource.jpg", payload, *args)
        elapsed = (time.perf_counter() - start) * 1000
        if sample:
            times.append(elapsed)
    with ZipFile(output) as archive:
        assert archive.read("resource.jpg") == payload
    return {**summary(times), "archiveBytes": len(output.getvalue())}


async def run(ref: str) -> dict[str, Any]:
    base_document = historical(ref, "server/src/practiq_ai/graphs/document.py", "practiq_ai.graphs")
    base_tencent = historical(ref, "server/src/practiq_ai/tencent.py", "practiq_ai")
    base_inputs = historical(ref, "server/src/practiq_ai/tencent_inputs.py", "practiq_ai")
    base_export = historical(ref, "server/src/practiq_ai/bank_export.py", "practiq_ai")
    report: dict[str, Any] = {"baselineRef": ref, "python": platform.python_version(),
        "method": "Synthetic in-process probes, one warmup and seven serial timing samples. No real storage, rendering, providers, database or WebView. Retention counts frame-owned buffers, not RSS; ZIP timing covers compression only."}
    report["retention"] = []
    for size, cos in [(8 * 1024 * 1024, False), (25 * 1024 * 1024, True)]:
        before, after = await retained(base_tencent, size, cos), await retained(tencent, size, cos)
        assert before["sourceBytes"] == size and after == {"sourceBytes": 0, "base64Chars": 0}
        report["retention"].append({"inputBytes": size, "cos": cos, "before": before, "after": after})
    page = {"objectKey": "unused", "sha256": "b" * 64, "sizeBytes": 1, "mediaType": "image/png"}
    units = []
    for number in range(100):
        questions = [ParsedQuestion(id=f"q{number}_{i}", stem=f"Question {number}_{i} " + "x" * 2000,
            sourceText=f"{number}_{i}. supplied source", answerMode="short_answer", answerPayload={"text": "reference"}).model_dump(mode="json") for i in range(10)]
        units.append({"kind": "page", "index": number, "artifact": page, "parsed": {"questions": questions, "groups": []}, "visuals": []})
    state = {"document": {"sha256": "a" * 64, "sourceType": "pdf"}, "pageRefs": [page] * 100, "visionResults": units, "visualTotal": 100}
    files = SimpleNamespace()
    with patch.object(base_document, "get_object_store", return_value=files), patch.object(document, "get_object_store", return_value=files):
        before = await merge_samples(base_document, state)
        after = await merge_samples(document, state)
    assert before["outputSha256"] == after["outputSha256"]
    assert before["sourceProofCalls"] == [1] * 7 and after["sourceProofCalls"] == [0] * 7
    report["merge100Pages1000Questions"] = {"before": before, "after": after}
    with Image.new("RGB", (1654, 2339), "white") as image:
        draw = ImageDraw.Draw(image)
        for y in range(20, 2300, 26):
            draw.text((30, y), f"Example document line {y}. A B C D. Question and supplied reference answer.", fill="black")
        output = BytesIO()
        image.save(output, format="PNG", compress_level=3)
    png = output.getvalue()
    report["boundedPng"] = {"inputBytes": len(png), "before": png_samples(base_inputs, png), "after": png_samples(tencent_inputs, png)}
    with Image.frombytes("RGB", (1400, 1800), random.Random(7).randbytes(1400 * 1800 * 3)) as image:
        output = BytesIO()
        image.save(output, format="JPEG")
    jpeg = output.getvalue()
    report["jpegZip"] = {"inputBytes": len(jpeg), "before": zip_samples(base_export, jpeg, current=False), "after": zip_samples(bank_export, jpeg, current=True)}
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-ref", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    settings = {"AI_READ_ONLY": "1", "AI_SERVICE_TOKEN": "synthetic-benchmark-token", "AI_TENCENT_SECRET_ID": "synthetic-id",
                "AI_TENCENT_SECRET_KEY": "synthetic-key", "AI_TENCENT_COS_ENABLED": "false", "AI_TENCENT_COS_BUCKET": "", "AI_TENCENT_COS_REGION": ""}
    with patch.dict(os.environ, settings):
        report = asyncio.run(run(args.baseline_ref))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
