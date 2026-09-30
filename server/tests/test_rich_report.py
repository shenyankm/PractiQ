import hashlib
import json
import runpy
import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

from practiq_ai import execution


@pytest.mark.parametrize("scenario", ["matching", "literal_failure", "source_changed", "implementation_changed", "missing_hashes", "legacy_hashes"])
def test_rich_report_rechecks_only_matching_source_and_implementation(tmp_path, monkeypatch, scenario):
    script = Path(__file__).parents[2] / "app/scripts/check-rich-recognition.py"
    scope = runpy.run_path(str(script))
    check = scope["check_saved_report"]
    monkeypatch.setitem(check.__globals__, "ROOT", tmp_path)
    source = tmp_path / "app/fixtures/rich-content/source.pdf"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"synthetic PDF fixture")
    version = Mock(return_value="a" * 64)
    monkeypatch.setitem(check.__globals__, "implementation_checksums", version)
    saved = {"fixtureSourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
             "implementationSha256": version.return_value, "result": {"questions": []}}
    if scenario == "source_changed":
        source.write_bytes(b"changed PDF fixture")
    elif scenario == "implementation_changed":
        version.return_value = "b" * 64
    elif scenario == "missing_hashes":
        saved.pop("implementationSha256")
    elif scenario == "legacy_hashes":
        saved["implementationSha256"] = {name: "a" * 64 for name in ("graphs/document.py", "graphs/vision.py", "contracts.py")}
    target = tmp_path / "app/reports/rich-content"
    target.mkdir(parents=True)
    (target / "recognition.json").write_text(json.dumps(saved))
    checker = Mock(return_value={"literal": scenario != "literal_failure"})
    monkeypatch.setitem(check.__globals__, "check_result", checker)
    if scenario in {"matching", "literal_failure"}:
        assert check() is (scenario == "matching")
        checker.assert_called_once_with(saved["result"], source.read_bytes(), target)
    else:
        with pytest.raises(ValueError, match="PDF changed" if scenario == "source_changed" else "Implementation changed"):
            check()
        checker.assert_not_called()


@pytest.mark.parametrize("changed", [
    "server/src/practiq_ai/graphs/chunking.py",
    "server/src/practiq_ai/extractors/pdf.py",
    "server/src/practiq_ai/contracts.py",
    "server/uv.lock",
])
def test_rich_report_fingerprint_covers_parser_and_dependencies(tmp_path, monkeypatch, changed):
    root = Path(__file__).parents[2]
    package = tmp_path / "server/src/practiq_ai"
    shutil.copytree(root / "server/src/practiq_ai", package, ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copyfile(root / "server/uv.lock", tmp_path / "server/uv.lock")
    scope = runpy.run_path(str(root / "app/scripts/check-rich-recognition.py"))
    check = scope["check_saved_report"]
    monkeypatch.setitem(check.__globals__, "ROOT", tmp_path)
    monkeypatch.setitem(execution.code_version.__wrapped__.__globals__, "__file__", str(package / "execution.py"))
    source = tmp_path / "app/fixtures/rich-content/source.pdf"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"synthetic PDF fixture")
    target = tmp_path / "app/reports/rich-content"
    target.mkdir(parents=True)
    checker = Mock(return_value={"literal": True})
    monkeypatch.setitem(check.__globals__, "check_result", checker)
    execution.code_version.cache_clear()
    try:
        version = scope["implementation_checksums"]()
        assert isinstance(version, str) and len(version) == 64
        saved = {"fixtureSourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                 "implementationSha256": version, "result": {"questions": []}}
        (target / "recognition.json").write_text(json.dumps(saved))
        assert check()
        checker.reset_mock()
        path = tmp_path / changed
        path.write_bytes(path.read_bytes() + b"\n# fingerprint regression\n")
        execution.code_version.cache_clear()
        assert scope["implementation_checksums"]() != version
        with pytest.raises(ValueError, match="Implementation changed"):
            check()
        checker.assert_not_called()
    finally:
        execution.code_version.cache_clear()


def test_rich_report_rejects_merged_replay_before_reading_reports(tmp_path):
    script = Path(__file__).parents[2] / "app/scripts/check-rich-recognition.py"
    result = subprocess.run([sys.executable, str(script), "--check-report", "--merged"],
                            cwd=tmp_path, capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode != 0
    assert "--check-report supports only the simple fixture" in result.stderr
