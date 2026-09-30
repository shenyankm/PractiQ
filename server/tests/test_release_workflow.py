"""Release candidates remain bound to source, final bytes and required evidence."""

import json
import os
import runpy
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace

import pytest
import yaml

ROOT = Path(__file__).parents[2]


@pytest.fixture
def release():
    return SimpleNamespace(**runpy.run_path(str(ROOT / "app/scripts/release.py")))


@pytest.fixture
def source(tmp_path):
    for name in ("app/package.json", "app/package-lock.json", "app/src-tauri/Cargo.toml",
                 "app/src-tauri/Cargo.lock", "app/src-tauri/tauri.conf.json", "server/pyproject.toml",
                 ".github/RELEASE_TEMPLATE.md"):
        destination = tmp_path / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, destination)
    return tmp_path


@pytest.mark.parametrize("tag", ["v01.1.0", "v0.1.0-alpha.01", "v0.1.0-nightly.1", "0.1.0", "v0.1.0;echo bad"])
def test_release_rejects_noncanonical_tags(release, source, tag):
    with pytest.raises(ValueError, match="Use vX"):
        release.versions(source, tag)


def test_release_versions_preserve_independent_service_and_reject_lock_drift(release, source):
    assert release.versions(source, "v0.1.0") == {"desktop": "0.1.0", "aiService": "0.3.0"}
    lock = source / "app/package-lock.json"
    payload = json.loads(lock.read_text())
    payload["packages"][""]["version"] = "0.1.1"
    lock.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="must match"):
        release.versions(source, "v0.1.0")


def test_release_candidate_requires_clean_tagged_main_ancestor(release, source):
    def git(*args):
        return subprocess.check_output(["git", "-c", "user.name=Release test", "-c",
                                        "user.email=release@example.test", "-c", "core.hooksPath=/dev/null",
                                        *args], cwd=source, text=True).strip()
    git("init", "-q")
    git("add", ".")
    git("commit", "-qm", "Candidate")
    git("update-ref", "refs/remotes/origin/main", "HEAD")
    git("tag", "-a", "v0.1.0", "-m", "Candidate")
    candidate = release.check_candidate(source, "v0.1.0")
    assert candidate["commit"] == git("rev-parse", "HEAD") and not candidate["prerelease"]
    (source / "untracked.txt").write_text("uncommitted source")
    with pytest.raises(ValueError, match="clean"):
        release.check_candidate(source, "v0.1.0")
    git("add", ".")
    git("commit", "-qm", "After tag")
    with pytest.raises(ValueError, match="existing candidate"):
        release.check_candidate(source, "v0.1.0")
    git("tag", "-d", "v0.1.0")
    git("tag", "v0.1.0")
    with pytest.raises(subprocess.CalledProcessError):
        release.check_candidate(source, "v0.1.0")


@pytest.fixture
def staged(release, source, monkeypatch):
    monkeypatch.setitem(release.assemble.__globals__, "git", lambda *_: "a" * 40)
    inputs = source / "inputs"
    for platform, (os_name, arch, _, suffix) in release.PLATFORMS.items():
        folder = inputs / f"release-{os_name}"
        evidence = folder / "evidence"
        evidence.mkdir(parents=True)
        filename = f"PractiQ_0.1.0_{os_name}_{arch}{suffix}"
        (folder / filename).write_bytes(b"synthetic installer")
        for report in ("desktop-bundle.json", "office.json", "office-fidelity.json", "licenses.json"):
            (evidence / report).write_text('{"passed":true}')
        (evidence / "build-manifest.json").write_text(json.dumps({
            "platform": platform, "architecture": "arm64" if platform == "darwin" else "x86_64",
            "packages": [{"name": "practiq-ai-service", "version": "0.3.0"}],
        }))
        for notice_name in ("THIRD-PARTY.txt", "PYTHON-LICENSE.txt"):
            (evidence / notice_name).write_text("Synthetic notice")
        candidate = {"tag": "v0.1.0", "commit": "a" * 40,
                     "components": release.versions(source, "v0.1.0"), "os": os_name,
                     "architecture": arch, "file": filename, "sizeBytes": (folder / filename).stat().st_size,
                     "sha256": release.checksum(folder / filename), "signing": "unsigned",
                     "evidence": {f"evidence/{p.name}": release.checksum(p) for p in evidence.iterdir()}}
        (folder / "candidate.json").write_text(json.dumps(candidate))
    service = inputs / "service-checks"
    service.mkdir()
    for name in ("probes.json", "probes.md", "probes.xml", "coverage.xml"):
        (service / name).write_text("synthetic service evidence")
    return inputs


