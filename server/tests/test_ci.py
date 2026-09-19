import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("failure", ["", "lock", "tests", "coverage", "probes"])
def test_verify_keeps_reports_without_hiding_failures(tmp_path, failure):
    shutil.copyfile(Path(__file__).resolve().parents[2] / "Makefile", tmp_path / "Makefile")
    reports = tmp_path / "server/reports/checks"
    reports.mkdir(parents=True)
    for name in ("probes.xml", "probes.json", "probes.md", "coverage.xml"):
        (reports / name).write_text("stale")
    executable = tmp_path / "python"
    executable.write_text(f"#!{sys.executable}\n" + '''
import os
import sys
from pathlib import Path

args = sys.argv[1:]
stage = "other"
if args[:2] == ["lock", "--check"]:
    stage = "lock"
elif args[:3] == ["-m", "coverage", "run"]:
    stage = "tests"
    Path("reports/checks/probes.xml").write_text("fresh")
elif args[:3] == ["-m", "coverage", "report"]:
    stage = "coverage"
elif args[:3] == ["-m", "coverage", "xml"]:
    Path("reports/checks/coverage.xml").write_text("fresh")
elif "--probes" in args:
    stage = "probes"
    for name in ("probes.json", "probes.md"):
        path = Path("reports/checks") / name
        assert not path.exists()
        path.write_text("fresh")
elif args[0] == "build":
    Path("built").touch()
with Path("calls").open("a") as stream:
    stream.write(stage + "\\n")
sys.exit(7 if stage == os.environ["FAIL_STAGE"] else 0)
''')
    executable.chmod(0o755)
    (tmp_path / "uv").symlink_to(executable)
    result = subprocess.run(
        ["make", "verify", f"AI_PYTHON={executable}"], cwd=tmp_path,
        env={**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}", "FAIL_STAGE": failure},
        capture_output=True, text=True, check=False,
    )
    assert (result.returncode == 0) == (not failure), result.stdout + result.stderr
    assert (tmp_path / "server/built").exists() == (not failure)
    if failure == "lock":
        assert not list(reports.iterdir())
    else:
        assert all(path.read_text() == "fresh" for path in reports.iterdir())
        assert len(list(reports.iterdir())) == 4
        calls = (tmp_path / "server/calls").read_text().splitlines()
        assert calls.count("tests") == 1
        assert {"coverage", "probes"} <= set(calls)
        if failure:
            assert "Error 7" in result.stderr
