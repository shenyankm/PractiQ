"""Opt-in Web -> real service -> exported ZIP -> native practice acceptance.

Default providers are substitutes. --live explicitly authorizes three small imports.
Only fresh disposable PostgreSQL/RabbitMQ and a new output directory are used.
"""

import argparse
import asyncio
import hashlib
import json
import os
import platform
import re
import secrets
import socket
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zipfile import ZipFile

import httpx
import pytest
from dotenv import dotenv_values
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
EXPECTED = [("The Earth orbits the Sun.", True), ("Two plus two equals five.", False),
            ("A triangle has three sides.", True)]
SOURCE = "True or false questions. Extract the supplied answers.\n\n" + "\n\n".join(
    f"{i}. {stem}\nAnswer: {answer}" for i, (stem, answer) in enumerate(EXPECTED, 1))


def check_questions(questions: list[dict[str, Any]]) -> list[str]:
    errors = []
    found = {}
    for row in questions:
        stem = re.sub(r"^\s*\d+[.)、]\s*", "", row.get("stem") or "").strip()
        if stem in found:
            errors.append("duplicate stem")
        found[stem] = row
        # Supplied answers are required; absent optional explanations must remain reviewable.
        if set(row.get("missingFields", [])) - {"analysis"}:
            errors.append("required question field missing")
    if len(questions) != len(EXPECTED) or set(found) != {stem for stem, _ in EXPECTED}:
        errors.append("question completeness/stem mismatch")
    for stem, answer in EXPECTED:
        row = found.get(stem, {})
        if row.get("answerMode") != "true_false" or row.get("answerPayload") != {"value": answer}:
            errors.append("question type/reference answer mismatch")
    return errors



def read_native_report(path: Path, zip_hashes: dict[str, str], repetitions: int) -> tuple[list[dict[str, Any]], list[str]]:
    try:
        rows = json.loads(path.read_text())
    except (OSError, ValueError):
        return [], ["native report missing or invalid"]
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        return [], ["native report must contain result records"]
    expected = {(name, repetition) for name in zip_hashes for repetition in range(repetitions)}
    observed = []
    errors = []
    for row in rows:
        name, repetition = row.get("name"), row.get("repetition")
        if not isinstance(name, str) or name not in zip_hashes or type(repetition) is not int:
            errors.append("native case/repetition mismatch")
            continue
        observed.append((name, repetition))
        if row.get("zipSha256") != zip_hashes[name]:
            errors.append("native ZIP checksum mismatch")
        if row.get("firstRun") is not (repetition == 0):
            errors.append("native first-run marker mismatch")
        if (row.get("questions"), row.get("correct"), row.get("earnedCents")) != (3, 3, 300):
            errors.append("native practice results incomplete")
        if row.get("reopen") is not True or row.get("backupRestore") is not True:
            errors.append("native persistence/restore evidence missing")
    if len(rows) != len(expected) or set(observed) != expected:
        errors.append("native case/repetition coverage incomplete")
    return rows, errors


def fixtures(output: Path) -> None:
    (output / "sources").mkdir()
    (output / "exports").mkdir()
    for suffix in ("txt", "md"):
        (output / "sources" / f"quiz.{suffix}").write_text(SOURCE)
    image = Image.new("RGB", (1100, 550), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 25)
    draw.multiline_text((30, 30), SOURCE, fill="black", font=font, spacing=7)
    image.save(output / "sources/quiz.png")


def serve(synthetic: bool) -> None:
    import uvicorn

    if synthetic:
        from practiq_ai.graphs import document
        from tests.support import FakeModel, ocr_text_page, question, tencent_provider

        patch = pytest.MonkeyPatch()
        tencent_provider(patch, [ocr_text_page(SOURCE)])
        rows = [{**question(stem), "answerMode": "true_false", "answerPayload": {"value": answer}}
                for stem, answer in EXPECTED]
        def response(_messages, schema):
            result = {"questions": rows, "groups": []}
            if schema.__name__ == "OcrPageParseResult":
                result["figures"] = []
            return result
        model = FakeModel(responses=[response] * 12)
        patch.setattr(document, "get_model", lambda *args: model)
    uvicorn.run("practiq_ai.webapp:app", host="127.0.0.1", port=int(os.environ["PRACTIQ_ACCEPT_PORT"]),
                access_log=False, log_level="warning")


