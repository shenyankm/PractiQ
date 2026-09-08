"""Capacity check for a running standalone Agent Server."""

import argparse
import asyncio
import hashlib
import json
import os
import re
import statistics
import subprocess
import time
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

ROOT = Path(__file__).parents[1]
TERMINAL = {"success", "error", "interrupted", "timeout"}
METRIC_PATTERN = re.compile(
    r"^(lg_api_(?:num_pending_runs|num_running_runs|workers_(?:active|available|max)))"
    r"(?:\{[^}]*\})?\s+([0-9.eE+-]+)$",
    re.MULTILINE,
)


def percentile(values: list[float], percentile_value: int) -> float:
    if len(values) < 2:
        return values[0] if values else 0
    return statistics.quantiles(values, n=100, method="inclusive")[
        percentile_value - 1
    ]


def rss_bytes(pid: int | None) -> int:
    if pid is None:
        return 0
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
        metrics = await client.get("/metrics")
        metrics.raise_for_status()
        for name, value in METRIC_PATTERN.findall(metrics.text):
            samples.setdefault(name, []).append(float(value))
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
) -> tuple[str, str]:
    async with semaphore:
        thread_id = str(uuid4())
        thread = await client.post(
            "/threads",
            json={
                "thread_id": thread_id,
                "metadata": {"sessionId": f"load-{index}"},
            },
        )
        thread.raise_for_status()
        started = time.perf_counter()
        run = await client.post(
            f"/threads/{thread_id}/runs",
            json={
                "assistant_id": "document_parser",
                "input": graph_input,
                "durability": "sync",
                "multitask_strategy": "enqueue",
            },
        )
        run.raise_for_status()
        latencies.append(time.perf_counter() - started)
        return thread_id, run.json()["run_id"]


async def wait_for_run(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    thread_id: str,
    run_id: str,
    deadline: float,
) -> str:
    while time.monotonic() < deadline:
        async with semaphore:
            response = await client.get(f"/threads/{thread_id}/runs/{run_id}")
        response.raise_for_status()
        status = response.json()["status"]
        if status in TERMINAL:
            return status
        await asyncio.sleep(0.5)
    return "client_timeout"


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
                async with httpx.AsyncClient(timeout=timeout) as upload_client:
                    put = await upload_client.put(
                        prepared["upload"]["url"],
                        headers=prepared["upload"]["headers"],
                        content=payload,
                    )
                    put.raise_for_status()
            graph_input = {"document": prepared["document"]}
        monitor_task = asyncio.create_task(
            monitor(client, done, health_latencies, samples, args.pid)
        )
        semaphore = asyncio.Semaphore(args.submit_concurrency)
        runs = await asyncio.gather(
            *(
                submit(
                    client,
                    semaphore,
                    graph_input,
                    index,
                    create_latencies,
                )
                for index in range(args.total)
            )
        )
        if len({run_id for _, run_id in runs}) != len(runs):
            raise AssertionError("duplicate run IDs")
        deadline = time.monotonic() + args.completion_timeout
        poll_semaphore = asyncio.Semaphore(args.submit_concurrency)
        statuses = await asyncio.gather(
            *(
                wait_for_run(client, poll_semaphore, thread_id, run_id, deadline)
                for thread_id, run_id in runs
            )
        )
        done.set()
        await monitor_task

    summary = {
        "runs": dict(Counter(statuses)),
        "runCreateP95Ms": round(percentile(create_latencies, 95) * 1_000, 1),
        "healthP95Ms": round(percentile(health_latencies, 95) * 1_000, 1),
        "peakPendingRuns": (
            max(samples["lg_api_num_pending_runs"])
            if "lg_api_num_pending_runs" in samples
            else None
        ),
        "peakRunningRuns": max(
            samples.get("lg_api_num_running_runs", samples.get("lg_api_workers_active", [0]))
        ),
        "observedWorkerMaximum": max(samples.get("lg_api_workers_max", [0])),
        "minimumAvailableWorkers": min(
            samples.get("lg_api_workers_available", [args.max_running])
        ),
        "peakRssBytes": int(max(samples.get("rss_bytes", [0]))),
        "configuredModelConcurrencyCeiling": (
            args.max_running * args.graph_concurrency
        ),
    }
    failures = []
    if Counter(statuses) != Counter({"success": args.total}):
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
        "environment": "local-langgraph-dev",
        "parameters": {
            "total": args.total,
            "submitConcurrency": args.submit_concurrency,
            "maxRunning": args.max_running,
            "graphConcurrency": args.graph_concurrency,
        },
        "results": summary,
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
    parser.add_argument("--submit-concurrency", type=int, default=100)
    parser.add_argument("--max-running", type=int, default=8)
    parser.add_argument("--graph-concurrency", type=int, default=2)
    parser.add_argument("--request-timeout", type=float, default=30)
    parser.add_argument("--completion-timeout", type=float, default=1_800)
    parser.add_argument("--pid", type=int)
    args = parser.parse_args()
    if not args.token:
        parser.error("--token or AI_SERVICE_TOKEN is required")
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
