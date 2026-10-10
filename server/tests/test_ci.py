import inspect
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
import tomllib
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
assert Path.cwd().samefile(Path(os.environ['INSTALL_PROJECT'])), 'Build constraints must load from the service project'
interpreter = args[args.index('--python') + 1]
assert Path(interpreter).is_absolute(), 'Named interpreters trigger uv virtual-environment discovery'
assert Path(interpreter).samefile(sys.executable)
with Path(os.environ['INSTALL_CALLS']).open('a') as log:
    log.write(json.dumps(args[:2]) + '\\n')
''')
    uv.chmod(0o755)
    calls = tmp_path / 'calls'
    selected = str(tmp_path / 'python') if explicit_path else 'python'
    result = subprocess.run(['make', 'server-install', 'install-locked', f'AI_PYTHON={selected}'],
        cwd=root, env={**os.environ, 'PATH': f'{tmp_path}{os.pathsep}{os.environ["PATH"]}', 'INSTALL_CALLS': str(calls), 'INSTALL_PROJECT': str(root / 'server')},
        capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert [json.loads(line) for line in calls.read_text().splitlines()].count(['pip', 'install']) == 3


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


@pytest.mark.parametrize("target,failure", [
    ("audit", ""), ("audit", "runtime"), ("audit", "build"),
    ("audit-rust", ""), ("audit-rust", "runtime"),
])
def test_dependency_audits_cover_locked_inputs_and_propagate_failures(tmp_path, target, failure):
    root = Path(__file__).resolve().parents[2]
    shutil.copyfile(root / "Makefile", tmp_path / "Makefile")
    (tmp_path / "server").mkdir()
    shutil.copyfile(root / "server/pyproject.toml", tmp_path / "server/pyproject.toml")
    checker = tmp_path / "python"
    checker.write_text(f"#!{sys.executable}\n" + '''
import os
import subprocess
import sys
import tomllib
from pathlib import Path

args = sys.argv[1:]
if args[0] == "export":
    assert "--locked" in args and "--no-emit-project" in args
    extras = {args[i + 1] for i, arg in enumerate(args) if arg == "--extra"}
    assert extras == {"dev"}
    Path(args[args.index("-o") + 1]).write_text("langgraph==1.2.1\\n")
elif args[:2] == ["-m", "pip_audit"]:
    assert {"--strict", "--disable-pip", "--no-deps"} <= set(args)
    requirements = Path(args[args.index("-r") + 1]).read_text()
    stage = "runtime" if "langgraph==" in requirements else "build"
    if stage == "build":
        project = tomllib.loads(Path("pyproject.toml").read_text())
        assert set(requirements.splitlines()) == set(
            project["build-system"]["requires"] + project["tool"]["uv"]["build-constraint-dependencies"]
        )
    with Path("audits").open("a") as stream:
        stream.write(stage + "\\n")
    sys.exit(7 if os.environ["AUDIT_FAILURE"] == stage else 0)
elif args[0] == "-c":
    subprocess.run([sys.executable, *args], check=True)
elif args == ["app/scripts/check-rust-targets.py"]:
    assert not os.environ["AUDIT_FAILURE"], "Target graphs must run only after audit succeeds"
else:
    assert args == ["audit", "--file", "app/src-tauri/Cargo.lock"]
    sys.exit(7 if os.environ["AUDIT_FAILURE"] else 0)
''')
    checker.chmod(0o755)
    for name in ("uv", "cargo"):
        (tmp_path / name).symlink_to(checker)
    result = subprocess.run(
        ["make", target, f"AI_PYTHON={checker}"], cwd=tmp_path,
        env={**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
             "AUDIT_FAILURE": failure},
        capture_output=True, text=True, check=False,
    )
    assert (result.returncode != 0) == bool(failure), result.stdout + result.stderr
    if target == "audit":
        assert (tmp_path / "server/audits").read_text().splitlines() == (
            ["runtime"] if failure == "runtime" else ["runtime", "build"]
        )
    if failure:
        assert "Error 7" in result.stderr


@pytest.mark.parametrize("failure", [None, "glib", "empty", "other-root", "cargo"])
def test_rust_target_graph_gate_rejects_reachable_glib_and_incomplete_checks(tmp_path, failure):
    root = Path(__file__).resolve().parents[2]
    checker = tmp_path / "cargo"
    checker.write_text(f"#!{sys.executable}\n" + '''
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
assert args[:3] == ["tree", "--locked", "--manifest-path"]
assert Path(args[3]).name == "Cargo.toml"
assert args[4:5] == ["--target"]
assert args[6:] == ["--prefix", "none", "--format", "{p}"]
with Path(os.environ["TARGET_LOG"]).open("a") as log:
    log.write(json.dumps(args[5]) + "\\n")
