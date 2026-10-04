"""Release candidates remain bound to source, final bytes and required evidence."""

import hashlib
import json
import os
import plistlib
import runpy
import shutil
import struct
import subprocess
import sys
import zipfile
from contextlib import contextmanager
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
                 "app/src-tauri/Cargo.lock", "app/src-tauri/tauri.conf.json", "app/src-tauri/tauri.linux.conf.json", "server/pyproject.toml",
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
    assert release.versions(source, "v0.1.0") == {"desktop": "0.1.0", "aiServiceSource": "0.3.0"}
    lock = source / "app/package-lock.json"
    payload = json.loads(lock.read_text())
    payload["packages"][""]["version"] = "0.1.1"
    lock.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="must match"):
        release.versions(source, "v0.1.0")


@pytest.mark.parametrize("field,value", [("packageMode", "bundled-ai"), ("packageSchemaVersion", 1)])
def test_release_assembly_rejects_old_embedded_engine_candidate_mode(release, source, staged, field, value):
    candidate_path = staged / "release-macos/candidate.json"
    candidate = json.loads(candidate_path.read_text())
    candidate[field] = value
    candidate_path.write_text(json.dumps(candidate))
    with pytest.raises(ValueError, match="desktop-practice"):
        release.assemble(source, "v0.1.0", staged, source / "assets")
    assert not (source / "assets").exists()


@pytest.mark.parametrize("fault", ["architecture", "depends"])
def test_final_deb_checks_actual_architecture_and_required_native_dependencies(release, tmp_path, monkeypatch, fault):
    monkeypatch.setattr(sys, "platform", "linux")
    installer = tmp_path / "final.deb"
    installer.write_bytes(b"Synthetic DEB")
    def field(command, **kwargs):
        return ("arm64" if fault == "architecture" else "amd64") if command[-1] == "Architecture" else ("libgtk-3-0" if fault == "depends" else "libwebkit2gtk-4.1-0, libgtk-3-0, libdbus-1-3, gstreamer1.0-plugins-good, gstreamer1.0-plugins-bad, gstreamer1.0-libav")
    def extract(command, **kwargs):
        (Path(command[-1]) / "usr/lib/PractiQ/bundled").mkdir(parents=True)
    monkeypatch.setattr(subprocess, "check_output", field)
    monkeypatch.setattr(subprocess, "run", extract)
    with pytest.raises(ValueError, match="architecture|dependencies"), release.final_bundle(installer):
        pass


@pytest.mark.parametrize("fault", [None, "configured_dependency", "alternative", "empty_architecture"])
def test_deb_checks_candidate_configuration_and_dependency_qualifiers(release, source, monkeypatch, fault):
    config = source / "app/src-tauri/tauri.linux.conf.json"
    config.write_text(json.dumps({"bundle": {"linux": {"deb": {"depends": ["candidate-runtime-library"]}}}}))
    dependencies = "libwebkit2gtk-4.1-0:amd64 (>= 2.40), libgtk-3-0:any (>= 3.24)"
    if fault != "configured_dependency":
        dependencies += ", candidate-runtime-library"
    if fault == "alternative":
        dependencies = dependencies.replace("libgtk-3-0:any (>= 3.24)", "libgtk-3-0 | optional-alternative")
    def field(command, **kwargs):
        return ("" if fault == "empty_architecture" else "amd64") if command[-1] == "Architecture" else dependencies
    monkeypatch.setattr(subprocess, "check_output", field)
    if fault:
        with pytest.raises(ValueError, match="architecture|dependencies"):
            release.check_deb_metadata(source / "candidate.deb", source)
    else:
        release.check_deb_metadata(source / "candidate.deb", source)


@pytest.mark.parametrize("fault", ["missing", "file", "parent_symlink"])
def test_final_resources_require_real_directory_chain_in_the_same_payload(release, tmp_path, fault):
    payload = tmp_path / "payload"
    payload.mkdir()
    bundle = payload / "resources/bundled"
    if fault == "parent_symlink":
        internal = payload / "internal"
        (internal / "bundled").mkdir(parents=True)
        bundle.parent.symlink_to(internal, target_is_directory=True)
    else:
        bundle.parent.mkdir()
        if fault == "file":
            bundle.write_bytes(b"Resource path is a file")
    with pytest.raises(ValueError, match="real contained directories"):
        release.contained_bundle(payload, bundle)


@pytest.mark.parametrize("fault", ["absolute_internal", "absolute_external", "relative_external", "dangling"])
def test_final_resources_reject_leaf_links_not_bound_to_relative_payload_bytes(release, tmp_path, fault):
    payload = tmp_path / "payload"
    bundle = payload / "resources/bundled"
    bundle.mkdir(parents=True)
    internal = bundle / "real-notices.txt"
    internal.write_text("Notices")
    external = tmp_path / "host-notices.txt"
    external.write_text("Host notices")
    target = {"absolute_internal": internal, "absolute_external": external,
              "relative_external": "../../../host-notices.txt", "dangling": "missing.txt"}[fault]
    (bundle / "THIRD-PARTY.txt").symlink_to(target)
    with pytest.raises(ValueError, match="bundle|payload"):
        release.contained_bundle(payload, bundle)


def test_final_resources_accept_a_relative_link_to_bytes_inside_the_bundle(release, tmp_path):
    payload = tmp_path / "payload"
    bundle = payload / "resources/bundled"
    bundle.mkdir(parents=True)
    (bundle / "real-notices.txt").write_text("Notices")
    (bundle / "THIRD-PARTY.txt").symlink_to("real-notices.txt")
    assert release.contained_bundle(payload, bundle) == bundle


