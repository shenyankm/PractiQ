import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml


@pytest.mark.parametrize("failure", ["", "lock", "tests", "combine", "coverage", "probes"])
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
elif args[:3] == ["-m", "coverage", "combine"]:
    stage = "combine"
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
        assert {"combine", "coverage", "probes"} <= set(calls)
        assert calls.index("tests") < calls.index("combine") < calls.index("coverage")
        if failure:
            assert "Error 7" in result.stderr

@pytest.mark.parametrize('explicit_path', [False, True])
def test_install_targets_use_the_selected_interpreter(tmp_path, explicit_path):
    import json

    root = Path(__file__).resolve().parents[2]
    (tmp_path / 'python').symlink_to(sys.executable)
    uv = tmp_path / 'uv'
    uv.write_text(f'#!{sys.executable}\n' + '''
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
interpreter = args[args.index('--python') + 1]
assert Path(interpreter).is_absolute(), 'Named interpreters trigger uv virtual-environment discovery'
assert Path(interpreter).samefile(sys.executable)
with Path(os.environ['INSTALL_CALLS']).open('a') as log:
    log.write(json.dumps(args[:2]) + '\\n')
''')
    uv.chmod(0o755)
    calls = tmp_path / 'calls'
    selected = str(tmp_path / 'python') if explicit_path else 'python'
    result = subprocess.run(['make', 'server-install', 'install-locked', 'app-install-python', f'AI_PYTHON={selected}'],
        cwd=root, env={**os.environ, 'PATH': f'{tmp_path}{os.pathsep}{os.environ["PATH"]}', 'INSTALL_CALLS': str(calls)},
        capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert [json.loads(line) for line in calls.read_text().splitlines()].count(['pip', 'install']) == 5


def test_app_check_does_not_require_bundled_resources(tmp_path):
    root = Path(__file__).resolve().parents[2]
    shutil.copyfile(root / 'Makefile', tmp_path / 'Makefile')
    (tmp_path / 'app').mkdir()
    python = tmp_path / 'python'
    python.write_text('#!/bin/sh\nexit 0\n')
    python.chmod(0o755)
    npm = tmp_path / 'npm'
    npm.write_text(f'#!{sys.executable}\n' + '''
import json, os, sys
assert sys.argv[1:] == ['run', 'check']
assert json.loads(os.environ['TAURI_CONFIG']) == {'bundle': {'resources': []}}
''')
    npm.chmod(0o755)
    result = subprocess.run(
        ['make', 'app-check', f'AI_PYTHON={python}'], cwd=tmp_path,
        env={**os.environ, 'PATH': f'{tmp_path}{os.pathsep}{os.environ["PATH"]}'},
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("target", ["audit", "audit-rust"])
@pytest.mark.parametrize("failure", [False, True])
def test_dependency_audits_cover_locked_inputs_and_propagate_failures(tmp_path, target, failure):
    root = Path(__file__).resolve().parents[2]
    shutil.copyfile(root / "Makefile", tmp_path / "Makefile")
    (tmp_path / "server").mkdir()
    checker = tmp_path / "python"
    checker.write_text(f"#!{sys.executable}\n" + '''
import os
import sys
from pathlib import Path

args = sys.argv[1:]
if args[0] == "export":
    assert "--locked" in args and "--no-emit-project" in args
    extras = {args[i + 1] for i, arg in enumerate(args) if arg == "--extra"}
    assert extras == {"dev", "desktop"}
    Path(args[args.index("-o") + 1]).write_text("pyinstaller==6.22.3\\n")
elif args[:2] == ["-m", "pip_audit"]:
    assert {"--strict", "--disable-pip", "--no-deps"} <= set(args)
    assert "pyinstaller==" in Path(args[args.index("-r") + 1]).read_text()
    sys.exit(int(os.environ["AUDIT_EXIT"]))
else:
    assert args == ["audit", "--file", "app/src-tauri/Cargo.lock"]
    sys.exit(int(os.environ["AUDIT_EXIT"]))
''')
    checker.chmod(0o755)
    for name in ("uv", "cargo"):
        (tmp_path / name).symlink_to(checker)
    result = subprocess.run(
        ["make", target, f"AI_PYTHON={checker}"], cwd=tmp_path,
        env={**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
             "AUDIT_EXIT": "7" if failure else "0"},
        capture_output=True, text=True, check=False,
    )
    assert (result.returncode != 0) == failure, result.stdout + result.stderr
    if failure:
        assert "Error 7" in result.stderr


def test_workflows_deduplicate_common_checks_without_dropping_native_gates():
    from fnmatch import fnmatchcase

    root = Path(__file__).resolve().parents[2]
    workflows = {
        name: yaml.load((root / f".github/workflows/{name}.yml").read_text(), Loader=yaml.BaseLoader)
        for name in ("desktop", "server")
    }
    for workflow in workflows.values():
        assert workflow["on"]["push"]["branches"] == ["main"]
        paths = workflow["on"]["pull_request"]["paths"]
        assert paths == workflow["on"]["push"]["paths"]
        for unrelated in ("README.md", "docs/guide.md", ".agents/skills/example/SKILL.md"):
            assert not any(fnmatchcase(unrelated, pattern) for pattern in paths)
    for path in ("server/src/practiq_ai/webapp.py", "app/fixtures/english.json",
                 "app/scripts/check-rich-recognition.py", ".dockerignore", "Dockerfile.server",
                 ".github/workflows/desktop.yml", "Makefile"):
        assert any(fnmatchcase(path, pattern) for pattern in workflows["server"]["on"]["push"]["paths"])

    jobs = workflows["desktop"]["jobs"]
    quality, package = jobs["quality"], jobs["package"]
    assert quality["runs-on"].startswith("ubuntu-")
    assert package["needs"] == "quality"
    assert {item["platform"] for item in package["strategy"]["matrix"]["include"]} == {"Windows", "Linux", "macOS"}
    quality_commands = "\n".join(step.get("run", "") for step in quality["steps"])
    package_commands = "\n".join(step.get("run", "") for step in package["steps"])
    for command in ("npm run lint", "npm run test:coverage", "npm run test:browser", "npm audit",
                    "export-contracts.py --check", "check-fixtures.py", "cargo fmt", "make audit-rust"):
        assert command in quality_commands
        assert command not in package_commands
    assert "--release --manifest-path app/src-tauri/vendor/glib/Cargo.toml" in quality_commands
    for command in ("cargo test --locked", "cargo clippy --locked", "--all-targets -- -D warnings",
                    "test_desktop_platforms.py", "test_office.py", "bundle-python.py", "npm run tauri -- build"):
        assert command in package_commands
    assert "npm run build" not in package_commands  # Tauri already invokes beforeBuildCommand.
    for platform in ("Windows", "Linux", "macOS"):
        commands = "\n".join(step.get("run", "") for step in package["steps"]
                             if step.get("if") == f"runner.os == '{platform}'")
        assert "check-bundle.py" in commands and "check-office.py" in commands
        if platform != "macOS":
            assert "native_keychain_roundtrip -- --ignored" in commands
    uploads = [step for step in package["steps"] if step.get("uses", "").startswith("actions/upload-artifact@")]
    reports, installers = uploads
    assert reports["if"] == "${{ always() }}" and reports["with"]["retention-days"] == "7"
    assert installers["if"] == "github.event_name != 'pull_request'"
    assert installers["with"]["retention-days"] == "14"
