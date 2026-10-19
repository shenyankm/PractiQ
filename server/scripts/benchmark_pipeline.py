"""Real fixture pixels and disposable checkpoint profile; all model responses are local fakes."""

import argparse
import asyncio
import json
import os
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
               "AI_PROVIDER_RPM": "100000", "AI_READ_ONLY": "0"}


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


async def checkpoint_profile(pages, image, root):
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from langgraph.store.memory import InMemoryStore

    from practiq_ai.extractors import ExtractedDocument
    from practiq_ai.graphs import document
    from tests.db_support import cleanup, new_database
    from tests.support import FakeModel, ocr_draft, question, source, tencent_pages

    store, reference = source("Synthetic page-count stress source")
    responses = [{"questions": [question(f"Synthetic page {i} question {j}: " + "source material " * 80) for j in range(10)]} for i in range(pages)]
    model = FakeModel(responses=[ocr_draft(row) for row in deepcopy(responses)])
    config = {"configurable": {"thread_id": str(uuid4())}, "run_id": uuid4()}
    database = await new_database()
    try:
        write_ms = []
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(document, "get_object_store", lambda: store)
            patch.setattr(document, "get_model", lambda: model)
            tencent_pages(patch, reference, pages)
            patch.setattr(document, "extract", AsyncMock(return_value=ExtractedDocument(text="", page_images=[image] * pages)))
            async with AsyncPostgresSaver.from_conn_string(database.uri) as saver:
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
            async with AsyncPostgresSaver.from_conn_string(database.uri) as reopened:
                graph = document.build_document_graph(reopened, store=InMemoryStore())
                started = perf_counter()
                replay = await graph.ainvoke(None, cast(Any, config), context=cast(Any, {"profile": True}), durability="sync")
                reopen_ms = (perf_counter() - started) * 1000
                assert replay == result and len(model.calls) == calls
        sizes = (await database.rows("SELECT coalesce(sum(pg_column_size(checkpoint)),0)+(SELECT coalesce(sum(octet_length(blob)),0) FROM checkpoint_blobs) AS bytes,count(*) AS n FROM checkpoints"))[0]
        checkpoint_bytes, count = sizes['bytes'], sizes['n']
        writes_bytes = (await database.rows("SELECT coalesce(sum(octet_length(blob)),0) AS bytes FROM checkpoint_writes"))[0]['bytes']
        return {"pages": pages, "syntheticQuestions": 10 * pages, "elapsedMs": elapsed, "checkpointRows": count,
                "checkpointBytes": checkpoint_bytes, "pendingWriteBytes": writes_bytes,
                "checkpointWriteWaitTotalMs": sum(write_ms), "checkpointWriteWaitMaxMs": max(write_ms),
                "reopenedCompletedReplayMs": reopen_ms, "identicalReplayedOutput": True, "replayAddedModelCalls": 0}
    finally:
        await cleanup()


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
    fixture = REPOSITORY / "server/evals/fixtures/pdf/text-layer.pdf"
    with TemporaryDirectory(prefix="practiq-pipeline-profile-") as directory:
        root = Path(directory)
        from practiq_ai.extractors import extract
        image = extract("pdf", fixture.read_bytes()).page_images[0]
        checkpoints = [await checkpoint_profile(count, image, root) for count in (20, 100)]
        synchronization = await fsync_profile(root / "synchronization")
    return {"method": "Three sequential samples, warm OS file cache; real repository PDF pixels; synthetic parsing responses for checkpoint stress. No provider calls, OCR-quality claims, IPC or WebView measurement.",
            "imports": import_profile(), "schemaPerCallMs": schema, "checkpoints": checkpoints, "artifactFsync": synchronization,
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
