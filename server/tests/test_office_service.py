"""The service Office protocol is exercised with fake workers, never LibreOffice."""

import asyncio
import hashlib
import json
import os
import sys
import time
from dataclasses import replace
from pathlib import Path
from typing import Any, cast

import pytest

from practiq_ai import office, office_service
from practiq_ai.config import Config
from practiq_ai.contracts import DocumentReference, DocumentSourceType, OfficeMode
from practiq_ai.errors import DocumentProcessingError


def settings(tmp_path: Path) -> Config:
    engine = tmp_path / "deployed-engine"
    engine.write_bytes(b"configured executable bytes")
    return Config(provider="openai", api_key="private", model_id="unused", storage_dir=tmp_path,
                  source_max_bytes=25 * 1024 * 1024, vision_max_bytes=50 * 1024 * 1024,
                  max_document_pages=100, max_vision_page_pixels=25_000_000,
                  max_total_input_chars=2_000_000, graph_max_concurrency=2,
                  storage_concurrency=4, storage_timeout_seconds=30,
                  model_timeout_seconds=180, model_max_tokens=16_384,
                  office_executable=engine, office_version="LibreOffice 26.8.0.3 exact")


def source(payload=b"raw Office", kind="xlsx") -> DocumentReference:
    sha = hashlib.sha256(payload).hexdigest()
    return DocumentReference(objectKey=f"practiq-agent/sources/{sha}/source.{kind}",
                             sha256=sha, sizeBytes=len(payload), mediaType="application/octet-stream",
                             sourceType=cast(DocumentSourceType, kind), fileName="../../用户 workbook.xlsx")


def artifact(name: str, payload: bytes, *, content=True) -> dict[str, Any]:
    return {"name": name, "sizeBytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
            "hasContent": content}


class FakeInput:
    def __init__(self, worker):
        self.worker = worker
        self.closed = False

    def write(self, value):
        self.worker.request = json.loads(value)

    async def drain(self):
        assert not self.closed
        self.worker.render()

    def close(self):
        self.closed = True
        self.worker.events.append("eof")
        self.worker.finished.set()

    async def wait_closed(self):
        return


class FakeWorker:
    def __init__(self, entries, files, *, response=None, hanging=False):
        self.entries, self.files = entries, files
        self.response, self.hanging = response, hanging
        self.request: dict[str, Any] = {}
        self.stdin = FakeInput(self)
        self.stdout = asyncio.StreamReader(limit=2 * 1024 * 1024)
        self.finished = asyncio.Event()
        self.returncode = None
        self.events: list[str] = []
        self.pid = 123456789
        self.options: dict[str, Any] = {}
        self.arguments: tuple[str, ...] = ()

    def render(self):
        output = Path(self.request["output"])
        output.mkdir()
        for name, payload in self.files.items():
            (output / name).write_bytes(payload)
        if not self.hanging:
            data = self.response if self.response is not None else json.dumps({"result": {"artifacts": self.entries}}).encode() + b"\n"
            self.stdout.feed_data(data)
            self.stdout.feed_eof()
            self.returncode = 0
            self.finished.set()

    async def wait(self):
        await self.finished.wait()
        if self.returncode is None:
            self.returncode = 70
        self.events.append("wait")
        return self.returncode

    def kill(self):
        self.events.append("kill")
        self.finished.set()


def install(monkeypatch, worker):
    async def spawn(*arguments, **options):
        worker.arguments, worker.options = arguments, options
        return worker
    monkeypatch.setattr(office_service.asyncio, "create_subprocess_exec", spawn)


def test_engine_identity_uses_only_deployed_bytes_and_exact_version(tmp_path):
    config = settings(tmp_path)
    assert office_service.engine_identity(config) == {
        "version": config.office_version, "sha256": hashlib.sha256(b"configured executable bytes").hexdigest()}


@pytest.mark.parametrize("case", ["missing", "relative", "directory", "version"])
def test_engine_identity_rejects_unconfigured_or_invalid_engine(tmp_path, case):
    config = settings(tmp_path)
    config = replace(config, **{
        "missing": {"office_executable": None}, "relative": {"office_executable": Path("soffice")},
        "directory": {"office_executable": tmp_path}, "version": {"office_version": "wrong"},
    }[case])
    with pytest.raises(DocumentProcessingError):
        office_service.engine_identity(config)


