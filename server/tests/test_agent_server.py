import hashlib
import json
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from uuid import uuid4

import httpx

ROOT = Path(__file__).parents[1]
GRAPH_IDS = {
    "document_parser", "text_csv_parser", "pdf_parser", "docx_parser", "excel_parser"
}


def _free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def test_agent_server_mounts_auth_routes_and_graphs() -> None:
    config = json.loads((ROOT / "langgraph.json").read_text())
    assert set(config["graphs"]) == GRAPH_IDS
    config["env"] = {
        "AI_SERVICE_TOKEN": "blackbox-token",
        "LLM_PROVIDER": "dashscope",
        "LLM_API_KEY": "dummy",
        "LLM_VISION_MODEL": "dummy",
        "N_JOBS_PER_WORKER": "1",
        "AI_GRAPH_MAX_CONCURRENCY": "1",
    }
    config["dependencies"] = [str(ROOT)]
    config["graphs"] = {
        name: f"{ROOT}/{target.removeprefix('./')}"
        for name, target in config["graphs"].items()
    }
    config["auth"]["path"] = f"{ROOT}/src/practiq_ai/auth.py:auth"
    config["http"]["app"] = f"{ROOT}/src/practiq_ai/webapp.py:app"
    executable = shutil.which("langgraph")
    assert executable is not None
    port = _free_port()
    headers = {"Authorization": "Bearer blackbox-token"}

    with tempfile.TemporaryDirectory() as runtime_dir, tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", prefix=".langgraph-test-", dir=runtime_dir
    ) as config_file, tempfile.TemporaryFile(mode="w+") as log_file:
        config["env"]["AI_STORAGE_DIR"] = str(Path(runtime_dir) / "files")
        fixture = Path(runtime_dir) / "task_fixture.py"
        fixture.write_text(
            "import sys\n"
            f"sys.path.insert(0, {str(ROOT)!r})\n"
            "from tests.test_workflows import FakeModel, question\n"
            "from practiq_ai.graphs import document, formats\n"
            "model = FakeModel(responses=[(0.1, {'questions': [question('First')], 'groups': []}) for _ in range(20)])\n"
            "document.get_model = lambda: model\n"
            "document_parser = document.graph\n"
            "text_csv_parser = formats.text_csv_parser\n"
            "pdf_parser = formats.pdf_parser\n"
            "docx_parser = formats.docx_parser\n"
            "excel_parser = formats.excel_parser\n"
        )
        config["graphs"] = {name: f"{fixture}:{name}" for name in GRAPH_IDS}
        json.dump(config, config_file)
        config_file.flush()
        process = subprocess.Popen(
            [
                executable,
                "dev",
                "--no-browser",
                "--no-reload",
                "--port",
                str(port),
                "--config",
                config_file.name,
            ],
            cwd=runtime_dir,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            base_url = f"http://127.0.0.1:{port}"
            deadline = time.monotonic() + 30
            with httpx.Client(base_url=base_url, timeout=2) as client:
                while True:
                    if process.poll() is not None:
                        raise AssertionError("Agent Server exited during startup")
                    try:
                        if client.get("/ok").status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    if time.monotonic() >= deadline:
                        raise AssertionError("Agent Server did not become ready")
                    time.sleep(0.1)

                assert client.post("/api/uploads", json={}).status_code == 401
                assert (
                    client.post("/api/uploads", headers=headers, json={}).status_code
                    == 422
                )
                assert (
                    client.post("/api/v3/uploads", headers=headers, json={}).status_code
                    == 404
                )
                for removed in ("parse-document", "generate-answer", "learning-report"):
                    response = client.post(f"/api/v1/ai/{removed}", headers=headers, json={})
                    assert response.status_code == 404
                assert client.get("/api/health/live", headers=headers).status_code == 404
                assert client.post("/api/artifacts/read", json={}).status_code == 401
                response = client.post("/assistants/search", headers=headers, json={})
                response.raise_for_status()
                assistants = response.json()
                assert {item["graph_id"] for item in assistants} == GRAPH_IDS
                # Real native SSE execution, rejected before any storage/LLM call.
                with client.stream("POST", "/runs/stream", headers=headers, json={
                    "assistant_id": "pdf_parser",
                    "input": {"document": {
                        "sourceType": "text", "fileName": "synthetic.txt",
                        "objectKey": "practiq-agent/sources/" + "a" * 64 + "/source.txt",
                        "sha256": "a" * 64, "mediaType": "text/plain", "sizeBytes": 1,
                    }},
                }) as stream:
                    assert stream.status_code == 200
                    events = "\n".join(stream.iter_lines())
                    assert "event: error" in events
                    assert "This graph accepts only: pdf" in events

                # Exercise the actual mounted task routes, SDK loopback transport,
                # server Store and native run cancellation; no external model calls.
                payload = b"1. First"
                upload = client.post("/api/uploads", headers=headers, json={
                    "sourceType": "text", "fileName": "task.txt", "mediaType": "text/plain",
                    "sha256": hashlib.sha256(payload).hexdigest(), "sizeBytes": len(payload),
                })
                upload.raise_for_status()
                upload_info = upload.json()
                client.put(upload_info["upload"]["url"], headers=headers, content=payload).raise_for_status()
                request = {"requestId": str(uuid4()), "document": upload_info["document"]}
                created = client.post("/api/document-tasks", headers=headers, json=request)
                created.raise_for_status()
                receipt = created.json()
                path = "/api/document-tasks/" + receipt["threadId"]
                duplicate = client.post("/api/document-tasks", headers=headers, json=request)
                duplicate.raise_for_status()
                assert duplicate.json() == receipt
                paused = client.post(path + "/control", headers=headers, json={
                    "requestId": str(uuid4()), "action": "pause", "runId": receipt["runId"],
                })
                paused.raise_for_status()

                def wait_for_state(expected):
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        result = client.get(path, headers=headers)
                        result.raise_for_status()
                        value = result.json()
                        if value["state"] in expected:
                            return value
                        assert value["state"] != "FAILED", value
                        time.sleep(0.05)
                    raise AssertionError("Task failed to reach expected state")

                state = wait_for_state({"PAUSED", "COMPLETED"})
                if state["state"] == "PAUSED":
                    client.post(path + "/control", headers=headers, json={
                        "requestId": str(uuid4()), "action": "resume", "checkpointId": state["checkpointId"],
                    }).raise_for_status()
                    state = wait_for_state({"COMPLETED"})
                assert state["status"] == "SUCCEEDED"
                assert len(state["usage"]) == 1
                assert not state["unknownUsageCalls"]
        except BaseException:
            log_file.seek(0)
            print(f"Agent Server log:\n{log_file.read()}")
            raise
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