def test_release_assembly_hashes_every_public_asset_and_keeps_acceptance_pending(release, source, staged):
    output = source / "assets"
    release.assemble(source, "v0.1.0", staged, output)
    checksums = (output / "SHA256SUMS.txt").read_text().splitlines()
    assert len(checksums) == 5
    for row in checksums:
        digest, filename = row.split("  ")
        assert digest == release.checksum(output / filename)
    manifest = json.loads((output / "release-manifest.json").read_text())
    assert manifest["commit"] == "a" * 40 and "pending" in manifest["publicationStatus"]
    assert len(manifest["assets"]) == 3
    with zipfile.ZipFile(output / "release-evidence.zip") as archive:
        assert "macos/evidence/office-fidelity.json" in archive.namelist()
        assert "service/probes.json" in archive.namelist()
    notes = (output / "RELEASE_NOTES.md").read_text()
    assert "@VERSION@" not in notes and "0.3.0" in notes and "[ ]" in notes
    with pytest.raises(FileExistsError):
        release.assemble(source, "v0.1.0", staged, output)


@pytest.mark.parametrize("mutation", ["missing_platform", "commit", "asset", "evidence", "failed_gate", "escape", "missing_notice", "missing_service"])
def test_release_assembly_rejects_mixed_altered_or_incomplete_candidates(release, source, staged, mutation):
    folder = staged / "release-macos"
    candidate_path = folder / "candidate.json"
    candidate = json.loads(candidate_path.read_text())
    if mutation == "missing_platform":
        candidate_path.unlink()
    elif mutation == "commit":
        candidate["commit"] = "b" * 40
    elif mutation == "asset":
        (folder / candidate["file"]).write_bytes(b"changed installer")
    elif mutation == "evidence":
        (folder / "evidence/office-fidelity.json").write_text("altered evidence")
    elif mutation == "failed_gate":
        path = folder / "evidence/office-fidelity.json"
        path.write_text('{"passed":false}')
        candidate["evidence"]["evidence/office-fidelity.json"] = release.checksum(path)
    elif mutation == "escape":
        candidate["evidence"]["../outside.json"] = "a" * 64
    elif mutation == "missing_notice":
        candidate["evidence"].pop("evidence/THIRD-PARTY.txt")
    else:
        (staged / "service-checks/coverage.xml").unlink()
    if mutation != "missing_platform":
        candidate_path.write_text(json.dumps(candidate))
    with pytest.raises(ValueError):
        release.assemble(source, "v0.1.0", staged, source / "assets")
    assert not (source / "assets").exists()


def test_release_stage_propagates_strict_gate_failure_before_copying_assets(release, source, monkeypatch):
    bundle = source / "bundle"
    bundle.mkdir()
    (bundle / "build-manifest.json").write_text('{"platform":"darwin","architecture":"arm64","packages":[{"name":"practiq-ai-service","version":"0.3.0"}]}')
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setitem(release.stage.__globals__, "git", lambda *_: "")
    calls = []
    def run(command, **kwargs):
        calls.append(command)
        report = Path(command[command.index("--output") + 1])
        report.write_text('{"passed":true}')
        if "--fidelity-only" in command:
            raise subprocess.CalledProcessError(1, command)
    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(subprocess.CalledProcessError):
        release.stage(source, "v0.1.0", bundle, source / "installer.dmg", source / "assets")
    assert len(calls) == 3 and "--isolated" in calls[1]
    assert not (source / "assets").exists()


def test_windows_stage_uses_portable_evidence_paths_for_linux_assembly(release, source, monkeypatch):
    bundle, output = source / "bundle", source / "assets"
    bundle.mkdir()
    (bundle / "build-manifest.json").write_text('{"platform":"win32","architecture":"AMD64","packages":[{"name":"practiq-ai-service","version":"0.3.0"}]}')
    for filename in ("THIRD-PARTY.txt", "PYTHON-LICENSE.txt"):
        (bundle / filename).write_text("Synthetic notice")
    installer = source / "installer.exe"
    installer.write_bytes(b"synthetic installer")
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setitem(release.stage.__globals__, "git", lambda root, *args: "" if args[0] == "status" else "a" * 40)
    for key, value in {"GITHUB_SERVER_URL": "https://github.com", "GITHUB_REPOSITORY": "test/repo", "GITHUB_RUN_ID": "1"}.items():
        monkeypatch.setenv(key, value)
    def run(command, **kwargs):
        Path(command[command.index("--output") + 1]).write_text('{"passed":true}')
    monkeypatch.setattr(subprocess, "run", run)
    relative_to = Path.relative_to
    def windows_relative_path(path, *args, **kwargs):
        relative = relative_to(path, *args, **kwargs)
        return PureWindowsPath(relative) if args == (output,) else relative
    monkeypatch.setattr(Path, "relative_to", windows_relative_path)
    release.stage(source, "v0.1.0", bundle, installer, output)
    candidate = json.loads((output / "candidate.json").read_text())
    assert "evidence/office-fidelity.json" in candidate["evidence"]
    assert all("\\" not in path for path in candidate["evidence"])


