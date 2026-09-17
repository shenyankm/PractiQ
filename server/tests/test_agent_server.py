import json
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

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
        "LLM_TEXT_MODEL": "dummy",
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
                health = client.get("/api/health/live")
                assert health.status_code == 200 and health.json()["data"]["ok"] is True
                java_path = "/api/v1/ai/parse-document"
                assert client.post(java_path, json={}).status_code == 401
                invalid_java = client.post(java_path, headers=headers, json={})
                assert invalid_java.status_code == 422
                assert invalid_java.json()["error"]["code"] == "VALIDATION_ERROR"
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
