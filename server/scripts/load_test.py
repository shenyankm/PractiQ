"""Capacity check for a running open-source document service."""

import argparse
import asyncio
import hashlib
import json
import os
import re
import statistics
import subprocess
import sys
import time
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from practiq_ai.execution import code_version, runtime_version

ROOT = Path(__file__).parents[1]
TERMINAL = {"success", "error", "interrupted", "timeout"}
METRIC_PATTERN = re.compile(r"^(practiq_(?:pending_runs|running_runs|workers_max|workers_available))\s+([0-9.eE+-]+)$", re.MULTILINE)


def percentile(values: list[float], percentile_value: int) -> float:
    if len(values) < 2:
        return values[0] if values else 0
    return statistics.quantiles(values, n=100, method="inclusive")[
        percentile_value - 1
    ]


def rss_bytes(pid: int | None) -> int:
    if pid is None:
        return 0
    if sys.platform == "darwin":
        return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(pid)], text=True).strip()) * 1024
    status = Path(f"/proc/{pid}/status").read_text()
    match = re.search(r"^VmRSS:\s+(\d+)\s+kB$", status, re.MULTILINE)
    return int(match.group(1)) * 1024 if match else 0


async def monitor(
    client: httpx.AsyncClient,
    done: asyncio.Event,
    health_latencies: list[float],
    samples: dict[str, list[float]],
    pid: int | None,
) -> None:
    while not done.is_set():
        started = time.perf_counter()
        response = await client.get("/ok")
        response.raise_for_status()
        health_latencies.append(time.perf_counter() - started)
        metrics = await client.get("/api/metrics")
        metrics.raise_for_status()
        for name, value in METRIC_PATTERN.findall(metrics.text):
            samples.setdefault(name, []).append(float(value))
        application = metrics
        application.raise_for_status()
        for value in re.findall(r"^practiq_provider_inflight\s+([0-9.eE+-]+)$", application.text, re.MULTILINE):
            samples.setdefault("provider_inflight", []).append(float(value))
        samples.setdefault("rss_bytes", []).append(float(rss_bytes(pid)))
        try:
            await asyncio.wait_for(done.wait(), timeout=0.2)
        except TimeoutError:
            pass


async def submit(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    graph_input: dict[str, Any],
    index: int,
    latencies: list[float],
    api: str = "document-tasks",
) -> tuple[str, str, float]:
    async with semaphore:
        started = time.perf_counter()
        response = await client.post("/api/document-tasks", json={"requestId": str(uuid4()), **graph_input})
        latencies.append(time.perf_counter() - started)
        if response.status_code in {429, 503}:
            return "", f"rejected_{response.status_code}", started
        response.raise_for_status()
        value = response.json()
        return value["threadId"], value["runId"], started


async def wait_for_run(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    thread_id: str,
    run_id: str,
    deadline: float,
    submitted: float,
    api: str = "document-tasks",
) -> tuple[str, float, float | None]:
    queue_wait = None
    if not thread_id:
        return run_id, 0, None
    while time.monotonic() < deadline:
        async with semaphore:
            response = await client.get(f"/api/document-tasks/{thread_id}")
        response.raise_for_status()
        value = response.json()
        if value["phase"] != "pending" and queue_wait is None:
            queue_wait = time.perf_counter() - submitted
        status = {"COMPLETED": "success" if value["status"] == "SUCCEEDED" else "partial",
                  "FAILED": "error", "INTERRUPTED": "interrupted",
                  "WAITING_REVIEW": "interrupted", "PAUSED": "interrupted"}.get(value["state"], "pending")
        if status in TERMINAL:
            return status, time.perf_counter() - submitted, queue_wait
        if status == "partial":
            return status, time.perf_counter() - submitted, queue_wait
        await asyncio.sleep(0.5)
    return "client_timeout", time.perf_counter() - submitted, queue_wait


