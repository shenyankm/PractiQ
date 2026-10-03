"""Real fixture pixels and disposable checkpoint profile; all model responses are local fakes."""

import argparse
import asyncio
import hashlib
import json
import os
import sqlite3
import stat
import subprocess
import sys
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from statistics import median
from tempfile import TemporaryDirectory
from time import perf_counter
from typing import Any, cast
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

REPOSITORY = Path(__file__).resolve().parents[2]
ENVIRONMENT = {"AI_SERVICE_TOKEN": "synthetic-profile", "LLM_PROVIDER": "dashscope",
               "LLM_API_KEY": "synthetic-profile", "LLM_MODEL": "synthetic",
               "AI_PROVIDER_RPM": "100000", "AI_DESKTOP_MODE": "1", "AI_READ_ONLY": "0"}


def import_profile():
    script = """import json, resource, sys, time
from pathlib import Path
started = time.perf_counter()
if sys.argv[1] == 'before':
    import practiq_ai.extractors.csv, practiq_ai.extractors.image, practiq_ai.extractors.pdf
from practiq_ai.extractors import extract
extract(sys.argv[2], Path(sys.argv[3]).read_bytes())
print(json.dumps({'ms': (time.perf_counter()-started)*1000,
                  'rss': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                  'pdfiumLoaded': 'pypdfium2' in sys.modules}))
"""
    rows = []
    for kind, suffix in [("csv", "csv"), ("image", "png")]:
        fixture = REPOSITORY / "app/fixtures/ai-import/formats" / f"all-types.{suffix}"
        row: dict[str, Any] = {"kind": kind, "fixture": str(fixture.relative_to(REPOSITORY))}
        for mode in ("before", "after"):
            samples = [json.loads(subprocess.run([sys.executable, "-c", script, mode, kind, str(fixture)],
                        check=True, capture_output=True, text=True, env={**os.environ, **ENVIRONMENT}).stdout) for _ in range(3)]
            row[mode] = {"samples": samples, "medianMs": median(item["ms"] for item in samples),
                         "peakRssMedianBytes": median(item["rss"] for item in samples) * (1 if sys.platform == "darwin" else 1024)}
        rows.append(row)
    return rows


async def page_profile(fixture, root):
    from practiq_ai.config import load
    from practiq_ai.extractors import extract
    from practiq_ai.graphs import document, vision
    from practiq_ai.storage import ObjectStore

    payload = fixture.read_bytes()
    started = perf_counter()
    images = extract("pdf", payload).page_images
    render_ms = (perf_counter() - started) * 1000
    store = ObjectStore(replace(load(), storage_dir=root))
    refs = [await store.put_artifact(image, source_sha256=hashlib.sha256(payload).hexdigest(), kind="page", index=i,
                                   media_type="image/png") for i, image in enumerate(images)]
    sequence = [index for primary in range(len(refs)) for index in sorted(range(max(0, primary - 1), min(len(refs), primary + 2)), key=lambda i: i != primary)]
    row = {"fixture": str(fixture.relative_to(REPOSITORY)), "pages": len(refs), "pageBytes": sum(map(len, images)),
           "renderMs": render_ms, "inputPageOccurrences": len(sequence)}
    try:
        previous = None
        for mode in ("before", "after"):
            samples, reads, encodings = [], [], []
            for _ in range(3):
                with pytest.MonkeyPatch.context() as patch:
                    checked = AsyncMock(wraps=store.get_verified)
                    patch.setattr(store, "get_verified", checked)
                    calls = []
                    encode = vision._data_url
                    def observed(*args, calls=calls, encode=encode):
                        calls.append(1)
                        return encode(*args)
                    patch.setattr(vision, "_data_url", observed)
                    context, values = {}, []
                    started = perf_counter()
                    for index in sequence:
                        if mode == "before":
                            image = await store.get_verified(refs[index])
                            values.append(vision._data_url(image, "image/png"))
                        else:
                            values.append((await document._page_image(store, refs[index], context))[1])
                    samples.append((perf_counter() - started) * 1000)
                    reads.append(checked.await_count)
                    encodings.append(len(calls))
                    if previous is not None:
                        assert previous == values
                    previous = values
            row[mode] = {"samplesMs": samples, "medianMs": median(samples), "verifiedReads": reads,
                         "base64Encodings": encodings}
        row["identicalProviderImageInputs"] = True
        return row
    finally:
        store._executor.shutdown()


