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
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace

import pytest
import yaml

ROOT = Path(__file__).parents[2]
LINUX_DEPENDENCIES = ["libwebkit2gtk-4.1-0", "libgtk-3-0", *json.loads(
    (ROOT / "app/src-tauri/tauri.linux.conf.json").read_text()
)["bundle"]["linux"]["deb"]["depends"]]


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
                     "buildRun": "https://github.com/test/repo/actions/runs/42",
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


@pytest.mark.parametrize("mutation", ["installer", "evidence", "candidate", "service"])
def test_release_assembly_rechecks_delivered_bytes_after_input_validation(release, source, staged, monkeypatch, mutation):
    output = source / "assets"
    copy = shutil.copyfile
    write = zipfile.ZipFile.write
    changed = False

    def copy_with_change(src, dst, *args, **kwargs):
        nonlocal changed
        if mutation == "installer" and not changed and Path(src).suffix == ".dmg":
            Path(src).write_bytes(b"different installer")
            changed = True
        return copy(src, dst, *args, **kwargs)

    def archive_with_change(archive, filename, *args, **kwargs):
        nonlocal changed
        path = Path(filename)
        if not changed and ((mutation == "evidence" and path.name == "licenses.json") or
                            (mutation == "candidate" and path.name == "candidate.json") or
                            (mutation == "service" and path.name == "coverage.xml")):
            value = json.loads(path.read_text()) if mutation != "service" else None
            if mutation == "evidence":
                assert value is not None
                value["passed"] = False
            elif mutation == "candidate":
                assert value is not None
                value["sha256"] = "b" * 64
            path.write_text(json.dumps(value) if value is not None else "changed service evidence")
            changed = True
        return write(archive, filename, *args, **kwargs)

    monkeypatch.setattr(shutil, "copyfile", copy_with_change)
    monkeypatch.setattr(zipfile.ZipFile, "write", archive_with_change)
    with pytest.raises(ValueError, match="assembly"):
        release.assemble(source, "v0.1.0", staged, output)
    assert changed and not (output / "release-manifest.json").exists()
    assert not (output / "SHA256SUMS.txt").exists()


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
        for name in ("desktop-bundle.json", "office.json", "office-fidelity.json", "licenses.json"):
            (original_evidence / name).write_text('{"passed":true}')
        (original_evidence / "build-manifest.json").write_text(json.dumps({
            "platform": platform, "architecture": "arm64" if platform == "darwin" else "x86_64",
            "packages": [{"name": "practiq-ai-service", "version": "0.3.0"}]}))
        state["build_candidate"] = original / "candidate.json"
        state["build_candidate"].write_text(json.dumps({
            "tag": "v0.1.0", "commit": "a" * 40, "components": release.versions(source, "v0.1.0"),
            "os": os_name, "architecture": arch, "file": original_name,
            "sha256": release.checksum(original / original_name), "sizeBytes": (original / original_name).stat().st_size,
            "signing": "unsigned",
            "buildRun": "https://github.com/test/repo/actions/runs/42",
            "evidence": {"evidence/" + path.name: release.checksum(path) for path in original_evidence.iterdir()}}))

        def make_bundle(bundle):
            application = None
            bundle.mkdir(parents=True)
            (bundle / "build-manifest.json").write_text(json.dumps({
                "platform": platform, "architecture": "arm64" if platform == "darwin" else "x86_64",
                "packages": [{"name": "practiq-ai-service", "version": "0.3.0"}],
            }))
            for name in ("THIRD-PARTY.txt", "PYTHON-LICENSE.txt"):
                (bundle / name).write_text("Synthetic candidate notice")
            if platform == "darwin":
                info = {"CFBundleShortVersionString": "0.2.0" if fault == "desktop_version" else "0.1.0", "CFBundleExecutable": "PractiQ"}
                if fault == "native_identity_missing":
                    del info["CFBundleExecutable"]
                elif fault == "native_identity_wrong":
                    info["CFBundleExecutable"] = "AnotherApplication"
                elif fault == "native_identity_path":
                    info["CFBundleExecutable"] = "../Resources/bundled/python/practiq-ai"
                (bundle.parents[1] / "Info.plist").write_bytes(plistlib.dumps(info))
                application = bundle.parents[1] / "MacOS/PractiQ"
                if fault == "desktop_version_link":
                    plist = bundle.parents[1] / "Info.plist"
                    external = source / "unrelated-version.plist"
                    plist.rename(external)
                    plist.symlink_to(external)
            elif platform == "win32":
                (bundle.parent / "PractiQ.exe").write_bytes(native_pe(0xAA64 if fault == "windows_arm64" else 0x14C if fault == "windows_x86" else 0x8664,
                                                                      0x10B if fault == "windows_pe32" else 0x20B))
                (bundle.parent / "uninstall.exe").write_bytes(b"synthetic uninstaller")
            else:
                application = bundle.parents[3] / "usr/bin/PractiQ"
            if platform != "win32":
                assert application is not None
                application.parent.mkdir(parents=True)
                payload = native_macho() if platform == "darwin" else native_elf()
                if fault == "native_wrong_arch":
                    payload = native_macho(0x1000007) if platform == "darwin" else native_elf(183)
                elif fault == "native_script":
                    payload = b"#!/bin/sh\nexit 0\n"
                elif fault == "native_truncated":
                    payload = payload[:24]
                elif fault == "native_not_executable":
                    payload = native_macho(filetype=6) if platform == "darwin" else native_elf(filetype=1)
                application.write_bytes(state.get("native_payload", payload))
                if fault == "native_missing":
                    application.unlink()
                elif fault == "native_empty":
                    application.write_bytes(b"")
                elif fault == "native_directory":
                    application.unlink()
                    application.mkdir()
                elif fault in {"native_absolute_link", "native_relative_link"}:
                    target = source / "unrelated-native-application"
                    application.rename(target)
                    application.symlink_to(target if fault == "native_absolute_link" else os.path.relpath(target, application.parent))
                elif fault in {"native_parent_absolute_link", "native_parent_relative_link"}:
                    parent = application.parent
                    target = source / "unrelated-native-directory"
                    parent.rename(target)
                    parent.symlink_to(target if fault == "native_parent_absolute_link" else os.path.relpath(target, parent.parent), target_is_directory=True)
                elif fault == "native_internal_link":
                    target = application.with_name("other-binary")
                    application.rename(target)
                    application.symlink_to(target.name)
            if fault in {"bundle_dangling_resource", "bundle_cyclic_resource"}:
                (bundle / "python").mkdir()
                (bundle / "python/practiq-ai").symlink_to("missing-or-cyclic-engine")
                if fault == "bundle_cyclic_resource":
                    (bundle / "python/missing-or-cyclic-engine").symlink_to("practiq-ai")
            elif fault == "bundle_internal_directory":
                (bundle / "engine-files").mkdir()
                (bundle / "engine-files/practiq-ai").write_bytes(b"Synthetic service binary")
                (bundle / "python").symlink_to("engine-files", target_is_directory=True)
            elif fault in {"bundle_external_resource", "bundle_relative_external_resource", "bundle_absolute_internal_resource", "bundle_internal_resource"}:
                (bundle / "python").mkdir()
                target = (bundle / "python/real-engine" if "internal" in fault else source / "unrelated-engine")
                target.write_bytes(b"Synthetic service binary")
                link = (os.path.relpath(target, bundle / "python") if fault.startswith("bundle_relative") or fault == "bundle_internal_resource" else target)
                (bundle / "python/practiq-ai").symlink_to(link)
            elif fault == "bundle_missing":
                shutil.rmtree(bundle)
            elif fault == "bundle_file":
                shutil.rmtree(bundle)
                bundle.write_bytes(b"Not a directory")
            elif fault and fault.startswith("bundle_link_"):
                target = bundle.parent if fault.endswith("parent") else bundle
                if fault.endswith("root"):
                    target = bundle.parents[3]
                replacement = (bundle.parent / "actual-bundled" if fault.endswith("internal")
                               else source / "unrelated-installed-bundle")
                target.rename(replacement)
                link = os.path.relpath(replacement, target.parent) if "relative" in fault else replacement
                target.symlink_to(link, target_is_directory=True)

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
                if "--fidelity-only" in command and fault == "gate":
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
            if command[0] == "7z":
                return "Path = PractiQ.exe\nSize = 1\n\nPath = bundled/build-manifest.json\nSize = 1\n"
            if command[:2] == ["dpkg-deb", "-f"]:
                if command[-1] == "Architecture":
                    return "arm64\n" if fault == "deb_architecture" else "amd64\n"
                if command[-1] == "Depends":
                    state["dependencies"] = state.get("dependencies", ", ".join(LINUX_DEPENDENCIES))
                    return state["dependencies"] + "\n"
            return "0.2.0\n" if fault == "desktop_version" else "0.1.0\n"
        monkeypatch.setattr(subprocess, "check_output", check_output)
        monkeypatch.setattr(shutil, "which", lambda name: "7z" if name == "7z" else None)
        return installer, output, reports, state
    return setup


