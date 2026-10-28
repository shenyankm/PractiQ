"""Exercise the OS boundary in disposable child processes, never the test runner."""

import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from practiq_ai import worker_sandbox


@pytest.mark.skipif(sys.platform not in {"linux", "darwin"}, reason="Linux/macOS sandbox")
def test_worker_and_descendants_cannot_read_other_files_or_use_ip_network(tmp_path):
    workspace = tmp_path / "worker"
    workspace.mkdir()
    forbidden = tmp_path / "private-source"
    forbidden.write_text("private")
    server = socket.socket(socket.AF_UNIX)
    endpoint = tmp_path / "outside.sock"
    if len(os.fsencode(endpoint)) >= 104:
        endpoint = Path("/tmp") / f"pq-sandbox-{os.getpid()}.sock"
    server.bind(str(endpoint))
    server.listen()
    script = """
import socket, subprocess, sys
from pathlib import Path
from practiq_ai.worker_sandbox import enter
workspace, forbidden, endpoint = map(Path, sys.argv[1:])
enter(workspace)
(workspace / 'output').write_text('verified')
assert (workspace / 'output').read_text() == 'verified'
try:
    forbidden.read_bytes()
except PermissionError:
    pass
else:
    raise AssertionError('unrelated source was readable')
try:
    forbidden.unlink()
except PermissionError:
    pass
else:
    raise AssertionError('unrelated source was removable')
with socket.socket(socket.AF_UNIX) as connection:
    try:
        connection.connect(str(endpoint))
    except PermissionError:
        pass
    else:
        raise AssertionError('external Unix service was available')
try:
    with socket.socket(socket.AF_INET) as connection:
        connection.connect(('127.0.0.1', 9))
except PermissionError:
    pass
else:
    raise AssertionError('IP network was available')
child = subprocess.run([sys.executable, '-c', 'from pathlib import Path; import sys; Path(sys.argv[1]).read_bytes()', str(forbidden)], capture_output=True)
assert child.returncode != 0 and b'PermissionError' in child.stderr, (child.returncode, child.stderr)
print('PASSED')
"""
    try:
        result = subprocess.run([sys.executable, "-c", script, str(workspace), str(forbidden), str(endpoint)],
                                env={**os.environ, "PYTHONPATH": str(Path(worker_sandbox.__file__).parents[1]), "AI_WORKER_SANDBOX": "required"},
                                capture_output=True, text=True, timeout=20, check=False)
    finally:
        server.close()
        endpoint.unlink(missing_ok=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "PASSED"


def test_required_sandbox_fails_closed_and_disabled_is_explicit(monkeypatch, tmp_path):
    monkeypatch.setattr(worker_sandbox.sys, "platform", "unsupported")
    monkeypatch.setenv("AI_WORKER_SANDBOX", "required")
    with pytest.raises(worker_sandbox.SandboxUnavailable):
        worker_sandbox.enter(tmp_path)
    monkeypatch.setenv("AI_WORKER_SANDBOX", "disabled")
    worker_sandbox.enter(tmp_path)
