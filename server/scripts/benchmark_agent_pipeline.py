"""Compare bounded storage and outbox scheduling against an explicit Git baseline."""

import argparse
import asyncio
import hashlib
import json
import platform
import subprocess
import tracemalloc
from contextlib import asynccontextmanager
from pathlib import Path
from statistics import median
from time import perf_counter
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from benchmark_web_server import ROOT, baseline_function, digest

from practiq_ai import capacity, messaging
from practiq_ai.graphs import document


async def storage_sample(function, count, *, memory=False):
    existing = asyncio.all_tasks()
    tasks = 0

    async def work(index):
        nonlocal tasks
        if index == 0:
            tasks = len(asyncio.all_tasks() - existing)
        await asyncio.sleep(0)
        return None if index % 2 else index

    items = list(range(count))
    if memory:
        tracemalloc.start()
    try:
        started = perf_counter()
        result = await function(items, work)
        elapsed = (perf_counter() - started) * 1000
        peak = tracemalloc.get_traced_memory()[1] if memory else None
    finally:
        if memory:
            tracemalloc.stop()
    assert result == [None if index % 2 else index for index in items]
    return {"ms": elapsed, "workerTasks": tasks, "peakTracedBytes": peak, "outputSha256": digest(result)}


async def storage_profile(before, count):
    samples = {label: [] for label in ("before", "after")}
    functions = {"before": before, "after": capacity.bounded_map}
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("AI_READ_ONLY", "1")
        patch.setenv("AI_SERVICE_TOKEN", "synthetic-benchmark")
        patch.setenv("AI_STORAGE_CONCURRENCY", "4")
        for pair in range(3):
            for label in (("before", "after") if pair % 2 == 0 else ("after", "before")):
                for iteration in range(8):
                    row = await storage_sample(functions[label], count)
                    if iteration:
                        samples[label].append(row)
        report = {label: {"samplesMs": [row["ms"] for row in rows],
                          "medianMs": median(row["ms"] for row in rows),
                          "workerTasks": rows[0]["workerTasks"], "outputSha256": rows[0]["outputSha256"],
                          "peakTracedBytes": (await storage_sample(functions[label], count, memory=True))["peakTracedBytes"]}
                  for label, rows in samples.items()}
    assert len({row["outputSha256"] for rows in samples.values() for row in rows}) == 1
    return {"items": count, "concurrency": 4, **report,
            "reductionPercent": 100 * (1 - report["after"]["medianMs"] / report["before"]["medianMs"])}


async def dispatch_sample(module):
    @asynccontextmanager
    async def connection():
        yield SimpleNamespace(execute=AsyncMock())

    batches = [[{"run_id": f"synthetic-{batch}-{index}", "created_at": batch} for index in range(size)]
               for batch, size in enumerate((100, 100, 1))]
    service = SimpleNamespace(stopping=False, active={}, wake=asyncio.Event(),
                              db=SimpleNamespace(rows=AsyncMock(side_effect=batches), connection=connection))
    channel = SimpleNamespace(is_closed=False, get_underlay_channel=AsyncMock(
        return_value=SimpleNamespace(on_consumer_cancel_callbacks=set())))
    broker = SimpleNamespace(is_closed=False, channel=AsyncMock(return_value=channel), close=AsyncMock())
    queue = SimpleNamespace(consume=AsyncMock(), cancel=AsyncMock())
    delivery = module.Delivery(service)
    published, gaps = [], []

    async def publish(_channel, run_id):
        published.append(run_id)

    async def wait(seconds):
        if len(published) == 201:
            service.stopping = True
        else:
            gaps.append(seconds)
            await asyncio.sleep(seconds)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(module, "load", lambda: SimpleNamespace(read_only=False))
        patch.setattr(module, "rabbitmq_uri", lambda: "amqp://localhost/synthetic")
        patch.setattr(module.aio_pika, "connect", AsyncMock(return_value=broker))
        patch.setattr(module, "topology", AsyncMock(return_value=queue))
        patch.setattr(module, "publish", publish)
        patch.setattr(delivery, "wait", wait)
        started = perf_counter()
        await asyncio.wait_for(delivery.run(), 5)
        elapsed = (perf_counter() - started) * 1000
    assert published == [row["run_id"] for batch in batches for row in batch]
    return {"ms": elapsed, "idleWaitsWithBacklog": gaps, "published": len(published), "outputSha256": digest(published)}


async def profile(baseline):
    before_map = await asyncio.to_thread(baseline_function, baseline, document, "_bounded_map")
    path = "server/src/practiq_ai/messaging.py"
    source = await asyncio.to_thread(subprocess.check_output, ["git", "show", f"{baseline}:{path}"], cwd=ROOT, text=True)
    before = ModuleType("practiq_ai._baseline_messaging")
    exec(compile(source, path, "exec"), vars(before))  # noqa: S102 - explicitly selected local Git source
    storage = [await storage_profile(before_map, count) for count in (20, 1000, 10_000)]
    dispatch = {label: [] for label in ("before", "after")}
    for pair in range(3):
        for label in (("before", "after") if pair % 2 == 0 else ("after", "before")):
            dispatch[label].append(await dispatch_sample(before if label == "before" else messaging))
    assert len({row["outputSha256"] for rows in dispatch.values() for row in rows}) == 1
    return {"storage": storage, "outbox": {label: {"runs": rows, "medianMs": median(row["ms"] for row in rows)}
                                           for label, rows in dispatch.items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    baseline = subprocess.check_output(["git", "rev-parse", args.baseline], cwd=ROOT, text=True).strip()
    paths = [Path(__file__), *(ROOT / "server/src/practiq_ai" / name for name in (
        "capacity.py", "messaging.py", "runtime.py", "llm.py", "execution.py", "task_api.py", "graphs/document.py"))]
    report = {"baseline": baseline, "python": platform.python_version(), "platform": platform.platform(),
              "scope": "Synthetic local storage I/O and mocked broker/DB. Storage: three alternating pairs, one warmup plus seven samples per pair, GC enabled; one separate instrumented tracemalloc run per variant. Outbox: three alternating pairs, 201 messages in three pages, preserving real polling sleeps. No model, production or actual fsync latency claim; 10000 items is a stress case.",
              "sourceSha256": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths},
              **asyncio.run(profile(baseline))}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"storage": [{"items": row["items"], "reductionPercent": row["reductionPercent"]} for row in report["storage"]],
                      "outboxMedianMs": {label: row["medianMs"] for label, row in report["outbox"].items()}}))


if __name__ == "__main__":
    main()