failure = os.environ["GRAPH_FAILURE"]
if args[5] == "x86_64-linux-android":
    if failure == "cargo":
        sys.exit(7)
    if failure == "empty":
        sys.exit(0)
    if failure == "other-root":
        print("unrelated v1.0.0")
        sys.exit(0)
print("practiq-desktop v0.1.0")
print("tauri v2.11.5")
if failure == "glib" and args[5] == "x86_64-linux-android":
    print("glib v0.18.5 (*)")
''')
    checker.chmod(0o755)
    log = tmp_path / "targets.jsonl"
    result = subprocess.run(
        [sys.executable, str(root / "app/scripts/check-rust-targets.py")],
        env={**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
             "TARGET_LOG": str(log), "GRAPH_FAILURE": failure or ""},
        capture_output=True, text=True, check=False,
    )
    assert [json.loads(line) for line in log.read_text().splitlines()] == [
        "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc",
        "aarch64-linux-android", "x86_64-linux-android",
    ]
    assert (result.returncode != 0) == (failure is not None), result.stdout + result.stderr
    if failure == "glib":
        assert "GLib dependency is reachable on x86_64-linux-android" in result.stderr
    elif failure == "cargo":
        assert "exit status 7" in result.stderr
    elif failure:
        assert "Missing app dependency graph" in result.stderr
    else:
        assert result.stdout.count("app dependency graph contains no glib") == 5


@pytest.mark.parametrize("with_glib", [False, True])
def test_make_rust_audit_propagates_target_graph_failure(tmp_path, with_glib):
    root = Path(__file__).resolve().parents[2]
    shutil.copyfile(root / "Makefile", tmp_path / "Makefile")
    script = tmp_path / "app/scripts/check-rust-targets.py"
    script.parent.mkdir(parents=True)
    shutil.copyfile(root / "app/scripts/check-rust-targets.py", script)
    cargo = tmp_path / "cargo"
    cargo.write_text(f"#!{sys.executable}\n" + '''
import os
import sys

args = sys.argv[1:]
if args == ["audit", "--file", "app/src-tauri/Cargo.lock"]:
    print("FULL_LOCK_AUDIT_PASSED")
elif args[0] == "tree":
    print("practiq-desktop v0.1.0")
    if os.environ["WITH_GLIB"] == "1":
        print("glib v0.18.5")
else:
    sys.exit(7)
