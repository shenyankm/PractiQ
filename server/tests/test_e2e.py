"""Real desktop bootstrap, HTTP, SQLite and extraction; only the provider is synthetic."""
import hashlib
import json
import os
import selectors
import socket
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
import uvicorn

from scripts.recovery_provider import app_for
from tests.support import make_blank_pdf, make_image


@pytest.fixture
def service(tmp_path):
    calls = tmp_path / "calls.jsonl"
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    provider = uvicorn.Server(uvicorn.Config(app_for(calls), log_level="error"))
    thread = threading.Thread(target=provider.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    bootstrap = {
        "AI_SERVICE_TOKEN": "e2e-token", "LLM_API_KEY": "synthetic-key",
        "LLM_BASE_URL": f"http://127.0.0.1:{sock.getsockname()[1]}/v1",
        "LLM_MODEL": "synthetic-model",
        "AI_DATABASE_DIR": str(tmp_path / "db"), "AI_STORAGE_DIR": str(tmp_path / "files"),
    }

    @contextmanager
    def start():
        # Retain coverage configuration, but isolate credentials and proxies.
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("AI_", "LLM_")) and not key.lower().endswith("_proxy")}
        env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
        with (tmp_path / "service.log").open("w+") as log:
            process = subprocess.Popen([sys.executable, "-m", "practiq_ai.desktop", "serve"],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=log, cwd=tmp_path, env=env, text=True)
            assert process.stdin is not None and process.stdout is not None
            try:
                process.stdin.write(json.dumps(bootstrap) + "\n")
                process.stdin.flush()
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    assert selector.select(30), "Desktop bootstrap timed out"
                line = process.stdout.readline()
                log.seek(0)
                assert line, log.read()
                ready = json.loads(line)
                with httpx.Client(base_url=f"http://127.0.0.1:{ready['port']}",
                                  headers={"Authorization": "Bearer e2e-token"}, timeout=10, trust_env=False) as client:
                    assert client.get("/ready").status_code == 200
                    yield client
                process.stdin.close()
                process.wait(timeout=20)
                log.seek(0)
                assert process.returncode == 0, log.read()
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                process.stdin.close()
                process.stdout.close()

    try:
        yield start, calls
    finally:
        provider.should_exit = True
        thread.join(timeout=10)
        sock.close()
        assert not thread.is_alive(), "Synthetic provider did not stop"