def test_signed_dmg_contains_stapled_app_and_existing_dmg_is_preserved(tmp_path):
    app = tmp_path / "PractiQ.app"
    (app / "Contents").mkdir(parents=True)
    tools = tmp_path / "tools"
    tools.mkdir()
    shim = tools / "shim"
    shim.write_text(f"#!{sys.executable}\n" + '''
import json, os, shutil, sys
from pathlib import Path
name, args = Path(sys.argv[0]).name, sys.argv[1:]
with Path(os.environ["SIGN_LOG"]).open("a") as log:
    log.write(json.dumps([name, args]) + "\\n")
if name == "xcrun" and args[:2] == ["stapler", "staple"] and args[-1].endswith(".app"):
    (Path(args[-1]) / "stapled").touch()
elif name == "ditto":
    if args[0] == "-c":
        Path(args[-1]).touch()
    else:
        shutil.copytree(args[0], args[1])
elif name == "hdiutil":
    assert (Path(args[args.index("-srcfolder") + 1]) / "PractiQ.app/stapled").exists()
    Path(args[-1]).write_text("signed image")
''')
    shim.chmod(0o755)
    for name in ("codesign", "xcrun", "ditto", "hdiutil", "spctl"):
        (tools / name).symlink_to(shim)
    log = tmp_path / "sign.jsonl"
    environment = {**os.environ, "PATH": f"{tools}{os.pathsep}{os.environ['PATH']}",
                   "SIGN_LOG": str(log), "APPLE_SIGNING_IDENTITY": "Synthetic identity",
                   "APPLE_NOTARY_PROFILE": "Synthetic profile"}
    dmg = tmp_path / "final.dmg"
    command = ["bash", str(ROOT / "app/scripts/sign-release.sh"), str(app), str(dmg)]
    subprocess.run(command, env=environment, check=True, capture_output=True)
    calls = [json.loads(row) for row in log.read_text().splitlines()]
    assert calls.index(["xcrun", ["stapler", "staple", str(app)]]) < next(i for i, c in enumerate(calls) if c[0] == "hdiutil")
    assert ["xcrun", ["stapler", "validate", str(dmg)]] in calls
    before = log.read_bytes()
    result = subprocess.run(command, env=environment, check=False, capture_output=True)
    assert result.returncode != 0 and dmg.read_text() == "signed image" and log.read_bytes() == before


def test_release_workflow_uses_full_checks_and_only_creates_drafts():
    workflow = yaml.load((ROOT / ".github/workflows/release.yml").read_text(), Loader=yaml.BaseLoader)
    assert set(workflow["on"]) == {"workflow_dispatch"}
    assert workflow["permissions"] == {"contents": "read"}
    for name in ("server", "desktop"):
        reused = yaml.load((ROOT / f".github/workflows/{name}.yml").read_text(), Loader=yaml.BaseLoader)
        assert "workflow_call" in reused["on"]
        for job in reused["jobs"].values():
            for step in job["steps"]:
                if step.get("uses", "").startswith("actions/checkout@"):
                    assert step["with"]["ref"] == "${{ inputs.ref || github.sha }}"
        selector = next(s for s in reused["jobs"]["changes"]["steps"] if s.get("id") == "scope")
        assert selector["env"]["CI_FULL_CHECKS"] == "${{ inputs.ref != '' }}"
    assert workflow["jobs"]["draft"]["needs"] == ["candidate", "service", "desktop"]
    commands = "\n".join(s.get("run", "") for s in workflow["jobs"]["draft"]["steps"])
    assert "--draft --verify-tag --latest=false" in commands and "--clobber" not in commands
    assert "remote_sha" in commands and "release publish" not in commands