async def test_worker_protocol_keeps_stdin_open_and_preserves_sheet_order_and_empty_csv(tmp_path, monkeypatch):
    config = settings(tmp_path)
    monkeypatch.setenv("LLM_API_KEY", "must-not-inherit")
    monkeypatch.setenv("AI_SERVICE_TOKEN", "must-not-inherit")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-inherit")
    files = {"source-Z.csv": b"1,2\n", "source-A.csv": b""}
    worker = FakeWorker([artifact(name, data, content=bool(data)) for name, data in files.items()], files)
    install(monkeypatch, worker)
    converted = await office_service.convert_office(source(), b"raw Office", mode="text", config=config, timeout=2)
    assert [(item.name, item.source_type, item.media_type, item.payload, item.has_content) for item in converted] == [
        ("source-Z.csv", "csv", "text/csv", b"1,2\n", True), ("source-A.csv", "csv", "text/csv", b"", False)]
    assert worker.request == {"type": "convert", "engine": str(config.office_executable), "version": config.office_version,
                              "source": str(Path(worker.request["source"])), "output": str(Path(worker.request["output"])), "mode": "text"}
    assert Path(worker.request["source"]).name == "source.xlsx"
    assert worker.arguments == (sys.executable, "-m", "practiq_ai.office")
    env = worker.options["env"]
    assert not any(key.startswith(("AI_", "LLM_", "DATABASE_")) for key in env)
    assert "OPENAI_API_KEY" not in env
    assert env["TMPDIR"] == env["TEMP"] == env["TMP"] == env["PRACTIQ_OFFICE_WORKSPACE"]
    assert env["PYTHONPATH"] == str(Path(office_service.__file__).parent.parent)
    assert worker.events.index("eof") >= 1 and "kill" not in worker.events
    assert not Path(worker.request["source"]).parent.exists()


@pytest.mark.parametrize("kind,mode,name,expected", [("doc", "pdf", "source.pdf", ("pdf", "application/pdf")),
                                                     ("docx", "text", "source.txt", ("text", "text/plain")),
                                                     ("xls", "pdf", "source.pdf", ("pdf", "application/pdf"))])
async def test_worker_output_format_follows_source_and_selected_mode(tmp_path, monkeypatch, kind, mode, name, expected):
    data = b"converted"
    worker = FakeWorker([artifact(name, data)], {name: data})
    install(monkeypatch, worker)
    converted = await office_service.convert_office(source(kind=kind), b"raw Office", mode=mode, config=settings(tmp_path), timeout=2)
    assert (converted[0].source_type, converted[0].media_type) == expected
    assert Path(worker.request["source"]).name == f"source.{kind}"


@pytest.mark.parametrize("case,code", [("size", "DOCUMENT_SIZE_MISMATCH"), ("sha", "DOCUMENT_CHECKSUM_MISMATCH"),
                                     ("large", "SOURCE_TOO_LARGE"), ("kind", "OFFICE_FORMAT_UNSUPPORTED"),
                                     ("mode", "OFFICE_INPUT_INVALID"), ("timeout", "OFFICE_INPUT_INVALID")])
async def test_input_is_validated_before_spawning(tmp_path, monkeypatch, case, code):
    async def spawn(*args, **kwargs):
        pytest.fail("Invalid input must not launch a worker")
    monkeypatch.setattr(office_service.asyncio, "create_subprocess_exec", spawn)
    config, reference, payload, mode, timeout = settings(tmp_path), source(), b"raw Office", "pdf", 2
    if case == "size":
        payload = b"short"
    elif case == "sha":
        payload = b"bad Office"
    elif case == "large":
        config = replace(config, source_max_bytes=1)
    elif case == "kind":
        reference = source(kind="pdf")
    elif case == "mode":
        mode = "csv"
    else:
        timeout = float("nan")
    with pytest.raises(DocumentProcessingError) as error:
        await office_service.convert_office(reference, payload, mode=cast(OfficeMode, mode), config=config, timeout=timeout)
    assert error.value.code == code


@pytest.mark.parametrize("case", ["traversal", "backslash", "absolute", "control", "suffix", "duplicate", "size", "sha",
                                  "boolean_size", "content", "extra_field", "empty", "count", "file_limit", "total_limit", "undeclared"])
