"""Desktop packages ship practice resources and notices, without AI engines."""

import json
import plistlib
import runpy
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]


@pytest.fixture(params=["darwin", "win32"])
def package(tmp_path, monkeypatch, request):
    monkeypatch.setattr(sys, "platform", request.param)
    app = tmp_path / ("PractiQ.app" if sys.platform == "darwin" else "application")
    bundle = app / {"darwin": "Contents/Resources/bundled",
                    "win32": "bundled"}[sys.platform]
    bundle.mkdir(parents=True)
    (bundle / "build-manifest.json").write_text(json.dumps({
        "schemaVersion": 2, "packageMode": "desktop-practice", "platform": sys.platform,
        "architecture": "arm64" if sys.platform == "darwin" else "x86_64", "desktopVersion": "0.1.0",
    }))
    (bundle / "THIRD-PARTY.txt").write_text("Synthetic desktop notices")
    executable = app / {"darwin": "Contents/MacOS/PractiQ",
                        "win32": "PractiQ.exe"}[sys.platform]
    executable.parent.mkdir(parents=True, exist_ok=True)
    executable.write_bytes(b"Synthetic native application; never executed")
    if sys.platform == "darwin":
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "PractiQ"}))
    return app, bundle


def checker():
    scope = runpy.run_path(str(ROOT / "app/scripts/check-bundle.py"))
    assert "validate_package" in scope, "Desktop package checks must not start bundled AI workers"
    return scope["validate_package"]


def test_desktop_package_checks_pure_metadata_without_starting_a_worker(package):
    app, bundle = package
    report = checker()(bundle, app)
    assert report["passed"] and report["packageMode"] == "desktop-practice"
    assert report["embeddedAiEngines"] == []


def test_desktop_package_rejects_resources_without_the_native_application(package):
    app, bundle = package
    scope = runpy.run_path(str(ROOT / "app/scripts/check-bundle.py"))
    scope["native_application"](bundle).unlink()
    with pytest.raises(ValueError, match="native|executable|Info.plist"):
        checker()(bundle, app)


@pytest.mark.parametrize("name", ["bundled/python/practiq-ai", "bundled/office/soffice",
                                  "libpython3.14.dylib", "python314.dll", "python3.14", "LibreOffice.app/soffice",
                                  "bundled/PYTHON-LICENSE.txt", "practiq-ai.exe", "base_library.zip"])
def test_desktop_package_rejects_stale_runtime_anywhere_in_actual_application(package, name):
    app, bundle = package
    path = app / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"Stale engine")
    with pytest.raises(ValueError, match="embedded AI"):
        checker()(bundle, app)


@pytest.mark.parametrize("mutation", ["legacy", "mode", "schema", "missing_notice"])
def test_desktop_package_rejects_old_bundle_metadata_and_missing_notices(package, mutation):
    app, bundle = package
    manifest = bundle / "build-manifest.json"
    data = json.loads(manifest.read_text())
    if mutation == "legacy":
        data = {"platform": sys.platform, "architecture": "arm64", "packages": [], "libreoffice": {}}
    elif mutation == "mode":
        data["packageMode"] = "bundled-ai"
    elif mutation == "schema":
        data["schemaVersion"] = 1
    else:
        (bundle / "THIRD-PARTY.txt").unlink()
    manifest.write_text(json.dumps(data))
    with pytest.raises((ValueError, FileNotFoundError)):
        checker()(bundle, app)


def test_desktop_resources_are_an_exact_metadata_and_notice_whitelist():
    config = json.loads((ROOT / "app/src-tauri/tauri.conf.json").read_text())
    assert config["bundle"]["resources"] == {
        "bundled/build-manifest.json": "bundled/build-manifest.json",
        "bundled/THIRD-PARTY.txt": "bundled/THIRD-PARTY.txt",
    }
    for platform in ("windows",):
        config = json.loads((ROOT / f"app/src-tauri/tauri.{platform}.conf.json").read_text())
        assert "office" not in json.dumps(config).lower()
        assert "python" not in json.dumps(config).lower()


def test_desktop_package_rejects_extra_payload_and_external_symlinks(package, tmp_path):
    app, bundle = package
    (bundle / "unexpected.bin").write_bytes(b"Unexpected resource")
    with pytest.raises(ValueError, match="only metadata and notices"):
        checker()(bundle, app)
    (bundle / "unexpected.bin").unlink()
    outside = tmp_path / "external.txt"
    outside.write_text("Outside file")
    (bundle / "unexpected.bin").symlink_to(outside)
    with pytest.raises(ValueError, match="escapes"):
        checker()(bundle, app)


def test_linux_app_target_and_config_are_removed():
    scope = runpy.run_path(str(ROOT / "app/scripts/desktop_package.py"))
    with pytest.raises(ValueError, match="Unsupported"):
        scope["validate_manifest"]({}, "linux")
    assert not (ROOT / "app/src-tauri/tauri.linux.conf.json").exists()


@pytest.mark.parametrize("mutation", ["original", "snapshot"])
def test_installer_check_hashes_checked_snapshot_when_selected_path_is_replaced(package, tmp_path, monkeypatch, mutation):
    _app, bundle = package
    monkeypatch.syspath_prepend(str(ROOT / "app/scripts"))
    scope = runpy.run_path(str(ROOT / "app/scripts/check-installer.py"))
    release = scope["main"].__globals__["release"]
    installer = tmp_path / "selected.dmg"
    installer.write_bytes(b"Checked original installer")
    output = tmp_path / "report.json"
    @contextmanager
    def extracted(path, *args, **kwargs):
        assert path.read_bytes() == b"Checked original installer"
        yield bundle
    def version(path, *args):
        target = installer if mutation == "original" else path
        target.chmod(0o600)
        target.write_bytes(b"Unchecked replacement installer")
        return "0.1.0"
    monkeypatch.setattr(release, "final_bundle", extracted)
    monkeypatch.setattr(release, "check_desktop_version", version)
    monkeypatch.setattr(sys, "argv", ["check-installer.py", "--installer", str(installer), "--output", str(output)])
    if mutation == "snapshot":
        with pytest.raises(ValueError, match="snapshot"):
            scope["main"]()
        assert not output.exists()
        return
    scope["main"]()
    import hashlib
    assert json.loads(output.read_text())["installerSha256"] == hashlib.sha256(b"Checked original installer").hexdigest()