async def run(args: argparse.Namespace) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {args.token}"}
    limits = httpx.Limits(
        max_connections=args.submit_concurrency + 20,
        max_keepalive_connections=args.submit_concurrency,
    )
    timeout = httpx.Timeout(args.request_timeout)
    create_latencies: list[float] = []
    health_latencies: list[float] = []
    samples: dict[str, list[float]] = {}
    done = asyncio.Event()
    async with httpx.AsyncClient(
        base_url=args.base_url.rstrip("/"),
        headers=headers,
        limits=limits,
        timeout=timeout,
        trust_env=urlsplit(args.base_url).hostname not in {"localhost", "127.0.0.1", "::1"},
    ) as client:
        if args.input:
            graph_input = json.loads(args.input.read_text())
        else:
            payload = args.text.encode("utf-8")
            upload = await client.post(
                "/api/uploads",
                json={
                    "sourceType": "text",
                    "fileName": "load-test.txt",
                    "mediaType": "text/plain",
                    "sizeBytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                },
            )
            upload.raise_for_status()
            prepared = upload.json()
            if prepared["upload"]:
                put = await client.put(prepared["upload"]["url"], headers=prepared["upload"]["headers"], content=payload)
                put.raise_for_status()
            graph_input = {"document": prepared["document"]}
        monitor_task = asyncio.create_task(
            monitor(client, done, health_latencies, samples, args.pid)
        )
        started = time.perf_counter()
        try:
            semaphore = asyncio.Semaphore(args.submit_concurrency)
            poll_semaphore = asyncio.Semaphore(args.submit_concurrency)

            async def submit_and_wait(index):
                run = await submit(client, semaphore, graph_input, index, create_latencies, args.api)
                thread_id, run_id, submitted = run
                timing = await wait_for_run(client, poll_semaphore, thread_id, run_id,
                                           time.monotonic() + args.completion_timeout, submitted, args.api)
                return run, timing

            completed = await asyncio.gather(*(submit_and_wait(index) for index in range(args.total)))
            runs = [item[0] for item in completed]
            timings = [item[1] for item in completed]
            accepted = [item for item in runs if item[0]]
            if len({run_id for _, run_id, _ in accepted}) != len(accepted):
                raise AssertionError("duplicate run IDs")
            elapsed = time.perf_counter() - started
        finally:
            done.set()
            await monitor_task

    statuses = [item[0] for item in timings]
    completions = [item[1] for item in timings if item[1]]
    queue_waits = [item[2] for item in timings if item[2] is not None]
    summary = {
        "runs": dict(Counter(statuses)),
        "batchSeconds": round(elapsed, 3),
        "successfulDocumentsPerMinute": round(statuses.count("success") * 60 / elapsed, 3),
        "runCreateP95Ms": round(percentile(create_latencies, 95) * 1_000, 1),
        "healthP95Ms": round(percentile(health_latencies, 95) * 1_000, 1),
        "completionP50Seconds": round(percentile(completions, 50), 3),
        "completionP95Seconds": round(percentile(completions, 95), 3),
        "observedQueueWaitP95Seconds": round(percentile(queue_waits, 95), 3) if queue_waits else None,
        "peakPendingRuns": (
            max(samples["practiq_pending_runs"])
            if "practiq_pending_runs" in samples
            else None
        ),
        "peakRunningRuns": max(
            samples.get("practiq_running_runs", samples.get("practiq_running_runs", [0]))
        ),
        "observedWorkerMaximum": max(samples.get("practiq_workers_max", [0])),
        "minimumAvailableWorkers": min(
            samples.get("practiq_workers_available", [args.max_running])
        ),
        "peakRssBytes": int(max(samples.get("rss_bytes", [0]))),
        "sampledProviderConcurrencyPeak": max(samples.get("provider_inflight", [0])),
        "configuredModelConcurrencyCeiling": (
            args.max_running * args.graph_concurrency
        ),
    }
    failures = []
    passed = {"success", "rejected_429", "rejected_503"} if args.allow_rejections else {"success"}
    if not statuses or "success" not in statuses or any(status not in passed for status in statuses):
        failures.append(f"not all runs succeeded: {summary['runs']}")
    if summary["runCreateP95Ms"] > 1_000:
        failures.append("run creation P95 exceeded 1 second")
    if summary["healthP95Ms"] > 200:
        failures.append("/ok P95 exceeded 200 ms")
    if summary["peakRunningRuns"] > args.max_running:
        failures.append("active run limit was exceeded")
    if summary["configuredModelConcurrencyCeiling"] > 16:
        failures.append("configured model concurrency exceeds 16")
    if args.pid and summary["peakRssBytes"] >= int(12.8 * 1024**3):
        failures.append("RSS reached 80% of 16 GB")
    return {
        "schemaVersion": 1,
        "status": "FAILED" if failures else "PASSED",
        "generatedAt": datetime.now(UTC).isoformat(),
        "gitCommit": (
            await asyncio.to_thread(
                subprocess.check_output,
                ["git", "rev-parse", "HEAD"],
                cwd=ROOT,
                text=True,
            )
        ).strip(),
        "environment": args.environment,
        "codeHash": code_version(),
        "runtime": runtime_version(),
        "imageDigest": args.image_digest,
        "parameters": {
            "total": args.total,
            "submitConcurrency": args.submit_concurrency,
            "maxRunning": args.max_running,
            "graphConcurrency": args.graph_concurrency,
            "api": args.api,
            "allowRejections": args.allow_rejections,
        },
        "results": summary,
        "runs": [{"threadId": run[0], "runId": run[1], "status": timing[0]}
                 for run, timing in zip(runs, timings, strict=True)],
        "failures": failures,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--token", default=os.getenv("AI_SERVICE_TOKEN"))
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path)
    source.add_argument("--text")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--total", type=int, default=400)
    parser.add_argument("--api", choices=("document-tasks",), default="document-tasks")
    parser.add_argument("--allow-rejections", action="store_true", help="Overload drill: count explicit 429/503 as bounded admission, but require successful work")
    parser.add_argument("--environment", choices=("oss-local", "oss-container"), default="oss-local")
    parser.add_argument("--image-digest")
    parser.add_argument("--submit-concurrency", type=int, default=100)
    parser.add_argument("--max-running", type=int, default=8)
    parser.add_argument("--graph-concurrency", type=int, default=2)
    parser.add_argument("--request-timeout", type=float, default=30)
    parser.add_argument("--completion-timeout", type=float, default=1_800)
    parser.add_argument("--pid", type=int)
    args = parser.parse_args()
    if not args.token:
        parser.error("--token or AI_SERVICE_TOKEN is required")
    if args.environment == "oss-container" and not args.image_digest:
        parser.error("container evidence requires --image-digest")
    if min(args.total, args.submit_concurrency, args.max_running, args.graph_concurrency, args.request_timeout, args.completion_timeout) <= 0:
        parser.error("capacity parameters must be positive")
    if args.output and args.output.exists():
        parser.error("refusing to overwrite an existing report")
    return args


def main() -> int:
    args = parse_args()
    report = asyncio.run(run(args))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return report["status"] != "PASSED"


if __name__ == "__main__":
    raise SystemExit(main())