async def test_worker_artifacts_are_strict_and_bounded(tmp_path, monkeypatch, case):
    entry, files = artifact("source.csv", b"1,2\n"), {"source.csv": b"1,2\n"}
    entries = [entry]
    if case in {"traversal", "backslash", "absolute", "control", "suffix"}:
        entry["name"] = {"traversal": "../outside.csv", "backslash": "a\\b.csv", "absolute": "/source.csv",
                         "control": "source\x00.csv", "suffix": "source.pdf"}[case]
    elif case == "duplicate":
        entries *= 2
    elif case == "size":
        entry["sizeBytes"] = 3
    elif case == "sha":
        entry["sha256"] = "a" * 64
    elif case == "boolean_size":
        entry["sizeBytes"] = True
    elif case == "content":
        entry["hasContent"] = 1
    elif case == "extra_field":
        entry["path"] = "/private"
    elif case == "empty":
        entries = []
    elif case == "count":
        entries *= 101
    elif case == "file_limit":
        monkeypatch.setattr(office_service, "FILE_LIMIT", 10)
        files = {"source.csv": b"x" * 11}
        entries = [artifact("source.csv", files["source.csv"])]
    elif case == "total_limit":
        monkeypatch.setattr(office_service, "TOTAL_LIMIT", 3)
    else:
        files["extra.csv"] = b"other"
    worker = FakeWorker(entries, files)
    install(monkeypatch, worker)
    with pytest.raises(DocumentProcessingError) as error:
        await office_service.convert_office(source(), b"raw Office", mode="text", config=settings(tmp_path), timeout=2)
    assert error.value.code in {"OFFICE_OUTPUT_INVALID", "OFFICE_OUTPUT_LIMIT"}
    assert not Path(worker.request["output"]).parent.exists()


@pytest.mark.parametrize("response,code", [(b'{"error":"OFFICE_TIMEOUT"}\n', "OFFICE_TIMEOUT"),
                                         (b'{"error":"private path or document text"}\n', "OFFICE_CONVERSION_FAILED"),
                                         (b'not json\n', "OFFICE_CONVERSION_FAILED"),
                                         (b'{"result": {"artifacts":[]},"secret":"x"}\n', "OFFICE_CONVERSION_FAILED"),
                                         (b'x' * (1024 * 1024 + 1) + b'\n', "OFFICE_CONVERSION_FAILED")])
async def test_worker_errors_and_protocol_are_safe(tmp_path, monkeypatch, response, code):
    worker = FakeWorker([], {}, response=response)
    install(monkeypatch, worker)
    with pytest.raises(DocumentProcessingError) as error:
        await office_service.convert_office(source(), b"raw Office", mode="pdf", config=settings(tmp_path), timeout=2)
    assert error.value.code == code
    assert "private" not in error.value.detail


async def test_timeout_sends_eof_before_escalation_and_removes_workspace(tmp_path, monkeypatch):
    worker = FakeWorker([], {}, hanging=True)
    install(monkeypatch, worker)
    with pytest.raises(DocumentProcessingError) as error:
        await office_service.convert_office(source(), b"raw Office", mode="pdf", config=settings(tmp_path), timeout=.02)
    assert (error.value.status_code, error.value.code) == (504, "OFFICE_TIMEOUT")
    assert worker.events[0] == "eof" and "kill" not in worker.events
    assert not Path(worker.request["source"]).parent.exists()


