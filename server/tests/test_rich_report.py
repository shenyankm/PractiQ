import hashlib
import json
import runpy
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest


@pytest.mark.parametrize("scenario", ["matching", "literal_failure", "source_changed", "implementation_changed", "missing_hashes"])
def test_rich_report_rechecks_only_matching_source_and_implementation(tmp_path, monkeypatch, scenario):
    script = Path(__file__).parents[2] / "app/scripts/check-rich-recognition.py"
    scope = runpy.run_path(str(script))
    check = scope["check_saved_report"]
    monkeypatch.setitem(check.__globals__, "ROOT", tmp_path)
    source = tmp_path / "app/fixtures/rich-content/source.pdf"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"synthetic PDF fixture")
    hashes = {}
    for name in ("graphs/document.py", "graphs/vision.py", "contracts.py"):
        path = tmp_path / "server/src/practiq_ai" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name)
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    saved = {"fixtureSourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
             "implementationSha256": hashes, "result": {"questions": []}}
    if scenario == "source_changed":
        source.write_bytes(b"changed PDF fixture")
    elif scenario == "implementation_changed":
        (tmp_path / "server/src/practiq_ai/contracts.py").write_text("changed contract")
    elif scenario == "missing_hashes":
        saved.pop("implementationSha256")
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


def test_rich_report_rejects_merged_replay_before_reading_reports(tmp_path):
    script = Path(__file__).parents[2] / "app/scripts/check-rich-recognition.py"
    result = subprocess.run([sys.executable, str(script), "--check-report", "--merged"],
                            cwd=tmp_path, capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode != 0
    assert "--check-report supports only the simple fixture" in result.stderr