async def checkpoint_profile(pages, image, root):
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
    from langgraph.store.memory import InMemoryStore

    from practiq_ai.extractors import ExtractedDocument
    from practiq_ai.graphs import document
    from tests.support import FakeModel, question, source

    store, reference = source("Synthetic page-count stress source")
    responses = [{"questions": [question(f"Synthetic page {i} question {j}: " + "source material " * 80) for j in range(10)]} for i in range(pages)]
    model = FakeModel(responses=deepcopy(responses))
    config = {"configurable": {"thread_id": str(uuid4())}, "run_id": uuid4()}
    database = root / f"checkpoints-{pages}.sqlite"
    write_ms = []
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(document, "get_object_store", lambda: store)
        patch.setattr(document, "get_model", lambda: model)
        patch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[image] * pages)))
        async with AsyncSqliteSaver.from_conn_string(str(database)) as saver:
            original = saver.aput
            async def write(*args, **kwargs):
                started = perf_counter()
                result = await original(*args, **kwargs)
                write_ms.append((perf_counter() - started) * 1000)
                return result
            patch.setattr(saver, "aput", write)
            graph = document.build_document_graph(saver, store=InMemoryStore())
            started = perf_counter()
            result = await graph.ainvoke({"document": reference}, cast(Any, config), context=cast(Any, {"profile": True}), durability="sync")
            elapsed = (perf_counter() - started) * 1000
            assert result["status"] == "SUCCEEDED" and len(result["result"]["questions"]) == 10 * pages
        calls = len(model.calls)
        async with AsyncSqliteSaver.from_conn_string(str(database)) as reopened:
            graph = document.build_document_graph(reopened, store=InMemoryStore())
            started = perf_counter()
            replay = await graph.ainvoke(None, cast(Any, config), context=cast(Any, {"profile": True}), durability="sync")
            reopen_ms = (perf_counter() - started) * 1000
            assert replay == result and len(model.calls) == calls
    with sqlite3.connect(database) as connection:
        checkpoint_bytes, count = connection.execute("SELECT sum(length(checkpoint)),count(*) FROM checkpoints").fetchone()
        writes_bytes = connection.execute("SELECT coalesce(sum(length(value)),0) FROM writes").fetchone()[0]
    return {"pages": pages, "syntheticQuestions": 10 * pages, "elapsedMs": elapsed, "checkpointRows": count,
            "checkpointBytes": checkpoint_bytes, "pendingWriteBytes": writes_bytes,
            "checkpointWriteWaitTotalMs": sum(write_ms), "checkpointWriteWaitMaxMs": max(write_ms),
            "reopenedCompletedReplayMs": reopen_ms, "identicalReplayedOutput": True, "replayAddedModelCalls": 0}


async def fsync_profile(root):
    from practiq_ai.config import load
    from practiq_ai.storage import ObjectStore

    store = ObjectStore(replace(load(), storage_dir=root))
    rows, calls = [], []
    original = os.fsync
    def observed(fd):
        calls.append("directory" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file")
        return original(fd)
    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(os, "fsync", observed)
            for index in range(2):
                calls.clear()
                await store.put_artifact(b"durability profile", source_sha256="a" * 64, kind="page", index=index, media_type="text/plain")
                rows.append({"index": index, "fileFsync": calls.count("file"), "directoryFsync": calls.count("directory")})
        return rows
    finally:
        store._executor.shutdown()


async def profile():
    from practiq_ai.graphs.document import PageParseResult
    from practiq_ai.llm import _model_schema

    schema = {"before": [], "after": []}
    for mode, run in [("before", _model_schema.__wrapped__), ("after", lambda cls: deepcopy(_model_schema(cls)))]:
        for _ in range(3):
            started = perf_counter()
            for _ in range(100):
                run(PageParseResult)
            schema[mode].append((perf_counter() - started) * 10)
    fixtures = [REPOSITORY / path for path in ["server/evals/fixtures/pdf/text-layer.pdf", "server/evals/fixtures/pdf/scanned.pdf",
                "server/evals/fixtures/pdf/long-material-answer-key.pdf", "app/fixtures/rich-content/merged-cross-page.pdf"]]
    with TemporaryDirectory(prefix="practiq-pipeline-profile-") as directory:
        root = Path(directory)
        pages = [await page_profile(path, root) for path in fixtures]
        from practiq_ai.extractors import extract
        image = extract("pdf", fixtures[0].read_bytes()).page_images[0]
        checkpoints = [await checkpoint_profile(count, image, root) for count in (20, 100)]
        synchronization = await fsync_profile(root / "synchronization")
    return {"method": "Three sequential samples, warm OS file cache; real repository PDF pixels; synthetic parsing responses for checkpoint stress. No provider calls, OCR-quality claims, IPC or WebView measurement.",
            "imports": import_profile(), "schemaPerCallMs": schema, "pages": pages, "checkpoints": checkpoints, "artifactFsync": synchronization,
            "realModelCalls": 0, "fsyncOptimization": "Deferred: retain file and ancestor fsync until crash durability is independently proven."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    with pytest.MonkeyPatch.context() as patch:
        for key, value in ENVIRONMENT.items():
            patch.setenv(key, value)
        report = asyncio.run(profile())
    content = json.dumps(report, indent=2) + "\n"
    args.output.write_text(content)
    print(content, end="")


if __name__ == "__main__":
    main()