async def test_repeated_cancellation_settles_eof_cleanup_before_removing_workspace(tmp_path, monkeypatch):
    closed = asyncio.Event()
    cleaned = tmp_path / "cleanup-proof"
    create = asyncio.create_subprocess_exec
    script = """import json,os,sys,time
request=json.loads(sys.stdin.buffer.readline())
sys.stdin.buffer.read()
time.sleep(.08)
assert os.path.exists(request['source'])
open(sys.argv[1],'w').write('eof-cleanup-finished')
"""
    process = None
    options = None
    async def spawn(*args, **kwargs):
        nonlocal process, options
        options = kwargs
        process = await create(sys.executable, "-c", script, str(cleaned), **kwargs)
        closed.set()
        return process
    monkeypatch.setattr(office_service.asyncio, "create_subprocess_exec", spawn)
    task = asyncio.create_task(office_service.convert_office(source(), b"raw Office", mode="pdf", config=settings(tmp_path), timeout=2))
    await closed.wait()
    await asyncio.sleep(.05)
    task.cancel()
    await asyncio.sleep(.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cleaned.read_text() == "eof-cleanup-finished"
    assert process is not None and process.returncode is not None
    assert options is not None and not Path(options["env"]["TMPDIR"]).exists()


@pytest.mark.parametrize("case", ["symlink", "directory", "directory_symlink"])
async def test_output_requires_owned_regular_files(tmp_path, monkeypatch, case):
    worker = FakeWorker([artifact("source.csv", b"1,2\n")], {"source.csv": b"1,2\n"})
    render = worker.render
    def replaced_output():
        render()
        output = Path(worker.request["output"])
        target = output / "source.csv"
        if case == "directory_symlink":
            replacement = output.parent / "other"
            output.rename(replacement)
            try:
                output.symlink_to(replacement, target_is_directory=True)
            except OSError:
                pytest.skip("Creating symlinks is unavailable on this platform")
        else:
            target.unlink()
            if case == "directory":
                target.mkdir()
            else:
                external = tmp_path / "outside.csv"
                external.write_bytes(b"1,2\n")
                try:
                    target.symlink_to(external)
                except OSError:
                    pytest.skip("Creating symlinks is unavailable on this platform")
    worker.render = replaced_output
    install(monkeypatch, worker)
    with pytest.raises(DocumentProcessingError) as error:
        await office_service.convert_office(source(), b"raw Office", mode="text", config=settings(tmp_path), timeout=2)
    assert error.value.code == "OFFICE_OUTPUT_INVALID"


async def test_cancellation_during_spawn_waits_for_worker_then_sends_eof(tmp_path, monkeypatch):
    started = asyncio.Event()
    worker = FakeWorker([], {}, hanging=True)
    async def spawn(*arguments, **options):
        worker.options = options
        started.set()
        await asyncio.sleep(.03)
        return worker
    monkeypatch.setattr(office_service.asyncio, "create_subprocess_exec", spawn)
    task = asyncio.create_task(office_service.convert_office(source(), b"raw Office", mode="pdf", config=settings(tmp_path), timeout=2))
    await started.wait()
    task.cancel()
    await asyncio.sleep(.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert worker.events == ["eof", "wait"]
    assert not Path(worker.options["env"]["TMPDIR"]).exists()


async def test_worker_that_ignores_eof_is_killed_and_reaped(tmp_path, monkeypatch):
    create = asyncio.create_subprocess_exec
    process = None
    async def spawn(*args, **kwargs):
        nonlocal process
        process = await create(sys.executable, "-c", "import sys,time;sys.stdin.buffer.readline();time.sleep(60)", **kwargs)
        return process
    monkeypatch.setattr(office_service.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(office_service, "CLEANUP_TIMEOUT", .05)
    with pytest.raises(DocumentProcessingError) as error:
        await office_service.convert_office(source(), b"raw Office", mode="pdf", config=settings(tmp_path), timeout=.1)
    assert error.value.code == "OFFICE_TIMEOUT"
    assert process is not None and process.returncode is not None and process.returncode != 0


@pytest.mark.skipif(os.name == "nt", reason="POSIX named-pipe validation")
def test_engine_identity_rejects_fifo_without_waiting_for_writer(tmp_path, monkeypatch):
    config = settings(tmp_path)
    fifo = tmp_path / "pipe"
    os.mkfifo(fifo)
    original_open = Path.open
    def guarded_open(path, *args, **kwargs):
        if path == fifo:
            pytest.fail("Blocking open of a FIFO would wait for an untrusted writer")
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(Path, "open", guarded_open)
    with pytest.raises(DocumentProcessingError) as error:
        office_service.engine_identity(replace(config, office_executable=fifo))
    assert error.value.code == "OFFICE_ENGINE_INVALID"


def test_abandoned_worker_never_starts_a_new_engine_session(tmp_path, monkeypatch):
    monkeypatch.setattr(office, "_abandoned", False, raising=False)
    monkeypatch.delenv("PRACTIQ_OFFICE_WORKSPACE", raising=False)
    monkeypatch.setattr(office, "_spawn", lambda *args, **kwargs: pytest.fail("EOF must prevent any later engine spawn"))
    office._abandon()
    with pytest.raises(office.OfficeError, match="OFFICE_CONVERSION_FAILED"):
        office._run(["unused-engine"], time.monotonic() + 2)