def upload(client, data, kind="text", media="text/plain", name="quiz.txt"):
    metadata = {"sourceType": kind, "mediaType": media, "fileName": name,
                "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    response = client.post("/api/uploads", json=metadata)
    assert response.status_code == 201, response.text
    prepared = response.json()
    if prepared["upload"]:
        response = client.put(prepared["upload"]["url"], content=data)
        assert response.status_code == 200, response.text
        assert response.json() == prepared["document"]
    return prepared["document"]


def wait_task(client, path, expected):
    deadline = time.monotonic() + 30
    while True:
        response = client.get(path)
        assert response.status_code == 200, response.text
        state = response.json()
        if state["state"] == expected:
            return state
        assert state["state"] not in {"FAILED", "COMPLETED", "WAITING_REVIEW"}, state
        assert time.monotonic() < deadline, state
        time.sleep(0.05)


@pytest.mark.parametrize("kind", ["text", "csv", "image", "pdf"])
def test_e2e_upload_parse_artifacts_and_restart(service, kind):
    start, calls = service
    data, media, name = {
        "text": (b"Synthetic recovery question", "text/plain", "quiz.txt"),
        "csv": (b"Question,Answer\nSynthetic recovery question,A\n", "text/csv", "quiz.csv"),
        "image": (make_image(), "image/png", "quiz.png"),
        "pdf": (make_blank_pdf(1), "application/pdf", "quiz.pdf"),
    }[kind]
    with start() as client:
        assert client.get("/api/document-tasks", headers={"Authorization": ""}).status_code == 401
        document = upload(client, data, kind, media, name)
        assert not calls.exists(), "Uploading must not invoke a model"
        request = {"requestId": str(uuid4()), "document": document}
        response = client.post("/api/document-tasks", json=request)
        assert response.status_code == 202, response.text
        receipt = response.json()
        path = "/api/document-tasks/" + receipt["threadId"]
        state = wait_task(client, path, "COMPLETED")
        assert state["status"] == "SUCCEEDED" and state["failures"] == []
        assert state["result"]["questions"][0]["stem"] == "Synthetic recovery question"
        assert len(state["usage"]) == 1 and state["unknownUsageCalls"] == []
        assert client.post("/api/document-tasks", json=request).json() == receipt
        preview = client.get(path + "/preview")
        assert preview.status_code == 200 and preview.json()["units"][0]["questions"] == state["result"]["questions"]
        references = [v["imageRef"] for v in state["result"]["visualElements"] if v.get("imageRef")]
        if kind in {"image", "pdf"}:
            assert references, "Vision output must expose a downloadable verified crop"
        for reference in references:
            response = client.post("/api/artifacts/read", json=reference)
            assert response.status_code == 200, response.text
            assert response.headers["cache-control"] == "no-store"
            assert hashlib.sha256(response.content).hexdigest() == reference["sha256"]
            assert len(response.content) == reference["sizeBytes"]
            assert client.post("/api/artifacts/read", json={**reference, "sizeBytes": reference["sizeBytes"] + 1}).status_code == 409
        assert "practiq_workers_available" in client.get("/api/metrics").text
    with start() as client:
        restored = client.get(path).json()
        assert restored["result"] == state["result"] and restored["usage"] == state["usage"]
        assert restored["state"] == "COMPLETED"
        assert client.post("/api/document-tasks", json=request).json() == receipt
        listing = client.get("/api/document-tasks").json()["items"]
        assert len(listing) == 1 and listing[0]["questionCount"] == 1
        assert client.get("/api/document-tasks", params={"offset": 1}).json()["items"] == []
    assert len(calls.read_text().splitlines()) == 1, "Reads, restart and replay must not charge again"


def test_e2e_review_acceptance_is_explicit_and_survives_restart(service):
    start, calls = service
    with start() as client:
        document = upload(client, b"A different source without the synthetic model's question")
        response = client.post("/api/document-tasks", json={"requestId": str(uuid4()), "document": document, "failurePolicy": "review"})
        assert response.status_code == 202, response.text
        path = "/api/document-tasks/" + response.json()["threadId"]
        state = wait_task(client, path, "WAITING_REVIEW")
        assert state["allowedActions"] == ["accept_partial"]
        assert state["processing"]["quality"]["reviewRequired"]
    with start() as client:
        assert client.get(path).json()["state"] == "WAITING_REVIEW"
        control = {"requestId": str(uuid4()), "action": "accept_partial", "checkpointId": state["checkpointId"]}
        assert client.post(path + "/control", json={**control, "checkpointId": "stale"}).status_code == 409
        response = client.post(path + "/control", json=control)
        assert response.status_code == 202, response.text
        accepted = wait_task(client, path, "COMPLETED")
        assert accepted["result"] == state["result"]
        assert accepted["processing"]["quality"]["reviewRequired"]
        assert client.post(path + "/control", json=control).json() == response.json()
    assert len(calls.read_text().splitlines()) == 1


def test_e2e_grading_digest_replay_and_restart(service):
    start, calls = service
    raw = json.dumps({"question": {"stem": "解释含义", "answerMode": "short_answer", "answerPayload": {"text": "参考依据"}},
                      "answer": "学生答案", "maxCents": 500}, ensure_ascii=False)
    request = {"requestId": str(uuid4()), "inputDigest": hashlib.sha256(raw.encode()).hexdigest(), "payload": raw}
    with start() as client:
        assert client.post("/api/subjective-grades", json=request, headers={"Authorization": ""}).status_code == 401
        assert client.post("/api/subjective-grades", json={**request, "payload": raw + " "}).status_code == 422
        assert not calls.exists()
        response = client.post("/api/subjective-grades", json=request)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["status"] == "graded" and result["result"]["scoreCents"] == 300
        assert len(result["usage"]) == len(result["calls"]) == 1
    with start() as client:
        assert client.post("/api/subjective-grades", json=request).json() == result
        changed = raw.replace("学生答案", "修改后的答案")
        conflict = {**request, "payload": changed, "inputDigest": hashlib.sha256(changed.encode()).hexdigest()}
        assert client.post("/api/subjective-grades", json=conflict).status_code == 409
    assert len(calls.read_text().splitlines()) == 1


def test_e2e_rejected_uploads_never_queue_work(service):
    start, calls = service
    with start() as client:
        data = b"Synthetic recovery question"
        metadata = {"sourceType": "text", "fileName": "quiz.txt", "mediaType": "text/plain",
                    "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        prepared = client.post("/api/uploads", json=metadata).json()
        artifact = {key: prepared["document"][key] for key in ("objectKey", "sha256", "mediaType", "sizeBytes")}
        assert client.post("/api/artifacts/read", json=artifact).status_code == 422
        response = client.put(prepared["upload"]["url"], content=b"x" * len(data))
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "DOCUMENT_CHECKSUM_MISMATCH"
        assert client.put(prepared["upload"]["url"], content=data + b"x").status_code == 413
        assert client.get("/api/document-tasks").json()["items"] == []
        assert not calls.exists()
        # A failed upload must not poison the same content address.
        document = upload(client, data)
        artifact = {key: document[key] for key in ("objectKey", "sha256", "mediaType", "sizeBytes")}
        assert document == prepared["document"]
        assert client.post("/api/uploads", json=metadata).json()["upload"] is None
        assert client.post("/api/artifacts/read", json={**artifact, "objectKey": "../outside"}).status_code == 422
        assert not calls.exists()


@pytest.mark.parametrize(("args", "bootstrap", "message"), [
    ([], "", "Expected serve or extract"),
    (["serve"], "{}\n", "Invalid bootstrap"),
    (["serve"], "x" * 65537, "Bootstrap too large"),
])
def test_e2e_bootstrap_rejects_invalid_input(tmp_path, args, bootstrap, message):
    result = subprocess.run([sys.executable, "-m", "practiq_ai.desktop", *args],
                            input=bootstrap, text=True, capture_output=True, timeout=15, check=False,
                            cwd=tmp_path, env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")})
    assert result.returncode != 0 and message in result.stderr
    assert result.stdout == ""
    assert not list(tmp_path.iterdir())
