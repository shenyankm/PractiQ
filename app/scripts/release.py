"""Check a frozen desktop release and assemble draft assets using only stdlib."""

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from contextlib import contextmanager
from pathlib import Path, PureWindowsPath
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
NUMBER = r"(?:0|[1-9][0-9]*)"
TAG = re.compile(rf"v({NUMBER}\.{NUMBER}\.{NUMBER}(?:-(?:alpha|beta|rc)\.{NUMBER})?)")
MACHINE_PATH = re.compile(r'''(?<![\w:/\\>])(?:(?P<quote>["'])(?:[A-Za-z]:[\\/]|\\\\|/)[^"']*(?P=quote)|(?:[A-Za-z]:[\\/][^\s"'<>|;]*|\\\\[^\\\s"'<>|;]+\\[^\s"'<>|;]*|//[^/\s"'<>|;]+/[^\s"'<>|;]*|/[^/\s"'<>|;]+/[^\s"'<>|;]*))''')
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


def normalized_digest(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", value):
        raise ValueError("Expected a complete SHA-256 hexadecimal digest")
    return value.lower()


def public_report(value, roots):
    """Keep raw reports private; replace machine paths in the public JSON copy."""
    if isinstance(value, dict):
        return {key: public_report(item, roots) for key, item in value.items()}
    if isinstance(value, list):
        return [public_report(item, roots) for item in value]
    if isinstance(value, str):
        for directory, label in roots:
            value = value.replace(str(directory), label)
        if Path(value).is_absolute() or PureWindowsPath(value).is_absolute():
            return "<local>"
        value = MACHINE_PATH.sub(lambda match: (match["quote"] or "") + "<local>" + (match["quote"] or ""), value)
    return value


def original_build(root: Path, tag: str, source_sha: str, path: Path) -> dict:
    """Bind downloaded original build assets/evidence; external provenance still needs review."""
    raw = path.read_bytes()
    candidate = json.loads(raw)
    os_name, arch, _, suffix = PLATFORMS[sys.platform]
    components = versions(root, tag)
    if (candidate.get("tag"), candidate.get("commit"), candidate.get("components"),
            candidate.get("os"), candidate.get("architecture")) != (tag, source_sha, components, os_name, arch):
        raise ValueError("Original build candidate does not match source, versions or platform")
    filename = f"PractiQ_{components['desktop']}_{os_name}_{arch}{suffix}"
    if candidate.get("file") != filename:
        raise ValueError("Original build candidate has an unexpected asset name")
    asset = path.parent / filename
    if checksum(asset) != normalized_digest(candidate.get("sha256")) or asset.stat().st_size != candidate.get("sizeBytes"):
        raise ValueError("Original build asset changed")
    run = urlsplit(candidate.get("buildRun") or "")
    if (run.scheme != "https" or not run.hostname or run.username or run.password or run.query or run.fragment
            or not re.fullmatch(r"/[^/]+/[^/]+/actions/runs/[1-9][0-9]*", run.path)):
        raise ValueError("Original build candidate must retain its immutable build-run URL")
    evidence = candidate.get("evidence", {})
    for relative, digest in evidence.items():
        item = path.parent / relative
        if not item.resolve().is_relative_to((path.parent / "evidence").resolve()) or checksum(item) != normalized_digest(digest):
            raise ValueError("Original build evidence changed or escaped its directory")
    for name in ("desktop-bundle.json", "office.json", "office-fidelity.json", "licenses.json"):
        if "evidence/" + name not in evidence or read_json(path.parent / "evidence" / name).get("passed") is not True:
            raise ValueError("Original build gate evidence is incomplete")
    if "evidence/build-manifest.json" not in evidence:
        raise ValueError("Original build manifest is missing")
    check_build(read_json(path.parent / "evidence/build-manifest.json"), sys.platform, components)
    return {"candidateSha256": hashlib.sha256(raw).hexdigest(), "candidate": candidate,
            "verifiedCandidateSha256": hashlib.sha256(json.dumps(candidate, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            "assetAndEvidenceVerified": True,
            "provenanceReview": "Verify the original Actions download/source independently; local hashes do not attest its origin"}


def stage(root: Path, tag: str, bundle: Path, installer: Path, output: Path, *,
          reports: Path | None = None, restaged: bool = False,
          source_sha: str | None = None, installer_sha: str | None = None,
          signing_report: Path | None = None, build_candidate: dict | None = None,
          desktop_version: str | None = None) -> None:
    components = versions(root, tag)
    os_name, arch, _, suffix = PLATFORMS[sys.platform]
    manifest = read_json(bundle / "build-manifest.json")
    check_build(manifest, sys.platform, components)
    if restaged and (build_candidate is None or desktop_version != components["desktop"]):
        raise ValueError("Final desktop version and original build identity must be checked")
    if git(root, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("Release source changed during the build")
    fresh_reports = reports is not None
    reports = reports or root / "server/reports/checks/release"
    reports.mkdir(parents=True, exist_ok=not fresh_reports)
    if restaged:
        (reports / "desktop-version.json").write_text(json.dumps({"passed": True, "platform": sys.platform, "version": desktop_version}) + "\n", encoding="utf-8")
    for script, filename, options in (
        ("check-bundle.py", "desktop-bundle.json", []),
        ("check-office.py", "office.json", ["--isolated"]),
        ("check-office.py", "office-fidelity.json", ["--fidelity-only"]),
        ("check_licenses.py", "licenses.json", ["--notices", str(reports / "expected-THIRD-PARTY.txt")] if restaged else []),
    ):
        subprocess.run([sys.executable, str(root / "app/scripts" / script), "--bundle", str(bundle),
                        "--output", str(reports / filename), *options], cwd=root, check=True)
        if read_json(reports / filename).get("passed") is not True:
            raise ValueError(f"Release gate did not pass: {filename}")
    if restaged:
        if (reports / "expected-THIRD-PARTY.txt").read_bytes() != (bundle / "THIRD-PARTY.txt").read_bytes():
            raise ValueError("Final bundle third-party notices differ from candidate notices")
        (reports / "notices-match.json").write_text(json.dumps({"passed": True, "sha256": checksum(bundle / "THIRD-PARTY.txt")}) + "\n", encoding="utf-8")
        if git(root, "rev-parse", "HEAD") != source_sha or git(root, "status", "--porcelain", "--untracked-files=all"):
            raise ValueError("Candidate source changed during final-package checks")
        if checksum(installer) != installer_sha:
            raise ValueError("Final installer snapshot changed during package checks")
        if signing_report:
            shutil.copyfile(signing_report, reports / "signing-report.json")
            if normalized_digest(read_json(reports / "signing-report.json").get("artifactSha256")) != installer_sha:
                raise ValueError("Signing report must identify the exact final installer SHA-256")
        (reports / "build-candidate.json").write_text(json.dumps(build_candidate, indent=2) + "\n", encoding="utf-8")
    output.mkdir(parents=True, exist_ok=False)
    name = f"PractiQ_{components['desktop']}_{os_name}_{arch}{suffix}"
    shutil.copyfile(installer, output / name)
    if restaged and checksum(output / name) != installer_sha:
        raise ValueError("Final installer changed while copying the public asset")
    evidence = output / "evidence"
    shutil.copytree(reports, evidence)
    roots = sorted([(bundle.resolve(), "<bundle>"), (root.resolve(), "<source>"),
                    (reports.resolve(), "<reports>"), (Path.home(), "<home>")], key=lambda item: len(str(item[0])), reverse=True)
    for report in evidence.rglob("*.json"):
        report.write_text(json.dumps(public_report(read_json(report), roots), indent=2) + "\n", encoding="utf-8")
    for filename in ("build-manifest.json", "THIRD-PARTY.txt", "PYTHON-LICENSE.txt"):
        shutil.copyfile(bundle / filename, evidence / filename)
    candidate = {
        "tag": tag, "commit": git(root, "rev-parse", "HEAD"), "components": components,
        "os": os_name, "architecture": arch, "file": name, "sha256": checksum(output / name),
        "sizeBytes": (output / name).stat().st_size, "signing": "unverified" if restaged else "unsigned",
        "cleanMachineAcceptance": "pending", "liveModelAcceptance": "pending",
        "buildRun": build_candidate["candidate"]["buildRun"] if restaged else f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
        "evidence": {p.relative_to(output).as_posix(): checksum(p) for p in sorted(evidence.rglob("*")) if p.is_file()},
    }
    if restaged:
        candidate["restagedFinalBytes"] = True
        candidate["originalBuildCandidate"] = "evidence/build-candidate.json"
        candidate["buildSourceIdentity"] = "Independent build provenance review required; commit identifies the checker candidate checkout"
        candidate["signingVerification"] = "Not performed by restaging; inspect independent final-artifact signing evidence"
        if signing_report:
            candidate["signingReport"] = "evidence/signing-report.json"
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


@contextmanager
def final_bundle(installer: Path, seven_zip: Path | None = None, application_name: str = "PractiQ"):
    """Derive resources from the selected snapshot, never an unrelated installation."""
    with tempfile.TemporaryDirectory(prefix="practiq-final-package-") as directory:
        temporary = Path(directory)
        if sys.platform == "darwin":
            mount = temporary / "mounted"
            subprocess.run(["hdiutil", "attach", str(installer), "-readonly", "-nobrowse", "-mountpoint", str(mount)], check=True)
            try:
                yield mount / "PractiQ.app/Contents/Resources/bundled"
            finally:
                subprocess.run(["hdiutil", "detach", str(mount)], check=True)
        elif sys.platform == "win32":
            destination = temporary / "PractiQ"
            extractor = str(seven_zip) if seven_zip else shutil.which("7z")
            if not extractor or (seven_zip and not seven_zip.is_file()):
                raise ValueError("Install full 7-Zip or provide --seven-zip; NSIS payload extraction must not run the installer")
            listing = subprocess.check_output([extractor, "l", "-slt", "-ba", "-sccUTF-8", "-tNsis", "--", str(installer)], text=True, encoding="utf-8")
            entries = []
            for block in listing.split("\n\n"):
                paths = [line[7:] for line in block.splitlines() if line.startswith("Path = ")]
                if not paths:
                    continue
                if len(paths) != 1:
                    raise ValueError("Ambiguous path in NSIS payload listing")
                relative = PureWindowsPath(paths[0])
                if not str(relative) or relative.root or relative.drive or ".." in relative.parts or ":" in str(relative):
                    raise ValueError("Unsafe path in NSIS payload")
                entries.append(relative)
            if not {PureWindowsPath(application_name + ".exe"), PureWindowsPath("bundled/build-manifest.json")}.issubset(entries):
                raise ValueError("NSIS payload is missing the desktop application or bundled manifest")
            subprocess.run([extractor, "x", "-tNsis", "-y", "-sccUTF-8", f"-o{destination}", "--", str(installer)], check=True)
            for item in destination.rglob("*"):
                if item.is_symlink() or item.is_junction() or not item.resolve().is_relative_to(destination.resolve()):
                    raise ValueError("NSIS extraction escaped its temporary directory")
            yield destination / "bundled"
        else:
            extracted = temporary / "extracted"
            subprocess.run(["dpkg-deb", "-x", str(installer), str(extracted)], check=True)
            yield extracted / "usr/lib/PractiQ/bundled"


def check_desktop_version(installer: Path, bundle: Path, expected: str, application_name: str) -> str:
    if sys.platform == "darwin":
        actual = plistlib.loads((bundle.parents[1] / "Info.plist").read_bytes()).get("CFBundleShortVersionString")
    elif sys.platform == "win32":
        application = bundle.parent / (application_name + ".exe")
        if not application.is_file():
            raise ValueError("Desktop executable is missing from the extracted NSIS payload")
        for executable in (installer, application):
            environment = os.environ | {"PRACTIQ_RELEASE_VERSION_FILE": str(executable)}
            actual = subprocess.check_output(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference = 'Stop'; [Diagnostics.FileVersionInfo]::GetVersionInfo($env:PRACTIQ_RELEASE_VERSION_FILE).ProductVersion"],
                env=environment, text=True).strip()
            if actual != expected:
                raise ValueError("Final installer desktop version does not match the candidate")
    else:
        actual = subprocess.check_output(["dpkg-deb", "-f", str(installer), "Version"], text=True).strip()
    if actual != expected:
        raise ValueError("Final installer desktop version does not match the candidate")
    return actual


def restage_installer(root: Path, tag: str, installer: Path, output: Path,
                      reports: Path, signing_report: Path | None = None,
                      build_candidate: Path | None = None, seven_zip: Path | None = None) -> None:
    """Recheck final bytes locally while keeping signing/manual/live verification separate."""
    candidate = check_candidate(root, tag)
    for path in (output, reports):
        if path.exists() or path.is_symlink():
            raise FileExistsError(f"Choose a fresh output directory: {path}")
    if (output.resolve().is_relative_to(reports.resolve()) or
            reports.resolve().is_relative_to(output.resolve())):
        raise ValueError("Asset and report directories must be separate")
    suffix = ".exe" if sys.platform == "win32" else PLATFORMS[sys.platform][3]
    if installer.suffix.lower() != suffix:
        raise ValueError("Final installer does not match the native platform")
    if build_candidate is None:
        raise ValueError("Explicit final staging requires --build-candidate and its original asset/evidence")
    provenance = original_build(root, tag, candidate["commit"], build_candidate)
    cargo = tomllib.loads((root / "app/src-tauri/Cargo.toml").read_text(encoding="utf-8"))
    config = read_json(root / "app/src-tauri/tauri.conf.json")
    application_name = config.get("mainBinaryName") or cargo.get("bin", [{"name": cargo["package"]["name"]}])[0]["name"]
    original_sha = checksum(installer)
    with tempfile.TemporaryDirectory(prefix="practiq-final-installer-") as directory:
        snapshot = Path(directory) / installer.name
        shutil.copyfile(installer, snapshot)
        if checksum(snapshot) != original_sha or checksum(installer) != original_sha:
            raise ValueError("Final installer changed while creating its snapshot")
        snapshot.chmod(snapshot.stat().st_mode & ~0o222)
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="practiq-final-assets-", dir=output.parent) as staging:
            staged = Path(staging) / "assets"
            with final_bundle(snapshot, seven_zip, application_name) as bundle:
                desktop_version = check_desktop_version(snapshot, bundle, versions(root, tag)["desktop"], application_name)
                stage(root, tag, bundle, snapshot, staged, reports=reports, restaged=True,
                      source_sha=candidate["commit"], installer_sha=original_sha, signing_report=signing_report,
                      build_candidate=provenance, desktop_version=desktop_version)
            if checksum(snapshot) != original_sha:
                raise ValueError("Final installer snapshot changed after package checks")
            if git(root, "rev-parse", "HEAD") != candidate["commit"] or git(root, "status", "--porcelain", "--untracked-files=all"):
                raise ValueError("Candidate source changed before final asset handoff")
            if output.exists() or output.is_symlink():
                raise FileExistsError(f"Final asset directory already exists: {output}")
            staged.rename(output)


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
        if candidate.get("restagedFinalBytes"):
            comparison = read_json(folder / "evidence/notices-match.json") if "evidence/notices-match.json" in candidate["evidence"] else {}
            if (comparison.get("passed") is not True or
                    comparison.get("sha256") != checksum(folder / "evidence/THIRD-PARTY.txt") or
                    "evidence/expected-THIRD-PARTY.txt" not in candidate["evidence"] or
                    (folder / "evidence/expected-THIRD-PARTY.txt").read_bytes() != (folder / "evidence/THIRD-PARTY.txt").read_bytes()):
                raise ValueError("Missing final embedded-notice comparison")
            report = candidate.get("signingReport")
            if report and (report != "evidence/signing-report.json" or report not in candidate["evidence"] or normalized_digest(read_json(folder / report).get("artifactSha256")) != candidate["sha256"]):
                raise ValueError("Signing evidence must identify the final asset SHA-256")
            original = candidate.get("originalBuildCandidate")
            if original != "evidence/build-candidate.json" or original not in candidate["evidence"]:
                raise ValueError("Missing original build identity")
            build = read_json(folder / original)
            prior = build.get("candidate", {})
            normalized_digest(build.get("candidateSha256"))
            if (build.get("assetAndEvidenceVerified") is not True or
                    normalized_digest(build.get("verifiedCandidateSha256")) != hashlib.sha256(json.dumps(prior, sort_keys=True, separators=(",", ":")).encode()).hexdigest() or
                    any(prior.get(key) != candidate[key] for key in ("tag", "commit", "components", "os", "architecture", "buildRun"))):
                raise ValueError("Original build identity differs from the final candidate")
            desktop = read_json(folder / "evidence/desktop-version.json") if "evidence/desktop-version.json" in candidate["evidence"] else {}
            if desktop.get("passed") is not True or desktop.get("version") != components["desktop"]:
                raise ValueError("Missing final desktop version evidence")
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
    parser.add_argument("--installer", type=Path, help="Explicit final native installer; stage with fresh --reports and --output")
    parser.add_argument("--reports", type=Path, help="Fresh directory retaining final-package gate reports, including failures")
    parser.add_argument("--signing-report", type=Path, help="Independent signing report bound by artifactSha256; stage does not verify signing")
    parser.add_argument("--build-candidate", type=Path, help="Original CI candidate.json with its installer and bound evidence in the same directory")
    parser.add_argument("--seven-zip", type=Path, help="Installed full 7z.exe for Windows NSIS payload extraction")
    args = parser.parse_args()
    explicit = any(value is not None for value in (args.installer, args.reports, args.signing_report, args.build_candidate, args.seven_zip))
    if explicit and (args.command != "stage" or args.installer is None or args.reports is None or args.output is None or args.build_candidate is None):
        parser.error("Explicit final staging requires stage --installer --reports --output --build-candidate")
    if args.command == "check":
        candidate = check_candidate(ROOT, args.tag)
        print(json.dumps(candidate, indent=2))
        if "GITHUB_OUTPUT" in os.environ:
            with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
                stream.write(f"sha={candidate['commit']}\nprerelease={str(candidate['prerelease']).lower()}\n")
    elif args.command == "stage":
        if explicit:
            restage_installer(ROOT, args.tag, args.installer, args.output, args.reports, args.signing_report, args.build_candidate, args.seven_zip)
        else:
            if args.output is not None:
                parser.error("stage --output also requires --installer and --reports")
            stage_installer(ROOT, args.tag)
    else:
        if args.inputs is None or args.output is None:
            parser.error("assemble requires --inputs and --output")
        assemble(ROOT, args.tag, args.inputs, args.output)


if __name__ == "__main__":
    main()
