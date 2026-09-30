"""Check a frozen desktop release and assemble draft assets using only stdlib."""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NUMBER = r"(?:0|[1-9][0-9]*)"
TAG = re.compile(rf"v({NUMBER}\.{NUMBER}\.{NUMBER}(?:-(?:alpha|beta|rc)\.{NUMBER})?)")
PLATFORMS = {
    "darwin": ("macos", "arm64", "dmg/*.dmg", ".dmg"),
    "win32": ("windows", "x64", "nsis/*-setup.exe", "_setup.exe"),
    "linux": ("linux", "amd64", "deb/*.deb", ".deb"),
}


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def checksum(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def versions(root: Path, tag: str) -> dict:
    match = TAG.fullmatch(tag)
    if not match:
        raise ValueError("Use vX.Y.Z or vX.Y.Z-{alpha,beta,rc}.N without leading zeroes")
    version = match[1]
    package = read_json(root / "app/package.json")
    lock = read_json(root / "app/package-lock.json")
    cargo = tomllib.loads((root / "app/src-tauri/Cargo.toml").read_text(encoding="utf-8"))
    cargo_lock = tomllib.loads((root / "app/src-tauri/Cargo.lock").read_text(encoding="utf-8"))
    own = [p for p in cargo_lock["package"] if p["name"] == cargo["package"]["name"]]
    desktop = [package["version"], lock["version"], lock["packages"][""]["version"],
               cargo["package"]["version"], read_json(root / "app/src-tauri/tauri.conf.json")["version"]]
    if len(own) != 1 or desktop + [own[0]["version"]] != [version] * 6:
        raise ValueError("Tag, npm/Tauri/Cargo versions and both lockfiles must match")
    service = tomllib.loads((root / "server/pyproject.toml").read_text(encoding="utf-8"))
    return {"desktop": version, "aiService": service["project"]["version"]}


def check_candidate(root: Path, tag: str) -> dict:
    components = versions(root, tag)
    sha = git(root, "rev-parse", "HEAD")
    if git(root, "rev-parse", f"refs/tags/{tag}^{{commit}}") != sha:
        raise ValueError("Checkout must be the existing candidate tag")
    subprocess.run(["git", "merge-base", "--is-ancestor", sha, "origin/main"], cwd=root, check=True)
    if git(root, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("Release source must be clean")
    return {"tag": tag, "commit": sha, "components": components, "prerelease": "-" in tag}


def check_build(manifest: dict, platform: str, components: dict) -> None:
    expected_arch = {"arm64", "aarch64"} if platform == "darwin" else {"x86_64", "AMD64", "amd64"}
    if manifest["platform"] != platform or manifest["architecture"] not in expected_arch:
        raise ValueError("Only macOS arm64 and Windows/Linux x64 are release targets")
    service = [p["version"] for p in manifest["packages"] if p["name"] == "practiq-ai-service"]
    if service != [components["aiService"]]:
        raise ValueError("Bundled AI service does not match the candidate version")


def stage(root: Path, tag: str, bundle: Path, installer: Path, output: Path) -> None:
    components = versions(root, tag)
    os_name, arch, _, suffix = PLATFORMS[sys.platform]
    manifest = read_json(bundle / "build-manifest.json")
    check_build(manifest, sys.platform, components)
    if git(root, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("Release source changed during the build")
    reports = root / "server/reports/checks/release"
    reports.mkdir(parents=True, exist_ok=True)
    for script, filename, options in (
        ("check-bundle.py", "desktop-bundle.json", []),
        ("check-office.py", "office.json", ["--isolated"]),
        ("check-office.py", "office-fidelity.json", ["--fidelity-only"]),
        ("check_licenses.py", "licenses.json", []),
    ):
        subprocess.run([sys.executable, str(root / "app/scripts" / script), "--bundle", str(bundle),
                        "--output", str(reports / filename), *options], cwd=root, check=True)
        if read_json(reports / filename).get("passed") is not True:
            raise ValueError(f"Release gate did not pass: {filename}")
    output.mkdir(parents=True, exist_ok=False)
    name = f"PractiQ_{components['desktop']}_{os_name}_{arch}{suffix}"
    shutil.copyfile(installer, output / name)
    evidence = output / "evidence"
    shutil.copytree(reports, evidence)
    for filename in ("build-manifest.json", "THIRD-PARTY.txt", "PYTHON-LICENSE.txt"):
        shutil.copyfile(bundle / filename, evidence / filename)
    candidate = {
        "tag": tag, "commit": git(root, "rev-parse", "HEAD"), "components": components,
        "os": os_name, "architecture": arch, "file": name, "sha256": checksum(output / name),
        "sizeBytes": (output / name).stat().st_size, "signing": "unsigned",
        "cleanMachineAcceptance": "pending", "liveModelAcceptance": "pending",
        "buildRun": f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
        "evidence": {p.relative_to(output).as_posix(): checksum(p) for p in sorted(evidence.rglob("*")) if p.is_file()},
    }
    (output / "candidate.json").write_text(json.dumps(candidate, indent=2) + "\n", encoding="utf-8")


def stage_installer(root: Path, tag: str) -> None:
    _, _, pattern, _ = PLATFORMS[sys.platform]
    installers = list((root / "app/src-tauri/target/release/bundle").glob(pattern))
    if len(installers) != 1:
        raise ValueError("Expected exactly one installer; remove stale build output before building")
    output = root / "app/.build/release"
    temporary = Path(os.environ["RUNNER_TEMP"])
    if sys.platform == "darwin":
        with tempfile.TemporaryDirectory(prefix="practiq-release-dmg-") as directory:
            mount = Path(directory) / "mounted"
            subprocess.run(["hdiutil", "attach", str(installers[0]), "-readonly", "-nobrowse",
                            "-mountpoint", str(mount)], check=True)
            try:
                stage(root, tag, mount / "PractiQ.app/Contents/Resources/bundled", installers[0], output)
            finally:
                subprocess.run(["hdiutil", "detach", str(mount)], check=True)
    else:
        bundle = (temporary / "PractiQ/bundled" if sys.platform == "win32" else
                  temporary / "practiq-package/usr/lib/PractiQ/bundled")
        stage(root, tag, bundle, installers[0], output)


def assemble(root: Path, tag: str, inputs: Path, output: Path) -> None:
    components = versions(root, tag)
    sha = git(root, "rev-parse", "HEAD")
    candidates = [(path.parent, read_json(path)) for path in sorted(inputs.glob("release-*/candidate.json"))]
    if len(candidates) != 3 or {c["os"] for _, c in candidates} != {"macos", "windows", "linux"}:
        raise ValueError("All three gated platform candidates are required")
    for folder, candidate in candidates:
        if (candidate["tag"], candidate["commit"], candidate["components"]) != (tag, sha, components):
            raise ValueError("Mixed source commits or versions in release assets")
        os_name, arch, _, suffix = next(p for p in PLATFORMS.values() if p[0] == candidate["os"])
        if candidate["architecture"] != arch or candidate["file"] != f"PractiQ_{components['desktop']}_{os_name}_{arch}{suffix}":
            raise ValueError("Unexpected release asset name")
        asset = folder / candidate["file"]
        if checksum(asset) != candidate["sha256"] or asset.stat().st_size != candidate["sizeBytes"]:
            raise ValueError("Installer changed after package validation")
        for relative, digest in candidate["evidence"].items():
            path = folder / relative
            if not path.resolve().is_relative_to((folder / "evidence").resolve()) or checksum(path) != digest:
                raise ValueError("Invalid or altered release evidence")
        for filename in ("desktop-bundle.json", "office.json", "office-fidelity.json", "licenses.json"):
            if f"evidence/{filename}" not in candidate["evidence"] or read_json(folder / "evidence" / filename).get("passed") is not True:
                raise ValueError(f"Missing or failed release gate: {filename}")
        for filename in ("build-manifest.json", "THIRD-PARTY.txt", "PYTHON-LICENSE.txt"):
            if f"evidence/{filename}" not in candidate["evidence"]:
                raise ValueError(f"Missing component or notice evidence: {filename}")
        platform = next(key for key, value in PLATFORMS.items() if value[0] == os_name)
        check_build(read_json(folder / "evidence/build-manifest.json"), platform, components)
    service = inputs / "service-checks"
    service_files = [service / name for name in ("probes.json", "probes.md", "probes.xml", "coverage.xml")]
    if not all(path.is_file() for path in service_files):
        raise ValueError("Service verification evidence is incomplete")
    output.mkdir(parents=True, exist_ok=False)
    for folder, candidate in candidates:
        shutil.copyfile(folder / candidate["file"], output / candidate["file"])
    with zipfile.ZipFile(output / "release-evidence.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for folder, candidate in candidates:
            archive.write(folder / "candidate.json", f"{candidate['os']}/candidate.json")
            for relative in sorted(candidate["evidence"]):
                archive.write(folder / relative, f"{candidate['os']}/{relative}")
        for path in service_files:
            archive.write(path, f"service/{path.name}")
    manifest = {"tag": tag, "commit": sha, "components": components,
                "publicationStatus": "draft; signing and manual/live acceptance pending",
                "assets": [candidate for _, candidate in candidates],
                "evidenceSha256": checksum(output / "release-evidence.zip")}
    (output / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output / "SHA256SUMS.txt").write_text(
        "".join(f"{checksum(path)}  {path.name}\n" for path in sorted(output.iterdir()) if path.is_file()), encoding="utf-8")
    notes = (root / ".github/RELEASE_TEMPLATE.md").read_text(encoding="utf-8")
    for key, value in {"TAG": tag, "VERSION": components["desktop"], "COMMIT": sha,
                       "AI_VERSION": components["aiService"]}.items():
        notes = notes.replace(f"@{key}@", value)
    (output / "RELEASE_NOTES.md").write_text(notes, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "stage", "assemble"))
    parser.add_argument("--tag", required=True)
    parser.add_argument("--inputs", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "check":
        candidate = check_candidate(ROOT, args.tag)
        print(json.dumps(candidate, indent=2))
        if "GITHUB_OUTPUT" in os.environ:
            with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
                stream.write(f"sha={candidate['commit']}\nprerelease={str(candidate['prerelease']).lower()}\n")
    elif args.command == "stage":
        stage_installer(ROOT, args.tag)
    else:
        if args.inputs is None or args.output is None:
            parser.error("assemble requires --inputs and --output")
        assemble(ROOT, args.tag, args.inputs, args.output)


if __name__ == "__main__":
    main()