def test_final_deb_rejects_wrong_architecture_before_bundle_gates(release, source, final_setup):
    installer, output, reports, state = final_setup("linux", "deb_architecture")
    with pytest.raises(ValueError, match="architecture"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not state["calls"]


@pytest.mark.parametrize("missing", LINUX_DEPENDENCIES)
def test_final_deb_requires_every_native_and_declared_runtime_dependency(release, source, final_setup, missing):
    installer, output, reports, state = final_setup("linux")
    state["dependencies"] = ", ".join(name for name in LINUX_DEPENDENCIES if name != missing)
    with pytest.raises(ValueError, match="dependencies"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not state["calls"]


def test_final_deb_does_not_treat_an_optional_dependency_as_required(release, source, final_setup):
    installer, output, reports, state = final_setup("linux")
    state["dependencies"] = ", ".join(LINUX_DEPENDENCIES).replace("libgtk-3-0", "libgtk-3-0 | substitute")
    with pytest.raises(ValueError, match="dependencies"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not state["calls"]


def test_final_deb_reads_candidate_runtime_dependencies(release, source, final_setup):
    installer, output, reports, state = final_setup("linux")
    config_path = source / "app/src-tauri/tauri.linux.conf.json"
    config = json.loads(config_path.read_text())
    config["bundle"]["linux"]["deb"]["depends"].append("candidate-runtime")
    config_path.write_text(json.dumps(config))
    with pytest.raises(ValueError, match="candidate-runtime"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not state["calls"]


def test_final_deb_accepts_extra_dependencies_and_control_field_whitespace(release, source, final_setup):
    installer, output, reports, state = final_setup("linux")
    state["dependencies"] = " ,\n\t".join([*LINUX_DEPENDENCIES, "extra-runtime (>= 2)"])
    release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert output.is_dir() and len(state["calls"]) == 4


@pytest.mark.parametrize("suffix", ["", " (>= 1.0)", ":amd64 (>= 1.0)", ":any"])
def test_final_deb_accepts_mandatory_versioned_and_qualified_dependencies(release, source, final_setup, suffix):
    installer, output, reports, state = final_setup("linux")
    state["dependencies"] = ", ".join(name + suffix for name in LINUX_DEPENDENCIES)
    release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert output.is_dir() and len(state["calls"]) == 4


@pytest.mark.parametrize("platform", ["darwin", "linux"])
@pytest.mark.parametrize("fault", ["bundle_missing", "bundle_file", "bundle_link_absolute",
                                   "bundle_link_relative", "bundle_link_absolute_parent", "bundle_link_relative_parent",
                                   "bundle_link_absolute_root", "bundle_link_relative_internal"])
def test_final_bundle_rejects_missing_non_directory_and_symlinked_paths_before_gates(release, source, final_setup, platform, fault):
    installer, output, reports, state = final_setup(platform, fault)
    with pytest.raises(ValueError, match="bundle"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not state["calls"]
    if platform == "darwin":
        assert state["mounted"] == ["detached"]


@pytest.mark.parametrize("platform", ["darwin", "linux"])
@pytest.mark.parametrize("fault", ["bundle_external_resource", "bundle_relative_external_resource", "bundle_absolute_internal_resource",
                                   "bundle_dangling_resource", "bundle_cyclic_resource"])
def test_final_bundle_rejects_resource_links_to_machine_paths(release, source, final_setup, platform, fault):
    installer, output, reports, state = final_setup(platform, fault)
    with pytest.raises(ValueError, match="bundle"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not state["calls"]
    if platform == "darwin":
        assert state["mounted"] == ["detached"]


@pytest.mark.parametrize("platform", ["darwin", "linux"])
@pytest.mark.parametrize("fault", ["bundle_internal_resource", "bundle_internal_directory"])
def test_final_bundle_keeps_relative_internal_runtime_links(release, source, final_setup, platform, fault):
    installer, output, reports, state = final_setup(platform, fault)
    release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert output.is_dir() and len(state["calls"]) == 4


def test_final_macos_version_cannot_follow_an_external_plist(release, source, final_setup):
    installer, output, reports, state = final_setup("darwin", "desktop_version_link")
    with pytest.raises(ValueError, match="desktop version"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not state["calls"] and state["mounted"] == ["detached"]


@pytest.mark.parametrize("platform", ["darwin", "linux"])
@pytest.mark.parametrize("fault", ["native_missing", "native_empty", "native_directory", "native_absolute_link",
                                   "native_relative_link", "native_parent_absolute_link", "native_parent_relative_link",
                                   "native_internal_link"])
def test_final_staging_requires_the_contained_native_desktop_executable(release, source, final_setup, platform, fault):
    installer, output, reports, state = final_setup(platform, fault)
    with pytest.raises(ValueError, match="desktop executable"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not state["calls"]
    if platform == "darwin":
        assert state["mounted"] == ["detached"]


@pytest.mark.parametrize("fault", ["native_identity_missing", "native_identity_wrong", "native_identity_path"])
def test_final_macos_plist_must_identify_the_expected_native_executable(release, source, final_setup, fault):
    installer, output, reports, state = final_setup("darwin", fault)
    with pytest.raises(ValueError, match="desktop executable"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not state["calls"] and state["mounted"] == ["detached"]


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
    assert len(state["calls"]) == 4
    assert "--isolated" in state["calls"][1] and "--fidelity-only" in state["calls"][2]
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


@pytest.mark.parametrize("fault", ["windows_arm64", "windows_x86", "windows_pe32"])
def test_final_windows_rejects_wrong_native_architecture_before_bundle_gates(release, source, final_setup, fault):
    installer, output, reports, state = final_setup("win32", fault)
    with pytest.raises(ValueError, match="PE|x64"):
        release.restage_installer(source, "v0.1.0", installer, output, reports, build_candidate=state["build_candidate"])
    assert not output.exists() and not reports.exists() and not state["calls"]


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
    assert output.exists() and len(state["calls"]) == 4


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
    assert output.exists() and len(state["calls"]) == 4


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
        (path.parent / "evidence/office.json").write_text("altered original report")
    elif mutation == "failed_gate":
        report = path.parent / "evidence/office.json"
        report.write_text('{"passed":false}')
        candidate["evidence"]["evidence/office.json"] = release.checksum(report)
    elif mutation == "missing_gate":
        candidate["evidence"].pop("evidence/office.json")
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
    bundle = (source / "Example.app/Contents/Resources/bundled" if platform == "darwin" else
              source / "extracted/usr/lib/PractiQ/bundled" if platform == "linux" else source / "extracted/bundled")
    bundle.mkdir(parents=True)
    expected = "0.1.0-alpha.1"
    if platform == "darwin":
        (bundle.parents[1] / "Info.plist").write_bytes(plistlib.dumps({"CFBundleShortVersionString": expected, "CFBundleExecutable": "PractiQ"}))
        application = bundle.parents[1] / "MacOS/PractiQ"
        application.parent.mkdir()
        application.write_bytes(native_macho())
    elif platform == "win32":
        (bundle.parent / "PractiQ.exe").write_bytes(native_pe())
    else:
        application = bundle.parents[3] / "usr/bin/PractiQ"
        application.parent.mkdir()
        application.write_bytes(native_elf())
    def metadata(command, **kwargs):
        return ({"Architecture": "amd64", "Depends": ", ".join(LINUX_DEPENDENCIES)}.get(command[-1], expected)) + "\n"
    monkeypatch.setattr(subprocess, "check_output", metadata)
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
    assert (reports / "office-fidelity.json").exists()
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
        (evidence / "build-candidate.json").write_text(json.dumps({"candidateSha256": "a" * 64,
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