''')
    cargo.chmod(0o755)
    result = subprocess.run(
        ["make", "audit-rust", f"AI_PYTHON={sys.executable}"], cwd=tmp_path,
        env={**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
             "WITH_GLIB": "1" if with_glib else "0"},
        capture_output=True, text=True, check=False,
    )
    assert "FULL_LOCK_AUDIT_PASSED" in result.stdout
    assert (result.returncode != 0) == with_glib, result.stdout + result.stderr
    if with_glib:
        assert "GLib dependency is reachable on aarch64-apple-darwin" in result.stderr


def test_rust_target_graph_timeout_fails_the_gate(monkeypatch):
    root = Path(__file__).resolve().parents[2]

    def timed_out(command, **kwargs):
        assert kwargs["timeout"] == 300
        assert command[command.index("--target") + 1] == "aarch64-apple-darwin"
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", timed_out)
    with pytest.raises(subprocess.TimeoutExpired):
        runpy.run_path(str(root / "app/scripts/check-rust-targets.py"), run_name="__main__")


def native_guard_compiler(root):
    compiler = shutil.which("rustc")
    env = {**os.environ, "RUSTUP_AUTO_INSTALL": "0"}
    pinned = tomllib.loads((root / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    try:
        if compiler is None:
            raise FileNotFoundError("rustc is absent")
        version = subprocess.run(
            [compiler, "--version"], cwd=root, env=env, capture_output=True, text=True,
            check=True, timeout=30,
        ).stdout
        if not version.startswith(f"rustc {pinned} "):
            raise ValueError(f"Rust {pinned} is not the installed compiler")
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        message = f"Native build guard needs installed Rust {pinned}: {error}"
        if os.environ.get("PRACTIQ_REQUIRE_NATIVE_BUILD_GUARD") == "1":
            pytest.fail(message)
        pytest.skip(message)
    return compiler, env


@pytest.mark.parametrize("strict", [False, True])
@pytest.mark.parametrize("availability", ["installed", "absent", "missing-toolchain", "timeout", "wrong-version"])
def test_native_guard_compiler_never_installs_missing_toolchains(monkeypatch, strict, availability):
    root = Path(__file__).resolve().parents[2]
    pinned = tomllib.loads((root / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    monkeypatch.setenv("PRACTIQ_REQUIRE_NATIVE_BUILD_GUARD", "1" if strict else "0")
    monkeypatch.setenv("RUSTUP_AUTO_INSTALL", "1")
    monkeypatch.setattr(shutil, "which", lambda _: None if availability == "absent" else "/rustc")

    def probe(command, **kwargs):
        assert command == ["/rustc", "--version"]
        assert kwargs["env"]["RUSTUP_AUTO_INSTALL"] == "0"
        assert kwargs["cwd"] == root and kwargs["timeout"] == 30 and kwargs["check"]
        if availability == "missing-toolchain":
            raise subprocess.CalledProcessError(1, command)
        if availability == "timeout":
            raise subprocess.TimeoutExpired(command, 30)
        version = "rustc 0.0.0 (unavailable)" if availability == "wrong-version" else f"rustc {pinned} (installed)"
        return subprocess.CompletedProcess(command, 0, stdout=version)

    monkeypatch.setattr(subprocess, "run", probe)
    if availability == "installed":
        compiler, env = native_guard_compiler(root)
        assert compiler == "/rustc" and env["RUSTUP_AUTO_INSTALL"] == "0"
    else:
        with pytest.raises(pytest.fail.Exception if strict else pytest.skip.Exception):
            native_guard_compiler(root)


@pytest.fixture(scope="module")
def app_build_guard(tmp_path_factory):
    root = Path(__file__).resolve().parents[2]
    compiler, env = native_guard_compiler(root)
    folder = tmp_path_factory.mktemp("app-build-guard")
    source = folder / "guard.rs"
    source.write_text('mod tauri_build { pub fn build() { println!("TAURI_BUILD_CALLED"); } }\n'
                      + (root / "app/src-tauri/build.rs").read_text())
    executable = folder / "guard"
    subprocess.run([compiler, str(source), "-o", str(executable)], cwd=root, env=env,
                   check=True, capture_output=True, timeout=30)
    return executable


def test_native_guard_compile_errors_are_not_skipped(monkeypatch, tmp_path_factory):
    monkeypatch.setattr(sys.modules[__name__], "native_guard_compiler", lambda _: ("/rustc", os.environ.copy()))

    def compile_error(command, **kwargs):
        raise subprocess.CalledProcessError(1, command, stderr=b"invalid build script")

    monkeypatch.setattr(subprocess, "run", compile_error)
    with pytest.raises(subprocess.CalledProcessError):
        inspect.unwrap(app_build_guard)(tmp_path_factory)


@pytest.mark.parametrize("target_os", ["macos", "windows", "android", "linux", "ios", "freebsd", None])
def test_app_build_rejects_unsupported_os_before_native_packaging(app_build_guard, target_os):
    env = {k: v for k, v in os.environ.items() if k != "CARGO_CFG_TARGET_OS"}
    if target_os is not None:
        env["CARGO_CFG_TARGET_OS"] = target_os
    result = subprocess.run([str(app_build_guard)], env=env, capture_output=True, text=True, check=False)
    supported = target_os in {"macos", "windows", "android"}
    assert (result.returncode == 0) == supported, result.stdout + result.stderr
    assert ("TAURI_BUILD_CALLED" in result.stdout) == supported
    if target_os == "android":
        assert "-Wl,-z,max-page-size=16384" in result.stdout
        assert "-Wl,-z,common-page-size=16384" in result.stdout
    elif supported:
        assert "cargo:rustc-link-arg" not in result.stdout


def test_workflows_deduplicate_common_checks_without_dropping_native_gates():
    root = Path(__file__).resolve().parents[2]
    workflows = {
        name: yaml.load((root / f".github/workflows/{name}.yml").read_text(), Loader=yaml.BaseLoader)
        for name in ("app", "server")
    }
    assert not (root / ".github/workflows/desktop.yml").exists()
    assert not (root / ".github/workflows/android.yml").exists()
    native_regressions, = (
        step for step in workflows["app"]["jobs"]["quality"]["steps"]
        if "python -m pytest server/tests/test_ci.py" in step.get("run", "")
    )
    assert native_regressions["env"]["PRACTIQ_REQUIRE_NATIVE_BUILD_GUARD"] == "1"
    gates = set()
    for name, workflow in workflows.items():
        for job in workflow["jobs"].values():
            for step in job["steps"]:
                if "uses" in step:
                    assert re.fullmatch(r"[^@]+@[0-9a-f]{40}", step["uses"]), step["uses"]
        assert workflow["on"]["push"]["branches"] == ["main"]
        assert not workflow["on"]["pull_request"]
        assert "paths" not in workflow["on"]["push"]
        assert workflow["permissions"] == {"contents": "read"}
        scope = "service" if name == "server" else "desktop"
        jobs = workflow["jobs"]
        quality, changes = (jobs[key] for key in ("quality", "changes"))
        assert quality["name"] == ("Service quality" if name == "server" else "App quality")
        assert quality["needs"] == "changes"
        assert quality["if"] == "needs.changes.outputs.required == 'true'"
        assert changes["permissions"] == {"contents": "read", "pull-requests": "read"}
        assert changes["outputs"]["required"] == "${{ steps.scope.outputs.required }}"
        selector = next(step for step in changes["steps"] if step.get("id") == "scope")
        assert selector["run"] == f"python server/scripts/ci_scope.py scope {scope}"
        for gate_scope, gate_key, dependencies in (
            [("service", "gate", [])] if name == "server" else
            [("desktop", "desktop-gate", ["package"]), ("android", "android-gate", ["android-package", "emulator"])]
        ):
            gate = jobs[gate_key]
            assert gate["name"] == f"{gate_scope.title()} CI" and gate["if"] == "${{ always() }}"
            gates.add(gate["name"])
            assert gate["needs"] == ["changes", "quality", *dependencies]
            gate_step = next(step for step in gate["steps"] if "run" in step)
            assert gate_step["run"] == f"python server/scripts/ci_scope.py gate {gate_scope}"
            assert gate_step["env"]["NEEDS"] == "${{ toJSON(needs) }}"
    app = workflows["app"]["jobs"]
    assert app["changes"]["outputs"]["sha"] == "${{ steps.source.outputs.sha }}"
    source = next(step for step in app["changes"]["steps"] if step.get("id") == "source")
    assert 'git rev-parse HEAD' in source["run"] and 'GITHUB_OUTPUT' in source["run"]
    for key, job in app.items():
        checkout, = (step for step in job["steps"] if step.get("uses", "").startswith("actions/checkout@"))
        assert checkout["with"]["ref"] == ("${{ inputs.ref || github.sha }}" if key == "changes" else "${{ needs.changes.outputs.sha }}")
        if key != "changes":
            assert "changes" in job["needs"]
    # One scheduler per event/revision; no separate caller starts common checks again.
    for file in (root / ".github/workflows").glob("*.yml"):
        workflow = yaml.load(file.read_text(), Loader=yaml.BaseLoader)
        for job in workflow["jobs"].values():
            for step in job.get("steps", []):
                if "npm run check:ui" in step.get("run", ""):
                    assert file.name == "app.yml" and job["name"] == "App quality"
    ruleset = json.loads((root / ".github/main-ruleset.json").read_text())
    required_checks = next(rule["parameters"]["required_status_checks"]
                           for rule in ruleset["rules"] if rule["type"] == "required_status_checks")
    assert {check["context"] for check in required_checks} == gates
    assert all(check["integration_id"] == 15368 for check in required_checks)

    jobs = workflows["app"]["jobs"]
    quality, package = jobs["quality"], jobs["package"]
    assert quality["runs-on"].startswith("ubuntu-")
    assert package["needs"] == ["changes", "quality"]
    assert package["if"] == quality["if"]
    assert {item["platform"] for item in package["strategy"]["matrix"]["include"]} == {"Windows", "macOS"}
    quality_commands = "\n".join(step.get("run", "") for step in quality["steps"])
    package_commands = "\n".join(step.get("run", "") for step in package["steps"])
    for command in ("npm run check:ui", "npm run test:browser", "npm audit",
                    "export-contracts.py --check", "check-fixtures.py", "cargo fmt", "make audit-rust",
                    "server/tests/test_ci_scope.py", "server/tests/test_release_checks.py"):
        assert command in quality_commands
        assert command not in package_commands
    assert "src-tauri/vendor" not in quality_commands
    quality_uploads = {
        step["with"]["name"]: step
        for step in quality["steps"] if step.get("uses", "").startswith("actions/upload-artifact@")
    }
    for name, path in (("app-browser", "app/test-results/browser/"), ("app-coverage", "coverage/app/")):
        upload = quality_uploads[name]
        assert upload["if"] == "${{ always() }}"
        assert upload["with"]["path"] == path
        assert upload["with"]["retention-days"] == "7"
    for command in ("cargo test --locked", "cargo clippy --locked", "--all-targets -- -D warnings",
                    "prepare-package.py", "npm run tauri -- build"):
        assert command in package_commands
    assert "npm run build" not in package_commands  # Tauri already invokes beforeBuildCommand.
    for platform in ("Windows", "macOS"):
        commands = "\n".join(step.get("run", "") for step in package["steps"]
                             if step.get("if") == f"runner.os == '{platform}'")
        assert "check-installer.py" in commands
        assert "check-office.py" not in commands and "Start-Process" not in commands
        if platform != "macOS":
            assert "native_keychain_roundtrip -- --ignored" in commands
    uploads = [step for step in package["steps"] if step.get("uses", "").startswith("actions/upload-artifact@")]
    by_name = {step["with"]["name"]: step for step in uploads}
    reports = by_name["desktop-checks-${{ matrix.platform }}"]
    installers = by_name["PractiQ-${{ matrix.platform }}"]
    assert reports["if"] == "${{ always() }}" and reports["with"]["retention-days"] == "7"
    assert installers["if"] == "github.event_name != 'pull_request'"
    assert installers["with"]["retention-days"] == "14"


def test_service_web_upload_covers_configured_nonhidden_report_outputs():
    root = Path(__file__).resolve().parents[2]
    workflow = yaml.load((root / ".github/workflows/server.yml").read_text(), Loader=yaml.BaseLoader)
    upload, = (
        step for step in workflow["jobs"]["quality"]["steps"]
        if step.get("uses", "").startswith("actions/upload-artifact@")
        and step["with"].get("name") == "service-web-checks"
    )
    assert upload["if"] == "${{ always() }}"
    assert upload["with"]["if-no-files-found"] == "error"
    upload_roots = [(root / line.strip()).resolve() for line in upload["with"]["path"].splitlines()]
    assert re.search(r"\breportOnFailure:\s*true\b", (root / "web/vite.config.ts").read_text())
    for config, option in (("vite.config.ts", "reportsDirectory"), ("playwright.config.mjs", "outputFile")):
        matches = re.findall(rf"\b{option}:\s*([\"'])(.*?)\1", (root / "web" / config).read_text())
        (_, relative), = matches
        output = (root / "web" / relative).resolve()
        assert not any(part.startswith(".") for part in output.relative_to(root).parts)
        assert any(output == directory or directory in output.parents for directory in upload_roots), output


def test_android_ci_uses_the_actual_apk_runtime_and_emulator_not_linux_application():
    root = Path(__file__).resolve().parents[2]
    workflow = yaml.load((root / ".github/workflows/app.yml").read_text(), Loader=yaml.BaseLoader)
    jobs = workflow["jobs"]
    for name in ("android-package", "emulator"):
        job = jobs[name]
        assert job["needs"] == ["changes", "quality"]
        commands = "\n".join(step.get("run", "") for step in job["steps"])
        assert "--split-per-abi" in commands
        assert "exportRuntimeNoticeInventory" in commands and "--android-runtime-inventory" in commands
        assert "check-apk.py" in commands and "--aapt2" in commands
        assert "--write-locks" not in commands  # CI consumes reviewed locks; it does not accept a new closure.
        assert "--release" not in commands  # Test keys are not publisher signing.
        assert not any("tauri -- build" in step.get("run", "") for step in job["steps"])
        sdk = next(step for step in job["steps"] if step.get("uses", "").startswith("android-actions/setup-android@"))
        assert "android-36" in sdk["with"]["packages"] and "ndk;28.2.13676358" in sdk["with"]["packages"]
        java = next(step for step in job["steps"] if step.get("uses", "").startswith("actions/setup-java@"))
        assert java["with"]["java-version"] == "21"
    emulator = next(step for step in jobs["emulator"]["steps"] if step.get("uses", "").startswith("ReactiveCircus/android-emulator-runner@"))
    assert emulator["with"]["api-level"] == "35" and emulator["with"]["arch"] == "x86_64"
    assert "connectedX86_64DebugAndroidTest" in emulator["with"]["script"]
    assert "-x rustBuildX86_64Debug" in emulator["with"]["script"]