def test_macos_desktop_version_rejects_a_host_plist_symlink(release, tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    bundle = tmp_path / "PractiQ.app/Contents/Resources/bundled"
    bundle.mkdir(parents=True)
    host = tmp_path / "host.plist"
    host.write_bytes(plistlib.dumps({"CFBundleShortVersionString": "0.1.0"}))
    (bundle.parents[1] / "Info.plist").symlink_to(host)
    with pytest.raises(ValueError, match="Info.plist"):
        release.check_desktop_version(tmp_path / "selected.dmg", bundle, "0.1.0", "PractiQ")


@pytest.mark.parametrize("platform,fault", [("darwin", "missing"), ("darwin", "symlink"),
                                           ("darwin", "executable_identity"), ("linux", "missing"),
                                           ("linux", "symlink"), ("linux", "parent_symlink"),
                                           ("win32", "symlink"), ("darwin", "empty"),
                                           ("linux", "empty"), ("win32", "empty")])
def test_native_version_checks_require_the_actual_contained_application(release, tmp_path, monkeypatch, platform, fault):
    monkeypatch.setattr(sys, "platform", platform)
    application = tmp_path / "payload"
    if platform == "darwin":
        bundle = application / "PractiQ.app/Contents/Resources/bundled"
        executable = application / "PractiQ.app/Contents/MacOS/PractiQ"
    elif platform == "linux":
        bundle = application / "usr/lib/PractiQ/bundled"
        executable = application / "usr/bin/PractiQ"
    else:
        bundle = application / "bundled"
        executable = application / "PractiQ.exe"
    bundle.mkdir(parents=True)
    executable.parent.mkdir(parents=True, exist_ok=True)
    if platform == "darwin":
        (bundle.parents[1] / "Info.plist").write_bytes(plistlib.dumps({"CFBundleShortVersionString": "0.1.0",
            "CFBundleExecutable": "Unrelated" if fault == "executable_identity" else "PractiQ"}))
    host = tmp_path / "host-native"
    host.write_bytes(b"Native bytes from an unrelated path")
    if fault == "symlink":
        executable.symlink_to(host)
    elif fault == "parent_symlink":
        executable.parent.rmdir()
        host_directory = tmp_path / "host-bin"
        host_directory.mkdir()
        (host_directory / executable.name).write_bytes(b"Native bytes outside the payload")
        executable.parent.symlink_to(host_directory, target_is_directory=True)
    elif fault == "executable_identity":
        executable.write_bytes(b"Native executable")
    elif fault == "empty":
        executable.touch()
    monkeypatch.setattr(subprocess, "check_output", lambda *args, **kwargs: "0.1.0")
    with pytest.raises(ValueError, match="native|executable|Info.plist"):
        release.check_desktop_version(tmp_path / "candidate", bundle, "0.1.0", "PractiQ")


@pytest.mark.parametrize("platform", ["darwin", "linux"])
def test_final_package_rejects_bundle_symlink_to_an_unrelated_local_directory(release, tmp_path, monkeypatch, platform):
    monkeypatch.setattr(sys, "platform", platform)
    installer = tmp_path / ("final.dmg" if platform == "darwin" else "final.deb")
    installer.write_bytes(b"Synthetic installer")
    unrelated = tmp_path / "unrelated-bundle"
    unrelated.mkdir()
    def extract(command, **kwargs):
        if command[0] == "hdiutil":
            if command[1] == "detach":
                return
            base = Path(command[command.index("-mountpoint") + 1])
            bundle = base / "PractiQ.app/Contents/Resources/bundled"
        else:
            bundle = Path(command[-1]) / "usr/lib/PractiQ/bundled"
        bundle.parent.mkdir(parents=True)
        bundle.symlink_to(unrelated, target_is_directory=True)
    monkeypatch.setattr(subprocess, "run", extract)
    monkeypatch.setattr(subprocess, "check_output", lambda cmd, **kw: "amd64" if cmd[-1] == "Architecture" else "libwebkit2gtk-4.1-0, libgtk-3-0, libdbus-1-3, gstreamer1.0-plugins-good, gstreamer1.0-plugins-bad, gstreamer1.0-libav")
    with pytest.raises(ValueError, match="bundle|payload"), release.final_bundle(installer):
        pass


@pytest.mark.parametrize("mutation", ["original", "snapshot"])
def test_unsigned_stage_uses_checked_snapshot_when_original_installer_path_changes(release, source, monkeypatch, mutation):
    monkeypatch.setattr(sys, "platform", "darwin")
    installer = source / "app/src-tauri/target/release/bundle/dmg/final.dmg"
    installer.parent.mkdir(parents=True)
    installer.write_bytes(b"Checked original installer")
    bundle = source / "checked-payload/PractiQ.app/Contents/Resources/bundled"
    bundle.mkdir(parents=True)
    (bundle / "build-manifest.json").write_text(json.dumps({"schemaVersion": 2, "packageMode": "desktop-practice", "platform": "darwin", "architecture": "arm64", "desktopVersion": "0.1.0"}))
    (bundle / "THIRD-PARTY.txt").write_text("Synthetic notice")
    @contextmanager
    def extracted(path, *args, **kwargs):
        assert path.read_bytes() == b"Checked original installer"
        yield bundle
    def version(path, *args):
        target = installer if mutation == "original" else path
        target.chmod(0o600)
        target.write_bytes(b"Unchecked replacement installer")
        return "0.1.0"
    def gate(command, **kwargs):
        Path(command[command.index("--output") + 1]).write_text('{"passed":true}')
        if "--notices" in command:
            Path(command[command.index("--notices") + 1]).write_text("Synthetic notice")
    monkeypatch.setitem(release.stage_installer.__globals__, "final_bundle", extracted)
    monkeypatch.setitem(release.stage_installer.__globals__, "check_desktop_version", version)
    monkeypatch.setitem(release.stage_installer.__globals__, "git", lambda root, *args: "" if args[0] == "status" else "a" * 40)
    monkeypatch.setattr(subprocess, "run", gate)
    for key, value in {"GITHUB_SERVER_URL": "https://github.com", "GITHUB_REPOSITORY": "test/repo", "GITHUB_RUN_ID": "1"}.items():
        monkeypatch.setenv(key, value)
    output = source / "app/.build/release"
    if mutation == "snapshot":
        with pytest.raises(ValueError, match="snapshot"):
            release.stage_installer(source, "v0.1.0")
        assert not output.exists()
        return
    release.stage_installer(source, "v0.1.0")
    candidate = json.loads((output / "candidate.json").read_text())
    assert (output / candidate["file"]).read_bytes() == b"Checked original installer"
    assert candidate["sha256"] == hashlib.sha256(b"Checked original installer").hexdigest()


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
        for report in ("desktop-bundle.json", "licenses.json"):
            (evidence / report).write_text('{"passed":true}')
        (evidence / "build-manifest.json").write_text(json.dumps({
            "platform": platform, "architecture": "arm64" if platform == "darwin" else "x86_64",
            "schemaVersion": 2, "packageMode": "desktop-practice", "desktopVersion": "0.1.0",
        }))
        for notice_name in ("THIRD-PARTY.txt", "expected-THIRD-PARTY.txt"):
            (evidence / notice_name).write_text("Synthetic notice")
        (evidence / "notices-match.json").write_text(json.dumps({"passed": True, "sha256": release.checksum(evidence / "THIRD-PARTY.txt")}))
        (evidence / "desktop-version.json").write_text(json.dumps({"passed": True, "platform": platform, "version": "0.1.0"}))
        candidate = {"packageSchemaVersion": 2, "packageMode": "desktop-practice", "tag": "v0.1.0", "commit": "a" * 40,
                     "components": release.versions(source, "v0.1.0"), "os": os_name,
                     "architecture": arch, "file": filename, "sizeBytes": (folder / filename).stat().st_size,
                     "sha256": release.checksum(folder / filename), "signing": "unsigned",
                     "buildRun": "https://github.com/test/repo/actions/runs/42",
                     "cleanMachineAcceptance": "pending", "liveModelAcceptance": "pending",
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
        assert "macos/evidence/licenses.json" in archive.namelist()
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
        (folder / "evidence/licenses.json").write_text("altered evidence")
    elif mutation == "failed_gate":
        path = folder / "evidence/licenses.json"
        path.write_text('{"passed":false}')
        candidate["evidence"]["evidence/licenses.json"] = release.checksum(path)
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
    (bundle / "build-manifest.json").write_text('{"platform":"darwin","architecture":"arm64","schemaVersion":2,"packageMode":"desktop-practice","desktopVersion":"0.1.0"}')
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setitem(release.stage.__globals__, "git", lambda *_: "")
    calls = []
    def run(command, **kwargs):
        calls.append(command)
        report = Path(command[command.index("--output") + 1])
        report.write_text('{"passed":true}')
        if "check_licenses.py" in command[1]:
            raise subprocess.CalledProcessError(1, command)
    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(subprocess.CalledProcessError):
        release.stage(source, "v0.1.0", bundle, source / "installer.dmg", source / "assets")
    assert len(calls) == 2 and "check_licenses.py" in calls[1][1]
    assert not (source / "assets").exists()


@pytest.mark.parametrize("mutation", ["asset", "evidence", "candidate", "service"])
def test_assembly_rejects_mutated_inputs_during_final_copy_and_archive_handoff(release, source, staged, monkeypatch, mutation):
    copyfile = shutil.copyfile
    archive_write = zipfile.ZipFile.write
    mutated = False
    def copy(path, destination, *args, **kwargs):
        nonlocal mutated
        if mutation == "asset" and not mutated:
            Path(path).write_bytes(b"Unchecked replacement asset")
            mutated = True
        return copyfile(path, destination, *args, **kwargs)
    def write(archive, path, arcname=None, *args, **kwargs):
        nonlocal mutated
        if not mutated and ((mutation == "evidence" and arcname == "macos/evidence/licenses.json") or
                            (mutation == "candidate" and arcname == "macos/candidate.json") or
                            (mutation == "service" and arcname == "service/probes.json")):
            Path(path).write_text('{"passed":false}')
            mutated = True
        return archive_write(archive, path, arcname, *args, **kwargs)
    monkeypatch.setattr(shutil, "copyfile", copy)
    monkeypatch.setattr(zipfile.ZipFile, "write", write)
    output = source / "assembled-assets"
    with pytest.raises(ValueError, match="handoff|changed|identity"):
        release.assemble(source, "v0.1.0", staged, output)
    assert mutated and not output.exists()


def test_windows_stage_uses_portable_evidence_paths_for_linux_assembly(release, source, monkeypatch):
    bundle, output = source / "bundle", source / "assets"
    bundle.mkdir()
    (bundle / "build-manifest.json").write_text('{"platform":"win32","architecture":"AMD64","schemaVersion":2,"packageMode":"desktop-practice","desktopVersion":"0.1.0"}')
    for filename in ("THIRD-PARTY.txt",):
        (bundle / filename).write_text("Synthetic notice")
    installer = source / "installer.exe"
    installer.write_bytes(b"synthetic installer")
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setitem(release.stage.__globals__, "git", lambda root, *args: "" if args[0] == "status" else "a" * 40)
    for key, value in {"GITHUB_SERVER_URL": "https://github.com", "GITHUB_REPOSITORY": "test/repo", "GITHUB_RUN_ID": "1"}.items():
        monkeypatch.setenv(key, value)
    def run(command, **kwargs):
        Path(command[command.index("--output") + 1]).write_text('{"passed":true}')
        if "--notices" in command:
            Path(command[command.index("--notices") + 1]).write_text("Synthetic notice")
    monkeypatch.setattr(subprocess, "run", run)
    relative_to = Path.relative_to
    def windows_relative_path(path, *args, **kwargs):
        relative = relative_to(path, *args, **kwargs)
        return PureWindowsPath(relative) if args == (output,) else relative
    monkeypatch.setattr(Path, "relative_to", windows_relative_path)
    release.stage(source, "v0.1.0", bundle, installer, output, desktop_version="0.1.0")
    candidate = json.loads((output / "candidate.json").read_text())
    assert "evidence/licenses.json" in candidate["evidence"]
    assert all("\\" not in path for path in candidate["evidence"])


@pytest.fixture
def final_setup(release, source, monkeypatch):
    def setup(platform="darwin", fault=None):
        monkeypatch.setattr(sys, "platform", platform)
        for key in ("RUNNER_TEMP", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"):
            monkeypatch.delenv(key, raising=False)
        state = {"head": "a" * 40, "calls": [], "mounted": [], "native": []}
        monkeypatch.setitem(release.restage_installer.__globals__, "check_candidate", lambda *_: {"commit": "a" * 40})
        monkeypatch.setitem(release.stage.__globals__, "git", lambda root, *args: "" if args[0] == "status" else state["head"])
        suffix = {"darwin": ".dmg", "win32": ".exe", "linux": ".deb"}[platform]
        installer = source / "signed" / ("selected-final" + suffix)
        installer.parent.mkdir()
        installer.write_bytes(b"selected final installer bytes")
        stale = source / "app/src-tauri/target/release/bundle" / ("old-unsigned" + suffix)
        stale.parent.mkdir(parents=True)
        stale.write_bytes(b"stale unsigned bytes must not be selected")
        output, reports = source / "final-assets", source / "fresh-reports"
        original = source / "original-build"
        original_evidence = original / "evidence"
        original_evidence.mkdir(parents=True)
        os_name, arch, _, asset_suffix = release.PLATFORMS[platform]
        original_name = f"PractiQ_0.1.0_{os_name}_{arch}{asset_suffix}"
        (original / original_name).write_bytes(b"original unsigned installer")
        for name in ("desktop-bundle.json", "licenses.json"):
            (original_evidence / name).write_text('{"passed":true}')
        (original_evidence / "build-manifest.json").write_text(json.dumps({
            "platform": platform, "architecture": "arm64" if platform == "darwin" else "x86_64",
            "schemaVersion": 2, "packageMode": "desktop-practice", "desktopVersion": "0.1.0"}))
        (original_evidence / "desktop-version.json").write_text(json.dumps({"passed": True, "platform": platform, "version": "0.1.0"}))
        state["build_candidate"] = original / "candidate.json"
        state["build_candidate"].write_text(json.dumps({
            "packageSchemaVersion": 2, "packageMode": "desktop-practice", "tag": "v0.1.0", "commit": "a" * 40, "components": release.versions(source, "v0.1.0"),
            "os": os_name, "architecture": arch, "file": original_name,
            "sha256": release.checksum(original / original_name), "sizeBytes": (original / original_name).stat().st_size,
            "buildRun": "https://github.com/test/repo/actions/runs/42", "signing": "unsigned",
            "evidence": {"evidence/" + path.name: release.checksum(path) for path in original_evidence.iterdir()}}))

        def make_bundle(bundle):
            bundle.mkdir(parents=True)
            (bundle / "build-manifest.json").write_text(json.dumps({
                "platform": platform, "architecture": "arm64" if platform == "darwin" else "x86_64",
                "schemaVersion": 2, "packageMode": "desktop-practice", "desktopVersion": "0.1.0",
            }))
            for name in ("THIRD-PARTY.txt",):
                (bundle / name).write_text("Synthetic candidate notice")
            if platform == "darwin":
                (bundle.parents[1] / "Info.plist").write_bytes(plistlib.dumps({"CFBundleShortVersionString": "0.2.0" if fault == "desktop_version" else "0.1.0", "CFBundleExecutable": "PractiQ"}))
                executable = bundle.parents[1] / "MacOS/PractiQ"
                executable.parent.mkdir()
                payload = native_macho() if platform == "darwin" else native_elf()
                if fault == "native_wrong_arch":
                    payload = native_macho(0x1000007) if platform == "darwin" else native_elf(183)
                elif fault == "native_script":
                    payload = b"#!/bin/sh\nexit 0\n"
                elif fault == "native_truncated":
                    payload = payload[:24]
                elif fault == "native_not_executable":
                    payload = native_macho(filetype=6) if platform == "darwin" else native_elf(filetype=1)
                executable.write_bytes(state.get("native_payload", payload))
                executable.chmod(state.get("native_mode", 0o755))
            elif platform == "win32":
                (bundle.parent / "PractiQ.exe").write_bytes(native_pe())
                (bundle.parent / "uninstall.exe").write_bytes(b"synthetic uninstaller")
            else:
                executable = bundle.parents[3] / "usr/bin/PractiQ"
                executable.parent.mkdir(parents=True)
                payload = native_macho() if platform == "darwin" else native_elf()
                if fault == "native_wrong_arch":
                    payload = native_macho(0x1000007) if platform == "darwin" else native_elf(183)
                elif fault == "native_script":
                    payload = b"#!/bin/sh\nexit 0\n"
                elif fault == "native_truncated":
                    payload = payload[:24]
                elif fault == "native_not_executable":
                    payload = native_macho(filetype=6) if platform == "darwin" else native_elf(filetype=1)
                executable.write_bytes(state.get("native_payload", payload))
                executable.chmod(state.get("native_mode", 0o755))

        def run(command, **kwargs):
            state["native"].append(command)
            if command[0] == "hdiutil":
                if command[1] == "detach":
                    state["mounted"].append("detached")
                    if fault == "source_after_checks":
                        state["head"] = "b" * 40
                    if fault == "snapshot_after_checks":
                        state["snapshot"].chmod(0o600)
                        state["snapshot"].write_bytes(b"changed after package checks")
                    return
                snapshot = Path(command[2])
                bundle = Path(command[command.index("-mountpoint") + 1]) / "PractiQ.app/Contents/Resources/bundled"
            elif command[0] == "dpkg-deb":
                snapshot = Path(command[2])
                bundle = Path(command[3]) / "usr/lib/PractiQ/bundled"
            elif command[0] == "powershell":
                snapshot = Path(kwargs["env"]["PRACTIQ_RELEASE_INSTALLER"])
                bundle = Path(kwargs["env"]["PRACTIQ_RELEASE_DESTINATION"]) / "bundled"
                assert "Start-Process" in command[-1] and "'/S'" in command[-1]
                assert "$ErrorActionPreference = 'Stop'" in command[-1]
            elif command[0] == "7z":
                snapshot = Path(command[-1])
                bundle = Path(next(arg[2:] for arg in command if arg.startswith("-o"))) / "bundled"
            else:
                state["calls"].append(command)
                bundle = Path(command[command.index("--bundle") + 1])
                report = Path(command[command.index("--output") + 1])
                report.write_text(json.dumps({"passed": True, "bundle": str(bundle), "engine": {"path": str(bundle / "office/soffice")}, "packages": [{"texts": [{"path": "C:\\Users\\Maintainer\\private\\LICENSE"}, {"path": str(source / "private/LICENSE")}, {"path": "/Users/Another/private/LICENSE"}]}]}))
                if "check_licenses.py" in command[1] and fault == "gate":
                    raise subprocess.CalledProcessError(1, command)
                if "--notices" in command:
                    expected = Path(command[command.index("--notices") + 1])
                    expected.write_text("Changed notice" if fault == "notice" else "Synthetic candidate notice")
                    if fault == "missing_notice":
                        (bundle / "THIRD-PARTY.txt").unlink()
                    if fault == "source":
                        state["head"] = "b" * 40
                    if fault == "snapshot":
                        state["snapshot"].chmod(0o600)
                        state["snapshot"].write_bytes(b"changed snapshot")
                return
            assert snapshot != installer and snapshot.read_bytes() == installer.read_bytes()
            assert not snapshot.stat().st_mode & 0o222
            state["snapshot"] = snapshot
            make_bundle(bundle)

        monkeypatch.setattr(subprocess, "run", run)
        def check_output(command, **kwargs):
            if command[-1] == "Architecture":
                return "amd64"
            if command[-1] == "Depends":
                return "libwebkit2gtk-4.1-0, libgtk-3-0, libdbus-1-3, gstreamer1.0-plugins-good, gstreamer1.0-plugins-bad, gstreamer1.0-libav"
            if command[0] == "7z":
                return "Path = PractiQ.exe\nSize = 1\n\nPath = bundled/build-manifest.json\nSize = 1\n"
            return "0.2.0\n" if fault == "desktop_version" else "0.1.0\n"
        monkeypatch.setattr(subprocess, "check_output", check_output)
        monkeypatch.setattr(shutil, "which", lambda name: "7z" if name == "7z" else None)
        return installer, output, reports, state
    return setup


@pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
def test_explicit_final_staging_uses_selected_snapshot_and_fresh_reports_without_actions(release, source, final_setup, platform):
    installer, output, reports, state = final_setup(platform)
    signing = source / "independent-signing.json"
    signing.write_text(json.dumps({"artifactSha256": release.checksum(installer), "status": "verified", "verificationCommands": ["Synthetic verification evidence"]}))
    release.restage_installer(source, "v0.1.0", installer, output, reports, signing, state["build_candidate"])
    candidate = json.loads((output / "candidate.json").read_text())
    assert (output / candidate["file"]).read_bytes() == b"selected final installer bytes"
    assert candidate["sha256"] == release.checksum(installer)
    assert candidate["restagedFinalBytes"] and candidate["signing"] == "externally_reported_verified"
    assert candidate["cleanMachineAcceptance"] == candidate["liveModelAcceptance"] == "pending"
    assert candidate["buildRun"] == "https://github.com/test/repo/actions/runs/42" and "Independent" in candidate["buildSourceIdentity"]
    bound = json.loads((output / candidate["originalBuildCandidate"]).read_text())
    assert bound["candidateSha256"] == release.checksum(state["build_candidate"])
    assert bound["assetAndEvidenceVerified"] is True
    assert json.loads((output / candidate["signingReport"]).read_text()) == json.loads(signing.read_text())
    assert "evidence/notices-match.json" in candidate["evidence"]
    assert len(state["calls"]) == 2
    assert "check_licenses.py" in state["calls"][1][1]
    if platform == "darwin":
        assert state["mounted"] == ["detached"]


@pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
def test_final_installer_rejects_wrong_desktop_version_with_matching_service(release, source, final_setup, platform):
    installer, output, reports, state = final_setup(platform, "desktop_version")
    with pytest.raises(ValueError, match="desktop version"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not state["calls"]


def test_final_windows_payload_is_extracted_without_running_installer(release, source, final_setup):
    installer, output, reports, state = final_setup("win32")
    release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert any(command[0] == "7z" for command in state["native"])
    assert not any("Start-Process" in argument for command in state["native"] for argument in command)


def test_final_public_evidence_removes_local_paths_and_retains_raw_reports(release, source, final_setup):
    installer, output, reports, state = final_setup()
    release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    raw = (reports / "licenses.json").read_text()
    public = (output / "evidence/licenses.json").read_text()
    assert "Maintainer" in raw and str(source) in raw
    assert "Maintainer" not in public and "Another" not in public and str(source) not in public
    assert json.loads(public)["passed"] is True


def test_final_signing_commands_remove_other_machine_paths_before_public_hashing(release, source, final_setup):
    installer, output, reports, state = final_setup()
    signing = source / "signing.json"
    commands = ["codesign --verify /Users/Other/Downloads/PractiQ.app",
                'codesign --verify "/Users/Other/Private Work/PractiQ.app"',
                'signtool verify /pa "C:\\Users\\Another\\Private Work\\PractiQ.exe"',
                "signtool verify /pa C:\\Users\\Another\\Downloads\\PractiQ.exe",
                'signtool verify /pa "\\\\build-server\\Private Work\\PractiQ.exe"',
                "signtool verify /pa \\\\build-server\\Private\\PractiQ.exe",
                "signtool verify /pa //build-server/Private/PractiQ.exe",
                "source https://github.com/test/repo/actions/runs/42"]
    signing.write_text(json.dumps({"artifactSha256": release.checksum(installer), "status": "verified", "verificationCommands": commands}))
    release.restage_installer(source, "v0.1.0", installer, output, reports, signing, state["build_candidate"])
    assert json.loads((reports / "signing-report.json").read_text())["verificationCommands"] == commands
    public = json.loads((output / "evidence/signing-report.json").read_text())
    assert all("Other" not in command and "Another" not in command and "Private Work" not in command and "build-server" not in command for command in public["verificationCommands"])
    assert public["verificationCommands"][2] == 'signtool verify /pa "<local>"'
    assert public["verificationCommands"][-1] == commands[-1]
    candidate = json.loads((output / "candidate.json").read_text())
    assert candidate["evidence"]["evidence/signing-report.json"] == release.checksum(output / "evidence/signing-report.json")


def test_final_signing_report_accepts_uppercase_equivalent_digest(release, source, final_setup):
    installer, output, reports, state = final_setup()
    signing = source / "signing.json"
    signing.write_text(json.dumps({"artifactSha256": release.checksum(installer).upper(), "status": "verified"}))
    release.restage_installer(source, "v0.1.0", installer, output, reports, signing, state["build_candidate"])
    assert (output / "candidate.json").is_file()


@pytest.mark.parametrize("value", [None, "a" * 63, "g" * 64, "A" * 65, " " + "a" * 64])
def test_final_signing_report_rejects_incomplete_or_invalid_digests(release, source, final_setup, value):
    installer, output, reports, state = final_setup()
    signing = source / "signing.json"
    signing.write_text(json.dumps({"artifactSha256": value}))
    with pytest.raises(ValueError, match="SHA-256"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, signing, state["build_candidate"])
    assert not output.exists()


@pytest.mark.parametrize("mutation", ["commit", "components", "architecture", "file", "asset", "evidence", "failed_gate", "missing_gate", "build_run", "build_manifest"])
def test_final_staging_requires_matching_original_build_assets_and_evidence(release, source, final_setup, mutation):
    installer, output, reports, state = final_setup()
    path = state["build_candidate"]
    candidate = json.loads(path.read_text())
    if mutation == "commit":
        candidate["commit"] = "b" * 40
    elif mutation == "components":
        candidate["components"]["desktop"] = "0.2.0"
    elif mutation == "architecture":
        candidate["architecture"] = "x64"
    elif mutation == "file":
        candidate["file"] = "../outside.dmg"
    elif mutation == "asset":
        (path.parent / candidate["file"]).write_bytes(b"altered original")
    elif mutation == "evidence":
        (path.parent / "evidence/licenses.json").write_text("altered original report")
    elif mutation == "failed_gate":
        report = path.parent / "evidence/licenses.json"
        report.write_text('{"passed":false}')
        candidate["evidence"]["evidence/licenses.json"] = release.checksum(report)
    elif mutation == "missing_gate":
        candidate["evidence"].pop("evidence/licenses.json")
    elif mutation == "build_run":
        candidate["buildRun"] = "https://github.com/test/repo/actions/runs/42?replace=true"
    else:
        report = path.parent / "evidence/build-manifest.json"
        report.write_text('{"platform":"linux","architecture":"amd64","packages":[]}')
        candidate["evidence"]["evidence/build-manifest.json"] = release.checksum(report)
    path.write_text(json.dumps(candidate))
    with pytest.raises(ValueError):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=path)
    assert not output.exists() and not reports.exists() and not state["calls"]


@pytest.mark.parametrize("absolute", [False, True])
def test_original_build_rejects_evidence_root_outside_downloaded_candidate(release, source, final_setup, absolute):
    installer, output, reports, state = final_setup()
    path = state["build_candidate"]
    evidence = path.parent / "evidence"
    outside = source / "unrelated-evidence"
    shutil.copytree(evidence, outside)
    shutil.rmtree(evidence)
    evidence.symlink_to(outside if absolute else Path("../unrelated-evidence"), target_is_directory=True)
    with pytest.raises(ValueError, match="evidence.*escaped|evidence.*directory"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=path)
    assert not output.exists() and not reports.exists() and not state["native"] and not state["calls"]


def test_original_build_allows_evidence_root_resolving_inside_downloaded_candidate(release, source, final_setup):
    installer, output, reports, state = final_setup()
    path = state["build_candidate"]
    evidence = path.parent / "evidence"
    evidence.rename(path.parent / "contained-evidence")
    evidence.symlink_to("contained-evidence", target_is_directory=True)
    release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=path)
    original = json.loads((output / "evidence/build-candidate.json").read_text())
    assert original["assetAndEvidenceVerified"] is True and len(state["calls"]) == 2


def test_original_build_rejects_absolute_individual_evidence_outside_directory(release, source, final_setup):
    installer, output, reports, state = final_setup()
    path = state["build_candidate"]
    outside = source / "unrelated-report.json"
    outside.write_text('{"passed":true}')
    candidate = json.loads(path.read_text())
    candidate["evidence"][str(outside)] = release.checksum(outside)
    path.write_text(json.dumps(candidate))
    with pytest.raises(ValueError, match="evidence.*escaped"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=path)
    assert not output.exists() and not reports.exists() and not state["native"] and not state["calls"]


@pytest.mark.parametrize("payload", ["../outside", "C:\\outside", "\\outside", "bundled/file:stream", ""])
def test_final_windows_rejects_unsafe_or_missing_payload_before_extraction(release, source, final_setup, monkeypatch, payload):
    installer, output, reports, state = final_setup("win32")
    monkeypatch.setattr(subprocess, "check_output", lambda *args, **kwargs: "Path = " + payload + "\nSize = 1\n")
    with pytest.raises(ValueError, match="NSIS"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not state["native"]


def test_final_windows_requires_existing_full_7zip_without_installing(release, source, final_setup, monkeypatch):
    installer, output, reports, state = final_setup("win32")
    monkeypatch.setattr(shutil, "which", lambda _: None)
    with pytest.raises(ValueError, match="7-Zip"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not state["native"]


@pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
def test_final_native_version_preserves_prerelease_identity(release, source, final_setup, monkeypatch, platform):
    installer, _, _, _ = final_setup(platform)
    bundle = source / "Example.app/Contents/Resources/bundled" if platform == "darwin" else source / "extracted/bundled"
    bundle.mkdir(parents=True)
    expected = "0.1.0-alpha.1"
    if platform == "darwin":
        (bundle.parents[1] / "Info.plist").write_bytes(plistlib.dumps({"CFBundleShortVersionString": expected, "CFBundleExecutable": "PractiQ"}))
        executable = bundle.parents[1] / "MacOS/PractiQ"
        executable.parent.mkdir()
        executable.write_bytes(native_macho() if platform == "darwin" else native_elf())
        executable.chmod(0o755)
    elif platform == "win32":
        (bundle.parent / "PractiQ.exe").write_bytes(native_pe())
    else:
        executable = bundle.parent / "usr/bin/PractiQ"
        executable.parent.mkdir(parents=True)
        executable.write_bytes(native_macho() if platform == "darwin" else native_elf())
        executable.chmod(0o755)
    monkeypatch.setattr(subprocess, "check_output", lambda *args, **kwargs: expected + "\n")
    assert release.check_desktop_version(installer, bundle, expected, "PractiQ") == expected
    with pytest.raises(ValueError, match="desktop version"):
        release.check_desktop_version(installer, bundle, "0.1.0", "PractiQ")


@pytest.mark.parametrize("fault", ["gate", "notice", "missing_notice", "source", "snapshot", "signing", "source_after_checks", "snapshot_after_checks"])
def test_explicit_final_staging_keeps_failed_evidence_and_produces_no_assets(release, source, final_setup, fault):
    installer, output, reports, state = final_setup(fault=fault)
    signing = None
    if fault == "signing":
        signing = source / "wrong-signing.json"
        signing.write_text(json.dumps({"artifactSha256": "0" * 64}))
    with pytest.raises((ValueError, OSError, subprocess.CalledProcessError)):
        release.restage_installer(source, "v0.1.0", installer, output, reports, signing, state["build_candidate"])
    assert reports.is_dir() and not output.exists()
    assert (reports / "licenses.json").exists()
    assert state["mounted"] == ["detached"]


@pytest.mark.parametrize("existing", ["output", "reports"])
def test_explicit_final_staging_rejects_existing_directories_before_gates(release, source, final_setup, existing):
    installer, output, reports, state = final_setup()
    path = output if existing == "output" else reports
    path.mkdir()
    (path / "prior.txt").write_text("Preserve prior evidence")
    with pytest.raises(FileExistsError):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert (path / "prior.txt").read_text() == "Preserve prior evidence"
    assert not state["calls"]


def test_explicit_final_staging_rejects_changed_copy_before_public_handoff(release, source, final_setup, monkeypatch):
    installer, output, reports, state = final_setup()
    copyfile = shutil.copyfile
    def change_copy(src, dst, *args, **kwargs):
        result = copyfile(src, dst, *args, **kwargs)
        if Path(dst).name.startswith("PractiQ_0.1.0_"):
            Path(dst).write_bytes(b"changed final asset copy")
        return result
    monkeypatch.setattr(shutil, "copyfile", change_copy)
    with pytest.raises(ValueError, match="copying"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and (reports / "notices-match.json").exists()


def test_explicit_final_staging_rejects_installer_mutation_while_snapshotting(release, source, final_setup, monkeypatch):
    installer, output, reports, state = final_setup()
    copyfile = shutil.copyfile
    def mutate_original(src, dst, *args, **kwargs):
        result = copyfile(src, dst, *args, **kwargs)
        if Path(src) == installer:
            installer.write_bytes(b"changed original during snapshot")
        return result
    monkeypatch.setattr(shutil, "copyfile", mutate_original)
    with pytest.raises(ValueError, match="snapshot"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not reports.exists() and not state["calls"]


@pytest.fixture
def restaged(release, staged):
    for folder in staged.glob("release-*"):
        evidence = folder / "evidence"
        candidate = json.loads((folder / "candidate.json").read_text())
        prior = dict(candidate)
        candidate.update(restagedFinalBytes=True, signing="externally_reported_verified", signingReport="evidence/signing-report.json")
        candidate["originalBuildCandidate"] = "evidence/build-candidate.json"
        (evidence / "original-candidate.json").write_bytes(json.dumps(prior, indent=3).encode())
        (evidence / "build-candidate.json").write_text(json.dumps({"candidateSha256": release.checksum(evidence / "original-candidate.json"),
            "originalCandidate": "evidence/original-candidate.json",
            "verifiedCandidateSha256": hashlib.sha256(json.dumps(prior, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            "assetAndEvidenceVerified": True, "candidate": prior}))
        (evidence / "desktop-version.json").write_text('{"passed":true,"version":"0.1.0"}')
        (evidence / "expected-THIRD-PARTY.txt").write_bytes((evidence / "THIRD-PARTY.txt").read_bytes())
        (evidence / "notices-match.json").write_text(json.dumps({"passed": True, "sha256": release.checksum(evidence / "THIRD-PARTY.txt")}))
        (evidence / "signing-report.json").write_text(json.dumps({"artifactSha256": candidate["sha256"], "status": "verified"}))
        candidate["evidence"] = {f"evidence/{path.name}": release.checksum(path) for path in evidence.iterdir()}
        (folder / "candidate.json").write_text(json.dumps(candidate))
    return staged


@pytest.mark.parametrize("original_platforms", [("macos",), ("windows",), ("linux",),
                                               ("macos", "windows"), ("macos", "linux"), ("windows", "linux")])
def test_final_assembly_rejects_mixed_staging_modes_before_creating_assets(release, source, restaged, original_platforms):
    for platform in original_platforms:
        path = restaged / f"release-{platform}/candidate.json"
        candidate = json.loads(path.read_text())
        candidate.pop("restagedFinalBytes")
        path.write_text(json.dumps(candidate))
    output = source / "mixed-final-assets"
    with pytest.raises(ValueError, match="staging modes"):
        release.assemble(source, "v0.1.0", restaged, output)
    assert not output.exists()


@pytest.mark.parametrize("mutation", [None, "uppercase", "missing_comparison", "missing_expected", "notice_hash", "expected_notice", "signing_hash", "build_identity", "desktop_version"])
def test_final_assembly_preserves_bound_signing_evidence_and_rejects_notice_drift(release, source, restaged, mutation):
    staged = restaged
    folder = staged / "release-macos"
    evidence = folder / "evidence"
    candidate = json.loads((folder / "candidate.json").read_text())
    if mutation == "missing_comparison":
        (evidence / "notices-match.json").unlink()
    elif mutation == "missing_expected":
        (evidence / "expected-THIRD-PARTY.txt").unlink()
    elif mutation == "notice_hash":
        (evidence / "notices-match.json").write_text('{"passed":true,"sha256":"wrong"}')
    elif mutation == "expected_notice":
        (evidence / "expected-THIRD-PARTY.txt").write_text("Altered generated notices")
    elif mutation == "signing_hash":
        (evidence / "signing-report.json").write_text('{"artifactSha256":"wrong"}')
    elif mutation == "uppercase":
        (evidence / "signing-report.json").write_text(json.dumps({"artifactSha256": candidate["sha256"].upper(), "status": "verified"}))
    elif mutation == "build_identity":
        build = json.loads((evidence / "build-candidate.json").read_text())
        build["candidate"]["buildRun"] = "https://github.com/test/repo/actions/runs/43"
        (evidence / "build-candidate.json").write_text(json.dumps(build))
    elif mutation == "desktop_version":
        (evidence / "desktop-version.json").write_text('{"passed":true,"version":"0.2.0"}')
    candidate["evidence"] = {f"evidence/{path.name}": release.checksum(path) for path in evidence.iterdir()}
    (folder / "candidate.json").write_text(json.dumps(candidate))
    output = source / "final-assembly"
    if mutation not in {None, "uppercase"}:
        with pytest.raises(ValueError):
            release.assemble(source, "v0.1.0", staged, output)
        assert not output.exists()
    else:
        release.assemble(source, "v0.1.0", staged, output)
        manifest = json.loads((output / "release-manifest.json").read_text())
        assert all(asset["restagedFinalBytes"] is True for asset in manifest["assets"])
        assert manifest["assets"][1]["signing"] == "externally_reported_verified"
        assert "pending" in manifest["publicationStatus"]
        with zipfile.ZipFile(output / "release-evidence.zip") as archive:
            assert "macos/evidence/signing-report.json" in archive.namelist()


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


def native_pe(machine=0x8664, magic=0x20B):
    payload = bytearray(512)
    payload[:2] = b"MZ"
    payload[60:64] = (128).to_bytes(4, "little")
    payload[128:132] = b"PE\0\0"
    payload[132:134] = machine.to_bytes(2, "little")
    payload[148:150] = (240).to_bytes(2, "little")
    payload[152:154] = magic.to_bytes(2, "little")
    return bytes(payload)


def native_macho(cpu=0x100000C, subtype=0, filetype=2):
    return struct.pack("<IIIIIIIIII", 0xFEEDFACF, cpu, subtype, filetype, 1, 8, 0, 0, 0x80000028, 8)


def native_fat(slices, wide=False, byteorder="big"):
    order = ">" if byteorder == "big" else "<"
    entry_size = 32 if wide else 20
    payload = bytearray(struct.pack(order + "II", 0xCAFEBABF if wide else 0xCAFEBABE, len(slices)))
    payload.extend(b"\0" * (entry_size * len(slices)))
    for index, (cpu, subtype, data) in enumerate(slices):
        offset = (len(payload) + 63) // 64 * 64
        payload.extend(b"\0" * (offset - len(payload)))
        entry = struct.pack(order + ("IIQQII" if wide else "IIIII"), cpu, subtype, offset, len(data), 6, *([0] if wide else []))
        payload[8 + index * entry_size:8 + (index + 1) * entry_size] = entry
        payload.extend(data)
    return bytes(payload)


def native_elf(machine=62, filetype=3):
    payload = bytearray(120)
    payload[:7] = b"\x7fELF\x02\x01\x01"
    payload[16:24] = struct.pack("<HHI", filetype, machine, 1)
    payload[32:40] = (64).to_bytes(8, "little")
    payload[52:58] = struct.pack("<HHH", 64, 56, 1)
    return bytes(payload)


@pytest.mark.parametrize("status", ["verified", "unsigned", "failed"])
def test_final_staging_binds_external_signing_status_without_attesting_it(release, source, final_setup, status):
    installer, output, reports, state = final_setup()
    signing = source / "signing.json"
    signing.write_text(json.dumps({"artifactSha256": release.checksum(installer), "status": status}))
    release.restage_installer(source, "v0.1.0", installer, output, reports, signing, state["build_candidate"])
    candidate = json.loads((output / "candidate.json").read_text())
    assert candidate["signing"] == "externally_reported_" + status
    assert "Not performed" in candidate["signingVerification"]


@pytest.mark.parametrize("status", [None, "", True, "verified by someone", "signed", {"verified": True}])
def test_final_staging_rejects_ambiguous_signing_status(release, source, final_setup, status):
    installer, output, reports, state = final_setup()
    signing = source / "signing.json"
    report = {"artifactSha256": release.checksum(installer)}
    if status is not None:
        report["status"] = status
    signing.write_text(json.dumps(report))
    with pytest.raises(ValueError, match="signing status"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, signing, state["build_candidate"])
    assert reports.exists() and not output.exists()


@pytest.mark.parametrize("mutation", ["restaged", "false_marker", "missing_signing", "signed"])
def test_final_staging_rejects_nonoriginal_build_candidates(release, source, final_setup, mutation):
    installer, output, reports, state = final_setup()
    path = state["build_candidate"]
    candidate = json.loads(path.read_text())
    if mutation in {"restaged", "false_marker"}:
        candidate["restagedFinalBytes"] = mutation == "restaged"
    elif mutation == "missing_signing":
        candidate.pop("signing")
    else:
        candidate["signing"] = "externally_reported_verified"
    path.write_text(json.dumps(candidate))
    with pytest.raises(ValueError, match="original unsigned"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=path)
    assert not output.exists() and not reports.exists() and not state["native"]


@pytest.mark.parametrize("mutation", ["candidate_status", "report_status", "missing_report", "prior_restaged", "prior_signing"])
def test_final_assembly_rejects_drifted_signing_status_or_nonoriginal_provenance(release, source, restaged, mutation):
    folder = restaged / "release-macos"
    evidence = folder / "evidence"
    candidate = json.loads((folder / "candidate.json").read_text())
    candidate["signing"] = "externally_reported_verified"
    report = {"artifactSha256": candidate["sha256"], "status": "verified"}
    if mutation == "candidate_status":
        candidate["signing"] = "externally_reported_failed"
    elif mutation == "report_status":
        report["status"] = "signed somehow"
    elif mutation == "missing_report":
        candidate.pop("signingReport")
    elif mutation in {"prior_restaged", "prior_signing"}:
        build = json.loads((evidence / "build-candidate.json").read_text())
        if mutation == "prior_restaged":
            build["candidate"]["restagedFinalBytes"] = True
        else:
            build["candidate"]["signing"] = "externally_reported_verified"
        build["verifiedCandidateSha256"] = hashlib.sha256(json.dumps(build["candidate"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        (evidence / "build-candidate.json").write_text(json.dumps(build))
    (evidence / "signing-report.json").write_text(json.dumps(report))
    candidate["evidence"] = {f"evidence/{path.name}": release.checksum(path) for path in evidence.iterdir()}
    (folder / "candidate.json").write_text(json.dumps(candidate))
    output = source / "final-assembly"
    with pytest.raises(ValueError, match="signing|original unsigned"):
        release.assemble(source, "v0.1.0", restaged, output)
    assert not output.exists()


@pytest.mark.parametrize("platform", ["darwin", "linux"])
@pytest.mark.parametrize("fault", ["native_wrong_arch", "native_script", "native_truncated", "native_not_executable"])
def test_final_native_rejects_wrong_or_unusable_architecture_before_bundle_gates(release, source, final_setup, platform, fault):
    installer, output, reports, state = final_setup(platform, fault)
    with pytest.raises(ValueError, match="Mach-O|ELF"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not reports.exists() and not state["calls"]
    if platform == "darwin":
        assert state["mounted"] == ["detached"]


@pytest.mark.parametrize("wide", [False, True])
@pytest.mark.parametrize("byteorder", ["big", "little"])
def test_final_macos_accepts_bounded_universal_executable_with_actual_arm64_slice(release, source, final_setup, wide, byteorder):
    installer, output, reports, state = final_setup()
    state["native_payload"] = native_fat([(0x1000007, 3, native_macho(0x1000007, 3)), (0x100000C, 0, native_macho())], wide, byteorder)
    release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert output.exists() and len(state["calls"]) == 2


@pytest.mark.parametrize("damage", ["no_arm64", "cpu_mismatch", "subtype_mismatch", "duplicate", "overlap", "outside", "table_offset", "zero_count", "huge_count", "truncated_table", "invalid_slice", "short_slice", "alignment", "commands"])
def test_final_macos_rejects_fat_table_spoofs_and_unbounded_slices(release, source, final_setup, damage):
    installer, output, reports, state = final_setup()
    slices = [(0x1000007, 3, native_macho(0x1000007, 3)), (0x100000C, 0, native_macho())]
    if damage == "no_arm64":
        slices = slices[:1]
    elif damage == "cpu_mismatch":
        slices[1] = (0x100000C, 0, native_macho(0x1000007))
    elif damage == "subtype_mismatch":
        slices[1] = (0x100000C, 0, native_macho(subtype=2))
    elif damage == "duplicate":
        slices = [slices[1], slices[1]]
    elif damage == "invalid_slice":
        slices[1] = (0x100000C, 0, b"not a Mach-O native executable" * 2)
    elif damage == "commands":
        data = bytearray(native_macho())
        data[20:24] = (0xFFFFFFFF).to_bytes(4, "little")
        slices[1] = (0x100000C, 0, bytes(data))
    payload = bytearray(native_fat(slices))
    if damage == "overlap":
        payload[36:40] = payload[16:20]
    elif damage == "outside":
        payload[36:40] = (len(payload) + 1).to_bytes(4, "big")
    elif damage == "table_offset":
        payload[36:40] = (0).to_bytes(4, "big")
    elif damage == "zero_count":
        payload[4:8] = b"\0" * 4
    elif damage == "huge_count":
        payload[4:8] = (0xFFFFFFFF).to_bytes(4, "big")
    elif damage == "truncated_table":
        del payload[35:]
    elif damage == "short_slice":
        payload[40:44] = (16).to_bytes(4, "big")
    elif damage == "alignment":
        payload[44:48] = (63).to_bytes(4, "big")
    state["native_payload"] = payload
    with pytest.raises(ValueError, match="Mach-O|arm64"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not reports.exists() and not state["calls"]
    assert state["mounted"] == ["detached"]


@pytest.mark.parametrize("damage", ["class32", "big_endian", "ident_version", "header_version", "header_size", "program_bounds", "section_bounds"])
def test_final_linux_rejects_malformed_x64_elf_headers(release, source, final_setup, damage):
    installer, output, reports, state = final_setup("linux")
    payload = bytearray(native_elf())
    if damage == "class32":
        payload[4] = 1
    elif damage == "big_endian":
        payload[5] = 2
    elif damage == "ident_version":
        payload[6] = 0
    elif damage == "header_version":
        payload[20:24] = b"\0" * 4
    elif damage == "header_size":
        payload[52:54] = (32).to_bytes(2, "little")
    elif damage == "program_bounds":
        payload[32:40] = (len(payload)).to_bytes(8, "little")
    else:
        payload[40:48] = (len(payload)).to_bytes(8, "little")
        payload[58:62] = struct.pack("<HH", 64, 1)
    state["native_payload"] = payload
    with pytest.raises(ValueError, match="ELF"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not reports.exists() and not state["calls"]


@pytest.mark.parametrize("filetype", [2, 3])
def test_final_linux_accepts_elf64_x86_64_executable_and_pie_headers(release, source, final_setup, filetype):
    installer, output, reports, state = final_setup("linux")
    state["native_payload"] = native_elf(filetype=filetype)
    release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert output.exists() and len(state["calls"]) == 2


@pytest.mark.parametrize("damage", ["empty", "dos", "offset", "signature", "optional_length", "optional_truncated"])
def test_final_windows_rejects_malformed_native_pe(release, source, final_setup, damage):
    installer, _, _, _ = final_setup("win32")
    bundle = source / "extracted/bundled"
    bundle.mkdir(parents=True)
    application = bundle.parent / "PractiQ.exe"
    payload = bytearray(native_pe())
    if damage == "empty":
        payload = bytearray()
    elif damage == "dos":
        payload[:2] = b"NO"
    elif damage == "offset":
        payload[60:64] = (0xFFFFFFFF).to_bytes(4, "little")
    elif damage == "signature":
        payload[128:132] = b"NONE"
    elif damage == "optional_length":
        payload[148:150] = (0).to_bytes(2, "little")
    else:
        del payload[160:]
    application.write_bytes(payload)
    with pytest.raises(ValueError, match="PE|executable"):
        release.check_desktop_version(installer, bundle, "0.1.0", "PractiQ")


def test_original_build_evidence_cannot_resolve_outside_the_downloaded_candidate(release, source, final_setup):
    installer, output, reports, state = final_setup()
    evidence = state["build_candidate"].parent / "evidence"
    outside = source / "unrelated-evidence"
    shutil.copytree(evidence, outside)
    shutil.rmtree(evidence)
    evidence.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="evidence.*escaped|evidence.*directory"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not reports.exists() and not state["native"]


def acceptance_report(candidate, kind, status="passed"):
    return {"schemaVersion": 1, "kind": kind, "artifactSha256": candidate["sha256"],
            **{key: candidate[key] for key in ("tag", "commit", "components", "os", "architecture")},
            "status": status, "reviewedBy": "Synthetic fixture reviewer",
            "verificationResults": ["Synthetic schema test only; no installation or real model was run"]}



@pytest.mark.parametrize("platform", ["darwin", "linux"])
@pytest.mark.parametrize("mode", [0o644, 0o666])
def test_final_native_requires_posix_execute_permission(release, source, final_setup, platform, mode):
    installer, output, reports, state = final_setup(platform)
    state["native_mode"] = mode
    with pytest.raises(ValueError, match="execute permission"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not reports.exists() and not state["calls"]



@pytest.mark.parametrize("platform", ["darwin", "linux", "win32"])
def test_final_native_accepts_owner_executable_and_windows_without_posix_execute_bits(release, source, final_setup, platform):
    installer, output, reports, state = final_setup(platform)
    state["native_mode"] = 0o700
    release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert output.exists()



@pytest.mark.parametrize("kind,field", [("clean-machine", "cleanMachine"), ("live-model", "liveModel")])
@pytest.mark.parametrize("status", ["passed", "failed"])
def test_final_staging_binds_external_acceptance_without_running_or_attesting_it(release, source, final_setup, kind, field, status):
    installer, output, reports, state = final_setup()
    identity = json.loads(state["build_candidate"].read_text()) | {"sha256": release.checksum(installer)}
    report = acceptance_report(identity, kind, status)
    report["verificationResults"].append(f"Synthetic evidence at {source}/private-test")
    path = source / (kind + ".json")
    path.write_text(json.dumps(report))
    option = "clean_machine_report" if kind == "clean-machine" else "live_model_report"
    release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"], **{option: path})
    candidate = json.loads((output / "candidate.json").read_text())
    assert candidate[field + "Acceptance"] == "externally_reported_" + status
    other = "liveModel" if field == "cleanMachine" else "cleanMachine"
    assert candidate[other + "Acceptance"] == "pending"
    assert "Not performed" in candidate["acceptanceVerification"]
    filename = kind + "-report.json"
    assert json.loads((reports / filename).read_text()) == report
    public = (output / candidate[field + "Report"]).read_text()
    assert str(source) not in public and "Synthetic schema test only" in public
    assert candidate["evidence"][candidate[field + "Report"]] == release.checksum(output / candidate[field + "Report"])
    assert len(state["calls"]) == 2



@pytest.mark.parametrize("kind", ["clean-machine", "live-model"])
@pytest.mark.parametrize("mutation", ["kind", "os", "architecture", "commit", "tag", "components", "artifact", "schema_bool", "unknown", "missing_reviewer", "empty_results", "missing_results", "status", "synthetic_status"])
def test_final_staging_rejects_mixed_incomplete_or_ambiguous_acceptance_reports(release, source, final_setup, kind, mutation):
    installer, output, reports, state = final_setup()
    identity = json.loads(state["build_candidate"].read_text()) | {"sha256": release.checksum(installer)}
    report = acceptance_report(identity, kind)
    if mutation in {"kind", "os", "architecture", "tag"}:
        report[mutation] = "different"
    elif mutation == "commit":
        report["commit"] = "b" * 40
    elif mutation == "components":
        report["components"] = {"desktop": "0.2.0", "aiService": "0.3.0"}
    elif mutation == "artifact":
        report["artifactSha256"] = "b" * 64
    elif mutation == "schema_bool":
        report["schemaVersion"] = True
    elif mutation == "unknown":
        report["unrecognized"] = "not in the schema"
    elif mutation == "missing_reviewer":
        report.pop("reviewedBy")
    elif mutation == "missing_results":
        report.pop("verificationResults")
    elif mutation == "empty_results":
        report["verificationResults"] = []
    else:
        report["status"] = True if mutation == "status" else "synthetic"
    path = source / (kind + ".json")
    path.write_text(json.dumps(report))
    option = "clean_machine_report" if kind == "clean-machine" else "live_model_report"
    with pytest.raises(ValueError, match="Acceptance|acceptance"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"], **{option: path})
    assert not output.exists()



@pytest.fixture
def accepted_reports(restaged):
    for folder in restaged.glob("release-*"):
        candidate = json.loads((folder / "candidate.json").read_text())
        for kind, field in (("clean-machine", "cleanMachine"), ("live-model", "liveModel")):
            path = folder / "evidence" / (kind + "-report.json")
            path.write_text(json.dumps(acceptance_report(candidate, kind)))
            candidate[field + "Report"] = "evidence/" + path.name
            candidate[field + "Acceptance"] = "externally_reported_passed"
        candidate["evidence"] = {f"evidence/{path.name}": hashlib.sha256(path.read_bytes()).hexdigest() for path in (folder / "evidence").iterdir()}
        (folder / "candidate.json").write_text(json.dumps(candidate))
    return restaged



def test_final_assembly_preserves_reported_acceptance_and_keeps_publication_review_pending(release, source, accepted_reports):
    output = source / "reported-assets"
    release.assemble(source, "v0.1.0", accepted_reports, output)
    manifest = json.loads((output / "release-manifest.json").read_text())
    assert all(asset["cleanMachineAcceptance"] == asset["liveModelAcceptance"] == "externally_reported_passed" for asset in manifest["assets"])
    assert "independent" in manifest["publicationStatus"] and "pending" in manifest["publicationStatus"]
    with zipfile.ZipFile(output / "release-evidence.zip") as archive:
        report = json.loads(archive.read("macos/evidence/live-model-report.json"))
        assert report["verificationResults"] == ["Synthetic schema test only; no installation or real model was run"]



@pytest.mark.parametrize("field", ["cleanMachine", "liveModel"])
@pytest.mark.parametrize("mutation", ["status", "report_status", "missing_report", "absolute_path", "outside_path", "report_identity", "report_link", "evidence_link"])
def test_final_assembly_rejects_acceptance_status_drift_and_unbound_report_paths(release, source, accepted_reports, field, mutation):
    folder = accepted_reports / "release-macos"
    candidate_path = folder / "candidate.json"
    candidate = json.loads(candidate_path.read_text())
    report = folder / candidate[field + "Report"]
    if mutation == "status":
        candidate[field + "Acceptance"] = "passed"
    elif mutation == "missing_report":
        candidate.pop(field + "Report")
    elif mutation in {"absolute_path", "outside_path"}:
        candidate[field + "Report"] = str(report) if mutation == "absolute_path" else "../outside.json"
    elif mutation == "report_link":
        external = source / "external-report.json"
        report.rename(external)
        report.symlink_to(external)
    elif mutation == "evidence_link":
        external = source / "external-evidence"
        (folder / "evidence").rename(external)
        (folder / "evidence").symlink_to(external, target_is_directory=True)
    else:
        value = json.loads(report.read_text())
        value["status" if mutation == "report_status" else "commit"] = "failed" if mutation == "report_status" else "b" * 40
        report.write_text(json.dumps(value))
    candidate["evidence"] = {f"evidence/{path.name}": hashlib.sha256(path.read_bytes()).hexdigest() for path in (folder / "evidence").iterdir()}
    candidate_path.write_text(json.dumps(candidate))
    output = source / "reported-assets"
    with pytest.raises(ValueError, match="acceptance|Acceptance|release evidence"):
        release.assemble(source, "v0.1.0", accepted_reports, output)
    assert not output.exists()



@pytest.mark.parametrize("kind", ["clean-machine", "live-model"])
def test_final_assembly_rechecks_archived_acceptance_bytes_after_input_validation(release, source, accepted_reports, monkeypatch, kind):
    original = zipfile.ZipFile.write
    changed = False
    def changed_report(archive, path, *args, **kwargs):
        nonlocal changed
        path = Path(path)
        if not changed and path.name == kind + "-report.json":
            report = json.loads(path.read_text())
            report["verificationResults"] = ["Different report after validation"]
            path.write_text(json.dumps(report))
            changed = True
        return original(archive, path, *args, **kwargs)
    monkeypatch.setattr(zipfile.ZipFile, "write", changed_report)
    output = source / "reported-assets"
    with pytest.raises(ValueError, match="assembly"):
        release.assemble(source, "v0.1.0", accepted_reports, output)
    assert changed and not (output / "release-manifest.json").exists()



def test_final_cli_passes_acceptance_reports_only_to_explicit_final_staging(release, monkeypatch):
    calls = []
    monkeypatch.setitem(release.main.__globals__, "restage_installer", lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.setattr(sys, "argv", ["release.py", "stage", "--tag", "v0.1.0", "--installer", "final.dmg", "--reports", "reports", "--output", "output", "--build-candidate", "candidate.json", "--clean-machine-report", "clean.json", "--live-model-report", "live.json"])
    release.main()
    assert calls[0][1] == {"clean_machine_report": Path("clean.json"), "live_model_report": Path("live.json")}
    monkeypatch.setattr(sys, "argv", ["release.py", "check", "--tag", "v0.1.0", "--clean-machine-report", "clean.json"])
    with pytest.raises(SystemExit):
        release.main()


@pytest.mark.parametrize("uri", ["file:///Users/Alice/private/report.json", "file:///C:/Users/Alice/report.json",
                                "file://private-server/work/report.json", "FILE:///Users/Alice/Private%20Work/report.json"])
def test_public_reports_redact_file_uri_machine_paths(release, source, final_setup, uri):
    installer, output, reports, state = final_setup()
    signing = source / "signing.json"
    report = {"artifactSha256": release.checksum(installer), "status": "verified", "verificationCommands": [f"opened {uri}"]}
    signing.write_text(json.dumps(report))
    release.restage_installer(source, "v0.1.0", installer, output, reports, signing, state["build_candidate"])
    assert json.loads((reports / "signing-report.json").read_text()) == report
    public = json.loads((output / "evidence/signing-report.json").read_text())
    assert public["verificationCommands"] == ["opened <local>"]
    assert release.public_report({uri: uri}, []) == {"<local>": "<local>"}
    assert release.public_report("https://github.com/test/repo/actions/runs/42", []) == "https://github.com/test/repo/actions/runs/42"


@pytest.mark.parametrize("nested", [False, True])
def test_public_reports_preserve_every_value_when_redacted_keys_collide(release, nested):
    records = {"file:///Users/Alice/private/a.json": {"status": "failed"},
               "file:///Users/Bob/private/b.json": {"status": "passed"}}
    payload = {"reports": [records]} if nested else records
    expected_records = {"<local>": {"status": "failed"}, "<local>#2": {"status": "passed"}}
    expected = {"reports": [expected_records]} if nested else expected_records
    assert release.public_report(payload, []) == expected
    assert release.public_report(payload, []) == release.public_report(payload, [])
    assert "Alice" not in json.dumps(release.public_report(payload, [])) and "Bob" not in json.dumps(release.public_report(payload, []))


@pytest.mark.parametrize("paths_first", [False, True])
def test_public_reports_keep_existing_literal_keys_when_redacted_keys_collide(release, paths_first):
    paths = {"file:///Users/Alice/private/a.json": "failed", "file:///Users/Bob/private/b.json": "passed"}
    literals = {"<local>": "existing base", "<local>#2": "existing two", "<local>#3": "existing three"}
    records = {**paths, **literals} if paths_first else {**literals, **paths}
    result = release.public_report({"nested": [records]}, [])["nested"][0]
    assert len(result) == 5 and result == {**literals, "<local>#4": "failed", "<local>#5": "passed"}
    assert list(result.values()) == list(records.values())


@pytest.mark.parametrize("url", ["https://example.test/artifacts/file:report.json", "https://example.test/artifacts/file:///public/report.json",
                                "https://example.test/artifact#file:report.json"])
def test_public_reports_keep_complete_http_links_containing_file_uri_text(release, url):
    assert release.public_report(url, []) == url
    assert release.public_report(f"fetch '{url}'", []) == f"fetch '{url}'"
    assert release.public_report({url: f'fetch "{url}" --input=file://private-server/work%20dir/report.json'}, []) == {
        url: f'fetch "{url}" --input=<local>'}


@pytest.mark.parametrize("local", ["/Users/Alice/private/report.json", "C:\\Users\\Alice\\private\\report.json",
                                  "file:///Users/Alice/private/report.json", "file:///C:/Users/Alice/private/report.json"])
def test_public_reports_redact_local_paths_inside_http_query_parameters(release, local):
    url = "https://example.test/check?report=" + local
    assert release.public_report(url, []) == "https://example.test/check?report=<local>"
    assert release.public_report(f"fetch '{url}'", []) == "fetch 'https://example.test/check?report=<local>'"


def test_public_reports_preserve_known_machine_root_redaction_in_http_links(release):
    assert release.public_report("https://example.test/check?report=/private/candidate/report.json",
                                 [(Path("/private/candidate"), "<source>")]) == "https://example.test/check?report=<source>/report.json"


@pytest.mark.parametrize("uri", ["file:///Users/Alice/private/report.json", "file:///C:/Users/Alice/report.json",
                                "file://private-server/work%20dir/report.json"])
def test_public_reports_still_redact_quoted_and_assigned_local_file_uris(release, uri):
    assert release.public_report(f"--input='{uri}'", []) == "--input='<local>'"
    assert release.public_report(f'open "{uri}"', []) == 'open "<local>"'
    assert release.public_report(f"--input={uri}", []) == "--input=<local>"


def test_final_staging_preserves_exact_original_candidate_bytes(release, source, final_setup):
    installer, output, reports, state = final_setup()
    path = state["build_candidate"]
    prior = json.loads(path.read_text())
    raw = (" \n" + json.dumps(prior, indent=3, sort_keys=True) + "\n\n").encode()
    path.write_bytes(raw)
    release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=path)
    candidate = json.loads((output / "candidate.json").read_text())
    bound = json.loads((output / candidate["originalBuildCandidate"]).read_text())
    assert (reports / "original-candidate.json").read_bytes() == raw
    assert (output / "evidence/original-candidate.json").read_bytes() == raw
    assert bound["candidateSha256"] == hashlib.sha256(raw).hexdigest()
    assert bound["originalCandidate"] == "evidence/original-candidate.json"


@pytest.mark.parametrize("private", ["file:///Users/Alice/private/report.json", "/Users/Alice/private/report.json"])
def test_final_staging_keeps_private_original_candidate_and_refuses_public_paths(release, source, final_setup, private):
    installer, output, reports, state = final_setup()
    path = state["build_candidate"]
    prior = json.loads(path.read_text())
    prior["privateDiagnostic"] = private
    raw = json.dumps(prior).encode()
    path.write_bytes(raw)
    with pytest.raises(ValueError, match="Original candidate.*private|Original candidate.*public"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=path)
    assert (reports / "original-candidate.json").read_bytes() == raw and not output.exists()
    assert not state["calls"]


@pytest.mark.parametrize("platform", ["win32", "linux"])
@pytest.mark.parametrize("mutation", ["bytes", "mode", "add", "remove", "type", "link"])
def test_final_staging_rejects_gate_mutations_to_complete_selected_payload(release, source, final_setup, monkeypatch, platform, mutation):
    installer, output, reports, state = final_setup(platform)
    run = subprocess.run
    def mutate(command, **kwargs):
        result = run(command, **kwargs)
        if command[0] in {"7z", "dpkg-deb"}:
            payload = (Path(next(arg[2:] for arg in command if arg.startswith("-o"))) if command[0] == "7z" else Path(command[3]))
            state["payload"] = payload
            (payload / "engine.cfg").write_bytes(b"original selected bytes")
            (payload / "engine.cfg").chmod(0o755)
            (payload / "other.cfg").write_bytes(b"another selected file")
            if platform == "win32":
                (payload / "engine.link").write_bytes(b"original regular NSIS entry")
            else:
                (payload / "engine.link").symlink_to("engine.cfg")
        elif "check-bundle.py" in command[1]:
            target = state["payload"] / "engine.cfg"
            if mutation == "bytes":
                target.write_bytes(b"modified selected bytes")
            elif mutation == "mode":
                target.chmod(0o644)
            elif mutation == "add":
                (target.parent / "added.cfg").write_bytes(b"gate-added bytes")
            elif mutation == "remove":
                target.unlink()
            elif mutation == "type":
                target.unlink()
                target.mkdir()
            else:
                link = target.parent / "engine.link"
                link.unlink()
                link.symlink_to("other.cfg")
            assert release.checksum(state["snapshot"]) == release.checksum(installer)
        return result
    monkeypatch.setattr(subprocess, "run", mutate)
    with pytest.raises(ValueError, match="payload.*changed"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and reports.exists()


@pytest.mark.parametrize("platform", ["win32", "linux"])
def test_final_staging_rechecks_complete_payload_before_final_asset_handoff(release, source, final_setup, monkeypatch, platform):
    installer, output, reports, state = final_setup(platform)
    copyfile = shutil.copyfile
    mutated = False
    def copy(path, destination, *args, **kwargs):
        nonlocal mutated
        result = copyfile(path, destination, *args, **kwargs)
        path = Path(path)
        if path.name == "THIRD-PARTY.txt" and "bundled" in path.parts:
            bundle = path.parent
            application = bundle.parent / "PractiQ.exe" if platform == "win32" else bundle.parents[3] / "usr/bin/PractiQ"
            application.write_bytes(application.read_bytes() + b"unchecked handoff mutation")
            mutated = True
        return result
    monkeypatch.setattr(shutil, "copyfile", copy)
    with pytest.raises(ValueError, match="payload.*changed.*handoff"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert mutated and len(state["calls"]) == 2 and not output.exists() and reports.exists()


@pytest.mark.parametrize("mutation", ["digest", "nested", "raw", "missing", "outside", "absolute", "link"])
def test_final_assembly_binds_exact_original_candidate_bytes_despite_new_outer_digest(release, source, restaged, mutation):
    folder = restaged / "release-macos"
    evidence = folder / "evidence"
    bound_path = evidence / "build-candidate.json"
    bound = json.loads(bound_path.read_text())
    raw_path = evidence / "original-candidate.json"
    if mutation == "digest":
        bound["candidateSha256"] = "b" * 64
    elif mutation == "nested":
        bound["candidate"]["sha256"] = "b" * 64
        bound["verifiedCandidateSha256"] = hashlib.sha256(json.dumps(bound["candidate"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    elif mutation == "raw":
        raw_path.write_bytes(raw_path.read_bytes() + b"\n")
    elif mutation == "missing":
        raw_path.unlink()
    elif mutation in {"outside", "absolute"}:
        outside = source / "unrelated-original-candidate.json"
        outside.write_bytes(raw_path.read_bytes())
        bound["originalCandidate"] = str(outside) if mutation == "absolute" else "../unrelated-original-candidate.json"
    else:
        outside = source / "unrelated-original-candidate.json"
        raw_path.rename(outside)
        raw_path.symlink_to(outside)
    bound_path.write_text(json.dumps(bound))
    path = folder / "candidate.json"
    candidate = json.loads(path.read_text())
    candidate["evidence"] = {f"evidence/{item.name}": release.checksum(item) for item in evidence.iterdir()}
    path.write_text(json.dumps(candidate))
    output = source / "modified-provenance-assets"
    with pytest.raises(ValueError, match="Original candidate|original candidate|release evidence"):
        release.assemble(source, "v0.1.0", restaged, output)
    assert not output.exists()


def test_final_assembly_archives_the_exact_original_candidate_bytes(release, source, restaged):
    expected = (restaged / "release-macos/evidence/original-candidate.json").read_bytes()
    output = source / "exact-provenance-assets"
    release.assemble(source, "v0.1.0", restaged, output)
    with zipfile.ZipFile(output / "release-evidence.zip") as archive:
        assert archive.read("macos/evidence/original-candidate.json") == expected


@pytest.mark.parametrize("platform", ["win32", "linux"])
@pytest.mark.parametrize("phase", [None, "gate", "handoff"])
def test_ordinary_ci_staging_binds_complete_payload_before_gates_and_handoff(release, source, monkeypatch, platform, phase):
    monkeypatch.setattr(sys, "platform", platform)
    for name, value in {"GITHUB_SERVER_URL": "https://github.com", "GITHUB_REPOSITORY": "test/repo", "GITHUB_RUN_ID": "42"}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setitem(release.stage.__globals__, "git", lambda _, *args: "" if args[0] == "status" else "a" * 40)
    payload = source / "selected-payload"
    bundle = payload / ("bundled" if platform == "win32" else "usr/lib/PractiQ/bundled")
    bundle.mkdir(parents=True)
    (bundle / "build-manifest.json").write_text(json.dumps({"schemaVersion": 2, "packageMode": "desktop-practice", "platform": platform, "architecture": "x86_64", "desktopVersion": "0.1.0"}))
    (bundle / "THIRD-PARTY.txt").write_text("Synthetic candidate notice")
    application = payload / ("PractiQ.exe" if platform == "win32" else "usr/bin/PractiQ")
    application.parent.mkdir(parents=True, exist_ok=True)
    application.write_bytes(native_pe() if platform == "win32" else native_elf())
    application.chmod(0o755)
    installer = source / "app/src-tauri/target/release/bundle" / ("nsis/selected-setup.exe" if platform == "win32" else "deb/selected.deb")
    installer.parent.mkdir(parents=True)
    installer.write_bytes(b"synthetic ordinary CI installer")
    @contextmanager
    def extracted(snapshot, *args, **kwargs):
        assert snapshot != installer and snapshot.read_bytes() == installer.read_bytes()
        yield bundle
    monkeypatch.setitem(release.stage_installer.__globals__, "final_bundle", extracted)
    monkeypatch.setitem(release.stage_installer.__globals__, "check_desktop_version", lambda *args, **kwargs: "0.1.0")
    calls = []
    def run(command, **kwargs):
        calls.append(command)
        Path(command[command.index("--output") + 1]).write_text('{"passed":true}')
        if "--notices" in command:
            Path(command[command.index("--notices") + 1]).write_text("Synthetic candidate notice")
        if phase == "gate" and "check-bundle.py" in command[1]:
            application.write_bytes(application.read_bytes() + b"gate mutation")
    copyfile = shutil.copyfile
    def copy(path, destination, *args, **kwargs):
        result = copyfile(path, destination, *args, **kwargs)
        if phase == "handoff" and Path(path) == bundle / "THIRD-PARTY.txt":
            application.write_bytes(application.read_bytes() + b"handoff mutation")
        return result
    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(shutil, "copyfile", copy)
    output = source / "app/.build/release"
    if phase:
        with pytest.raises(ValueError, match="payload.*changed"):
            release.stage_installer(source, "v0.1.0")
        assert not output.exists()
    else:
        release.stage_installer(source, "v0.1.0")
        candidate = json.loads((output / "candidate.json").read_text())
        assert candidate["signing"] == "unsigned" and candidate["cleanMachineAcceptance"] == candidate["liveModelAcceptance"] == "pending"
        assert (output / candidate["file"]).read_bytes() == installer.read_bytes()
    assert len(calls) == 2


def duplicate_original_bytes(candidate, location, private):
    hidden = "file:///Users/Alice/private/report.json" if private else "harmless first value"
    pair = f'"path":{json.dumps(hidden)},"path":"safe"'
    duplicate = (f'"privateDiagnostic":{json.dumps(hidden)}' + r',"private\u0044iagnostic":"safe"' if location == "escaped" else
                 f'"privateDiagnostic":{json.dumps(hidden)},"privateDiagnostic":"safe"' if location == "top" else
                 f'"diagnostic":{{{pair}}}' if location == "nested" else f'"diagnostics":[{{{pair}}}]')
    return (json.dumps(candidate, indent=3)[:-1] + "," + duplicate + "}").encode()


@pytest.mark.parametrize("location", ["top", "nested", "array", "escaped"])
@pytest.mark.parametrize("private", [False, True])
def test_original_build_rejects_all_duplicate_json_keys_before_public_staging(release, source, final_setup, location, private):
    installer, output, reports, state = final_setup()
    path = state["build_candidate"]
    raw = duplicate_original_bytes(json.loads(path.read_bytes()), location, private)
    path.write_bytes(raw)
    with pytest.raises(ValueError, match="duplicate object keys"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=path)
    assert path.read_bytes() == raw and not output.exists() and not reports.exists()
    assert not state["calls"] and not state["native"]


@pytest.mark.parametrize("location", ["top", "nested", "array", "escaped"])
@pytest.mark.parametrize("private", [False, True])
def test_stage_rechecks_duplicate_keys_in_exact_original_bytes_and_retains_private_raw(release, source, final_setup, monkeypatch, location, private):
    installer, output, reports, state = final_setup()
    provenance, _ = release.original_build(source, "v0.1.0", "a" * 40, state["build_candidate"])
    raw = duplicate_original_bytes(provenance["candidate"], location, private)
    provenance["candidate"] = json.loads(raw)
    provenance["candidateSha256"] = hashlib.sha256(raw).hexdigest()
    provenance["verifiedCandidateSha256"] = hashlib.sha256(json.dumps(provenance["candidate"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    # Isolate the later public stage boundary even if earlier provenance validation was bypassed.
    monkeypatch.setitem(release.restage_installer.__globals__, "original_build", lambda *_: (provenance, raw))
    with pytest.raises(ValueError, match="duplicate object keys"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert (reports / "original-candidate.json").read_bytes() == raw and not output.exists() and not state["calls"]


@pytest.mark.parametrize("location", ["top", "nested", "array", "escaped"])
@pytest.mark.parametrize("private", [False, True])
def test_assembly_rejects_original_duplicate_keys_after_all_digests_are_regenerated(release, source, restaged, location, private):
    folder = restaged / "release-macos"
    evidence = folder / "evidence"
    bound_path = evidence / "build-candidate.json"
    bound = json.loads(bound_path.read_bytes())
    raw = duplicate_original_bytes(bound["candidate"], location, private)
    (evidence / "original-candidate.json").write_bytes(raw)
    bound["candidate"] = json.loads(raw)
    bound["candidateSha256"] = hashlib.sha256(raw).hexdigest()
    bound["verifiedCandidateSha256"] = hashlib.sha256(json.dumps(bound["candidate"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    bound_path.write_text(json.dumps(bound))
    path = folder / "candidate.json"
    candidate = json.loads(path.read_bytes())
    candidate["evidence"] = {f"evidence/{item.name}": release.checksum(item) for item in evidence.iterdir()}
    path.write_text(json.dumps(candidate))
    output = source / "ambiguous-original-assets"
    with pytest.raises(ValueError, match="duplicate object keys"):
        release.assemble(source, "v0.1.0", restaged, output)
    assert not output.exists() and (evidence / "original-candidate.json").read_bytes() == raw
