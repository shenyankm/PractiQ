"""The desktop distribution contains practice code, metadata and notices."""

import json
import plistlib
import re
import sys
from pathlib import Path

SCHEMA_VERSION = 2
PACKAGE_MODE = "desktop-practice"


def validate_manifest(manifest: dict, platform: str = sys.platform, version: str | None = None) -> None:
    if platform not in {"darwin", "win32", "linux"}:
        raise ValueError("Unsupported desktop package platform")
    if set(manifest) != {"schemaVersion", "packageMode", "platform", "architecture", "desktopVersion"}:
        raise ValueError("Expected pure desktop package metadata")
    if manifest["schemaVersion"] != SCHEMA_VERSION or manifest["packageMode"] != PACKAGE_MODE:
        raise ValueError("Unsupported desktop package mode or schema")
    architectures = {"arm64", "aarch64"} if platform == "darwin" else {"x86_64", "AMD64", "amd64"}
    if manifest["platform"] != platform or manifest["architecture"] not in architectures:
        raise ValueError("Unsupported desktop package platform or architecture")
    if not isinstance(manifest["desktopVersion"], str) or not manifest["desktopVersion"] or (version is not None and manifest["desktopVersion"] != version):
        raise ValueError("Desktop package metadata does not match the candidate version")


def read_manifest(bundle: Path) -> dict:
    manifest = json.loads((bundle / "build-manifest.json").read_text(encoding="utf-8"))
    validate_manifest(manifest)
    return manifest


def application_root(bundle: Path) -> Path:
    if sys.platform == "darwin":
        return bundle.parents[2]
    if sys.platform == "linux" and bundle.parent.parent.name == "lib" and bundle.parent.parent.parent.name == "usr":
        return bundle.parents[3]
    return bundle.parent


def native_application(bundle: Path, application_name: str = "PractiQ") -> Path:
    """Require this payload's expected native executable without starting it."""
    application = application_root(bundle)
    def regular_file(path: Path) -> None:
        if not path.resolve().is_relative_to(application.resolve()):
            raise ValueError(f"Desktop native executable or Info.plist escapes the application payload: {path.name}")
        if path.is_symlink() or path.is_junction() or not path.is_file():
            raise ValueError(f"Desktop native executable or Info.plist must be a regular file: {path.name}")
        for directory in path.parents:
            if directory.is_symlink() or directory.is_junction() or not directory.is_dir():
                raise ValueError("Desktop native executable requires real contained parent directories")
            if directory == application:
                break
    if sys.platform == "darwin":
        info = bundle.parents[1] / "Info.plist"
        regular_file(info)
        if plistlib.loads(info.read_bytes()).get("CFBundleExecutable") != application_name:
            raise ValueError("Info.plist native executable identity differs from the desktop application")
        executable = application / "Contents/MacOS" / application_name
    elif sys.platform == "win32":
        executable = application / (application_name + ".exe")
    else:
        executable = application / "usr/bin" / application_name
    regular_file(executable)
    return executable


def embedded_engines(application: Path) -> list[str]:
    rejected = []
    for path in application.rglob("*"):
        name = path.name.lower()
        if (name in {"python", "office", "python-license.txt", "base_library.zip", "practiq-ai", "practiq-ai.exe"}
                or name.startswith(("libreoffice", "soffice", "libpython"))
                or re.fullmatch(r"python(?:[0-9]+(?:\.[0-9]+)*)?", name)
                or (name.startswith("python") and name.endswith((".exe", ".dll", ".zip", ".framework")))
                or path.suffix.lower() in {".py", ".pyc", ".pyo", ".pyd"}):
            rejected.append(str(path.relative_to(application)))
        if path.is_symlink() and not path.resolve().is_relative_to(application.resolve()):
            raise ValueError("Desktop package resource escapes the application")
    return sorted(rejected)
