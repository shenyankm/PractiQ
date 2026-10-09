"""Bounded service adapter for the explicitly configured Office engine."""

import asyncio
import hashlib
import json
import math
import os
import re
import signal
import stat
import subprocess
import sys
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

from .config import Config
from .contracts import (
    OFFICE_FILE_MAX_BYTES,
    OFFICE_SOURCE_TYPES,
    DocumentReference,
    OfficeMode,
    document_source_limit,
)
from .errors import DocumentProcessingError
from .extractors.isolated import _read_file, _thread_io
from .storage import verify_payload

FILE_LIMIT = OFFICE_FILE_MAX_BYTES
TOTAL_LIMIT = 100 * 1024 * 1024
FILE_COUNT = 100
JSON_LINE_LIMIT = 1024 * 1024
CLEANUP_TIMEOUT = 2.0
WORKER_ERRORS = {
    "OFFICE_CONVERSION_FAILED": 502, "OFFICE_ENGINE_INVALID": 503,
    "OFFICE_FORMAT_UNSUPPORTED": 422, "OFFICE_INPUT_INVALID": 422,
    "OFFICE_NOT_FOUND": 503, "OFFICE_OUTPUT_INVALID": 502,
    "OFFICE_OUTPUT_LIMIT": 413, "OFFICE_SHEETS_UNSUPPORTED": 422, "OFFICE_TIMEOUT": 504,
}


@dataclass(frozen=True)
class ConvertedSource:
    name: str
    source_type: Literal["pdf", "text", "csv"]
    media_type: str
    payload: bytes
    has_content: bool


def engine_identity(config: Config) -> dict[str, str]:
    engine, version = config.office_executable, config.office_version
    if engine is None or not version:
        raise DocumentProcessingError(503, "Office conversion is not configured", "OFFICE_NOT_CONFIGURED")
    if (not engine.is_absolute() or not version.startswith(("LibreOffice ", "LibreOfficeDev "))
            or len(version) > 255):
        raise _error("OFFICE_ENGINE_INVALID")
    try:
        descriptor = os.open(engine, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError("Engine must be a regular file")
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        return {"version": version, "sha256": checksum}
    except (OSError, ValueError) as exc:
        raise _error("OFFICE_ENGINE_INVALID") from exc


def _error(code: str) -> DocumentProcessingError:
    safe = code if code in WORKER_ERRORS else "OFFICE_CONVERSION_FAILED"
    return DocumentProcessingError(WORKER_ERRORS[safe], "Office conversion failed", safe)


def _environment(directory: str) -> dict[str, str]:
    # Keep deployment code and OS libraries, excluding model and deployment token credentials.
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(("AI_", "LLM_", "DATABASE_"))
           and not any(word in key.upper() for word in ("API_KEY", "TOKEN", "SECRET", "PASSWORD"))}
    env.update(TMPDIR=directory, TEMP=directory, TMP=directory,
               PRACTIQ_OFFICE_WORKSPACE=directory, PYTHONDONTWRITEBYTECODE="1",
               PYTHONPATH=str(Path(__file__).parent.parent))
    return env


async def _cleanup_worker(process: asyncio.subprocess.Process) -> None:
    # EOF reaches the worker's parent watcher, which owns the separate Office sessions.
    if process.stdin is not None:
        process.stdin.close()
    try:
        await asyncio.wait_for(process.wait(), CLEANUP_TIMEOUT)
        return
    except TimeoutError:
        pass
    try:
        if os.name == "nt":
            if process.returncode is None:
                process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    await asyncio.wait_for(process.wait(), CLEANUP_TIMEOUT)


async def _shield_cleanup(process: asyncio.subprocess.Process) -> None:
    task = asyncio.create_task(_cleanup_worker(process))
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    task.result()
    if cancelled:
        raise asyncio.CancelledError