async def sample_memory(process: asyncio.subprocess.Process, samples: list[int]) -> None:
    while process.returncode is None:
        query = await asyncio.create_subprocess_exec("ps", "-o", "rss=", "-p", str(process.pid),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        data, _ = await query.communicate()
        if data.strip():
            samples.append(int(data.strip()) * 1024)
        await asyncio.sleep(.1)


async def command_result(command: list[str], env: dict[str, str], log: Any, timeout: float) -> int:
    process = await asyncio.create_subprocess_exec(*command, cwd=ROOT, env=env, stdout=log, stderr=log)
    try:
        return await asyncio.wait_for(process.wait(), timeout)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def run(output: Path, live: bool, native_binary: Path) -> dict[str, Any]:
    from practiq_ai.config import evaluation_configuration, load
    from practiq_ai.execution import code_version
    from tests.db_support import cleanup, new_database

    fixtures(output)
    # Never inherit service data locations, runtime credentials or proxy credentials.
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("AI_", "LLM_")) and key not in {"DATABASE_URI", "RABBITMQ_URI"}}
    settings = {key: value for key, value in dotenv_values(ROOT / ".env").items()
                if value is not None and key.startswith(("AI_", "LLM_"))} if live else {
                    "LLM_PROVIDER": "openai", "LLM_API_KEY": "synthetic", "LLM_MODEL": "synthetic",
                    "LLM_BASE_URL": "http://127.0.0.1:9/v1"}
    token = secrets.token_urlsafe(32)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env.update(settings, AI_SERVICE_TOKEN=token, AI_READ_ONLY="0", AI_MAINTENANCE="0",
               AI_STORAGE_DIR=str(output / "storage"), AI_WEB_DIR=str(ROOT / "web/dist"),
               AI_TASK_MAX_MODEL_CALLS="4", AI_RUN_TIMEOUT_SECONDS="240",
               LANGSMITH_TRACING="false", LANGCHAIN_TRACING_V2="false",
               PRACTIQ_ACCEPT_PORT=str(port), PYTHONPATH=os.pathsep.join([str(ROOT / "server/src"), str(ROOT / "server")]))
    report: dict[str, Any] = {"schemaVersion": 1, "generatedAt": datetime.now(UTC).isoformat(),
        "revision": (await asyncio.to_thread(subprocess.check_output, ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True)).strip(),
        "python": platform.python_version(), "platform": platform.platform(), "liveProviders": live,
        "scope": "Production Chromium Web and loopback HTTP service; disposable PostgreSQL/RabbitMQ; real local files and release Rust/SQLite. Native phase excludes Tauri IPC/WebView. Three tiny fixtures, no capacity/p95 or before/after speedup claim.",
        "status": "FAILED", "gateReasons": [], "samples": []}
    process = None
    memory = None
    rss: list[int] = []
    try:
        db = await new_database()
        await db.close()
        env.update(DATABASE_URI=db.uri, RABBITMQ_URI=os.environ["RABBITMQ_URI"])
        # The service is a child process; the parent only needs matching safe config for identity.
        with pytest.MonkeyPatch.context() as patch:
            for key, value in env.items():
                if key.startswith(("AI_", "LLM_")):
                    patch.setenv(key, value)
            report["serviceCodeHash"] = code_version()
            report["configuration"] = evaluation_configuration(load())
        log_path = output / "service.log"
        with log_path.open("x") as log:
            command = [sys.executable, str(Path(__file__).resolve()), "--serve"]
            if not live:
                command.append("--synthetic")
            process = await asyncio.create_subprocess_exec(*command, env=env, cwd=ROOT / "server", stdout=log, stderr=log)
            memory = asyncio.create_task(sample_memory(process, rss))
            async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", trust_env=False) as client:
                for _ in range(600):
                    if process.returncode is not None:
                        raise RuntimeError("Service startup failed; inspect service.log")
                    try:
                        if (await client.get("/ready")).status_code == 200:
                            break
                    except httpx.ConnectError:
                        pass
                    await asyncio.sleep(.1)
                else:
                    raise TimeoutError("Service readiness deadline")
            browser_env = {**env, "PRACTIQ_ACCEPT_URL": f"http://127.0.0.1:{port}",
                           "PRACTIQ_ACCEPT_OUTPUT": str(output), "PRACTIQ_ACCEPT_NATIVE": str(native_binary)}
            with (output / "browser.log").open("x") as log_browser:
                browser_status = await command_result(["node", "web/scripts/accept-workflow.mjs"], browser_env, log_browser, 900)
            browser_report = json.loads((output / "browser.json").read_text())
            report["samples"] = browser_report["samples"]
            for sample in report["samples"]:
                path = output / "exports" / f"{sample['name']}.zip"
                sample["qualityErrors"] = []
                if not path.exists():
                    sample["qualityErrors"].append("missing exported ZIP")
                    continue
                with ZipFile(path) as archive:
                    assert archive.testzip() is None
                    content = json.loads(archive.read("questions.json"))
                    result = content.get("result", content)
                    sample["qualityErrors"] = check_questions(result["questions"])
                    detail = json.loads((output / f"{sample['name']}-detail.json").read_text())
                    if result != detail["result"]:
                        sample["qualityErrors"].append("HTTP/export result mismatch")
                sample["zipSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
                _, sample["nativeErrors"] = read_native_report(
                    output / f"{sample['name']}-native.json", {sample["name"]: sample["zipSha256"]}, 1)
            native_env = {**os.environ, "PRACTIQ_WORKFLOW_DIR": str(output), "PRACTIQ_BENCH_OUTPUT": str(output / "native.json")}
            with (output / "native.log").open("x") as log_native:
                native_status = await command_result([str(native_binary), "performance::workflow_practice",
                    "--exact", "--ignored", "--nocapture"], native_env, log_native, 120)
            hashes = {name: hashlib.sha256((output / "exports" / f"{name}.zip").read_bytes()).hexdigest()
                      if (output / "exports" / f"{name}.zip").exists() else "" for name in ("txt", "md", "png")}
            report["native"], report["nativeErrors"] = read_native_report(output / "native.json", hashes, 8)
            if native_status or report["nativeErrors"]:
                report["gateReasons"].append("NATIVE_WORKFLOW_FAILED")
            if browser_status:
                report["gateReasons"].append("BROWSER_WORKFLOW_FAILED")
            for sample in report["samples"]:
                if sample.get("error") or sample["qualityErrors"] or sample.get("nativeErrors"):
                    report["gateReasons"].append("IMPORT_OR_CONTENT_FAILED:" + sample["name"])
            if len(report["samples"]) != 3:
                report["gateReasons"].append("THREE_SAMPLES_REQUIRED")
            process.terminate()
            await asyncio.wait_for(process.wait(), 30)
        events = []
        for line in log_path.read_text().splitlines():
            if line.startswith('{"event":'):
                events.append(json.loads(line))
        (output / "events.json").write_text(json.dumps(events, indent=2) + "\n")
        for sample in report["samples"]:
            sample["stages"] = [row for row in events if row.get("threadId") == sample.get("threadId")
                                and row["event"] in {"stage", "model_call", "document_run_state"}]
        report["status"] = "PASSED" if not report["gateReasons"] else "FAILED"
    except Exception as exc:
        report["gateReasons"].append(type(exc).__name__)
        raise
    finally:
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 30)
            except TimeoutError:
                process.kill()
                await process.wait()
        if memory:
            await memory
        report["serviceMemory"] = {"sampledPeakRssBytes": max(rss, default=0), "samples": len(rss),
                                   "scope": "Service PID only, ps sampling at >=100ms; excludes renderer/Office/browser/native/DB/broker and can miss peaks."}
        await cleanup()
        paths = [Path(__file__), ROOT / "web/scripts/accept-workflow.mjs", ROOT / "app/src-tauri/src/performance.rs"]
        report["harnessSha256"] = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
        report["inputSha256"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (output / "sources").iterdir()}
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--synthetic", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--live", action="store_true", help="Authorize exactly three source imports with .env providers")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--native-binary", type=Path)
    args = parser.parse_args()
    if args.serve:
        serve(args.synthetic)
        return
    if not args.output or not args.native_binary or not args.native_binary.is_file():
        parser.error("--output and a precompiled release --native-binary are required")
    if args.output.exists():
        parser.error("Use a new output directory; failed/unknown imports are never replayed")
    args.output.mkdir(parents=True, mode=0o700)
    report = asyncio.run(run(args.output.resolve(), args.live, args.native_binary.resolve()))
    print(report["status"], report["gateReasons"])
    raise SystemExit(0 if report["status"] == "PASSED" else 1)


if __name__ == "__main__":
    main()