async def _launch_worker(directory: str) -> asyncio.subprocess.Process:
    task = asyncio.create_task(asyncio.create_subprocess_exec(
        sys.executable, "-m", "practiq_ai.office", stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        env=_environment(directory), limit=JSON_LINE_LIMIT,
        start_new_session=os.name != "nt", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # Cancellation during process creation must not orphan the just-created worker.
        settled = asyncio.gather(task, return_exceptions=True)
        while not settled.done():
            try:
                await asyncio.shield(settled)
            except asyncio.CancelledError:
                pass
        if not task.cancelled() and task.exception() is None:
            await _shield_cleanup(task.result())
        raise


def _read_artifacts(output: Path, entries: object, *, kind: str, mode: OfficeMode,
                    limit: int) -> list[ConvertedSource]:
    if not isinstance(entries, list) or not entries:
        raise _error("OFFICE_OUTPUT_INVALID")
    if len(entries) > FILE_COUNT:
        raise _error("OFFICE_OUTPUT_LIMIT")
    shape: tuple[str, Literal["pdf", "text", "csv"], str] = ((".pdf", "pdf", "application/pdf") if mode == "pdf" else
                                     (".txt", "text", "text/plain") if kind in {"doc", "docx"} else
                                     (".csv", "csv", "text/csv"))
    suffix, source_type, media_type = shape
    names: set[str] = set()
    total = 0
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"name", "sizeBytes", "sha256", "hasContent"}:
            raise _error("OFFICE_OUTPUT_INVALID")
        name, size, checksum = entry["name"], entry["sizeBytes"], entry["sha256"]
        if (not isinstance(name, str) or not name or any(ord(c) < 32 for c in name)
                or any(c in name for c in ("/", "\\", ":")) or name in {".", ".."}
                or Path(name).suffix.lower() != suffix or name in names
                or type(size) is not int or size < 0 or type(entry["hasContent"]) is not bool
                or not isinstance(checksum, str) or re.fullmatch(r"[a-f0-9]{64}", checksum) is None):
            raise _error("OFFICE_OUTPUT_INVALID")
        if size > limit:
            raise _error("OFFICE_OUTPUT_LIMIT")
        total += size
        names.add(name)
    if total > TOTAL_LIMIT:
        raise _error("OFFICE_OUTPUT_LIMIT")
    try:
        if not stat.S_ISDIR(output.lstat().st_mode) or {path.name for path in output.iterdir()} != names:
            raise ValueError("Invalid output directory")
        converted = []
        for entry in entries:
            path = output / entry["name"]
            if not stat.S_ISREG(path.lstat().st_mode):
                raise ValueError("Invalid output artifact")
            payload = _read_file(path, entry["sizeBytes"])
            if len(payload) != entry["sizeBytes"] or hashlib.sha256(payload).hexdigest() != entry["sha256"]:
                raise ValueError("Invalid output metadata")
            converted.append(ConvertedSource(entry["name"], source_type, media_type, payload, entry["hasContent"]))
        return converted
    except (OSError, ValueError) as exc:
        raise _error("OFFICE_OUTPUT_INVALID") from exc


async def convert_office(reference: DocumentReference, payload: bytes, *, mode: OfficeMode,
                         config: Config, timeout: float) -> list[ConvertedSource]:
    if reference.sourceType not in OFFICE_SOURCE_TYPES:
        raise _error("OFFICE_FORMAT_UNSUPPORTED")
    if mode not in {"pdf", "text"} or not math.isfinite(timeout) or timeout <= 0:
        raise _error("OFFICE_INPUT_INVALID")
    limit = min(FILE_LIMIT, document_source_limit(reference.sourceType, config.source_max_bytes))
    if len(payload) > limit:
        raise DocumentProcessingError(413, "Office source exceeds the configured limit", "SOURCE_TOO_LARGE")
    await verify_payload(reference, payload)
    with TemporaryDirectory(prefix="practiq-office-") as directory:
        root = Path(directory)
        source, output = root / f"source.{reference.sourceType}", root / "output"
        process = None
        try:
            async with asyncio.timeout(min(timeout, 180)):
                await _thread_io(engine_identity, config)
                await _thread_io(source.write_bytes, payload)
                process = await _launch_worker(directory)
                if process.stdin is None or process.stdout is None:
                    raise _error("OFFICE_CONVERSION_FAILED")
                request = {"type": "convert", "engine": str(config.office_executable), "version": config.office_version,
                           "source": str(source), "output": str(output), "mode": mode}
                process.stdin.write(json.dumps(request).encode("utf-8") + b"\n")
                await process.stdin.drain()
                raw = await process.stdout.readline()
                if len(raw) > JSON_LINE_LIMIT or not raw.endswith(b"\n"):
                    raise _error("OFFICE_CONVERSION_FAILED")
                response = json.loads(raw)
                if not isinstance(response, dict):
                    raise _error("OFFICE_CONVERSION_FAILED")
                if set(response) == {"error"}:
                    raise _error(response["error"] if isinstance(response["error"], str) else "OFFICE_CONVERSION_FAILED")
                if (set(response) != {"result"} or not isinstance(response["result"], dict)
                        or set(response["result"]) != {"artifacts"}):
                    raise _error("OFFICE_CONVERSION_FAILED")
                if await process.wait() != 0:
                    raise _error("OFFICE_CONVERSION_FAILED")
                return await _thread_io(partial(_read_artifacts, output, response["result"]["artifacts"],
                                               kind=reference.sourceType, mode=mode, limit=limit))
        except TimeoutError as exc:
            raise _error("OFFICE_TIMEOUT") from exc
        except (OSError, ValueError, TypeError) as exc:
            raise _error("OFFICE_CONVERSION_FAILED") from exc
        finally:
            if process is not None:
                await _shield_cleanup(process)
