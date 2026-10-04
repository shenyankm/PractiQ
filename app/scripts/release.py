"""Check a frozen desktop release and assemble draft assets using only stdlib."""

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from contextlib import contextmanager
from itertools import pairwise
from pathlib import Path, PureWindowsPath
from urllib.parse import urlsplit

import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from desktop_package import (
    PACKAGE_MODE,
    SCHEMA_VERSION,
    native_application,
    validate_manifest,
)

ROOT = Path(__file__).resolve().parents[2]
NUMBER = r"(?:0|[1-9][0-9]*)"
TAG = re.compile(rf"v({NUMBER}\.{NUMBER}\.{NUMBER}(?:-(?:alpha|beta|rc)\.{NUMBER})?)")
MACHINE_PATH = re.compile(r'''(?<![\w:/\\>])(?:(?P<quote>["'])(?:[A-Za-z]:[\\/]|\\\\|/)[^"']*(?P=quote)|(?:[A-Za-z]:[\\/][^\s"'<>|;]*|\\\\[^\\\s"'<>|;]+\\[^\s"'<>|;]*|//[^/\s"'<>|;]+/[^\s"'<>|;]*|/[^/\s"'<>|;]+/[^\s"'<>|;]*))''')
FILE_URI = re.compile(r'''(?<![\w:/\\>])(?:(?P<quote>["'])file:(?:[/\\]|[A-Za-z]:[\\/])[^"']*(?P=quote)|file:(?:[/\\]|[A-Za-z]:[\\/])[^\s"'<>|;]*)''', re.IGNORECASE)

PLATFORMS = {
    "darwin": ("macos", "arm64", "dmg/*.dmg", ".dmg"),
    "win32": ("windows", "x64", "nsis/*-setup.exe", "_setup.exe"),
    "linux": ("linux", "amd64", "deb/*.deb", ".deb"),
}
ACCEPTANCES = (("cleanMachine", "clean-machine"), ("liveModel", "live-model"))


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def original_json(raw: bytes) -> dict:
    """Reject ambiguous objects anywhere in exact original candidate bytes."""
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Original candidate JSON contains duplicate object keys")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=object_pairs)


def checksum(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def payload_fingerprint(payload: Path) -> dict:
    """Bind all extracted bytes, modes, types and links without following links."""
    if payload.is_symlink() or payload.is_junction() or not payload.is_dir():
        raise ValueError("Final installer payload requires a real directory")
    identity = {}
    for item in [payload, *sorted(payload.rglob("*"))]:
        mode = item.lstat().st_mode
        if item.is_junction():
            raise ValueError("Final installer payload cannot contain junctions")
        if stat.S_ISREG(mode):
            content = checksum(item)
        elif stat.S_ISLNK(mode):
            content = str(item.readlink())
        elif stat.S_ISDIR(mode):
            content = None
        else:
            raise ValueError("Final installer payload contains an unsupported file type")
        identity[item.relative_to(payload).as_posix()] = (mode, content)
    return identity


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
    return {"desktop": version, "aiServiceSource": service["project"]["version"]}


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
    validate_manifest(manifest, platform, components["desktop"])


def normalized_digest(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", value):
        raise ValueError("Expected a complete SHA-256 hexadecimal digest")
    return value.lower()


def check_original_candidate(candidate: dict) -> None:
    if "restagedFinalBytes" in candidate or candidate.get("signing") != "unsigned":
        raise ValueError("Build provenance requires the original unsigned CI candidate")

def external_signing_status(report: dict, artifact_sha: str) -> str:
    """Bind a declared outcome; this does not verify signatures or publisher identity."""
    if normalized_digest(report.get("artifactSha256")) != artifact_sha:
        raise ValueError("Signing report must identify the exact final installer SHA-256")
    status = report.get("status")
    if not isinstance(status, str) or status not in ("verified", "unsigned", "failed"):
        raise ValueError("External signing status must be verified, unsigned or failed")
    return "externally_reported_" + status


def acceptance_bytes(path: Path) -> bytes:
    with path.open("rb") as stream:
        raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("Acceptance report exceeds 1 MiB")
    return raw


def external_acceptance_status(report, kind: str, identity: dict) -> str:
    """Validate external evidence metadata without claiming to perform its checks."""
    required = {"schemaVersion", "kind", "artifactSha256", "tag", "commit", "components", "os",
                "architecture", "status", "reviewedBy", "verificationResults"}
    optional = {"verificationCommands", "limitations", "reviewedAt", "osVersion"}
    if (not isinstance(report, dict) or not required.issubset(report) or set(report) - required - optional or
            type(report["schemaVersion"]) is not int or report["schemaVersion"] != 1 or report["kind"] != kind):
        raise ValueError("Acceptance report has an invalid schema or kind")
    if (normalized_digest(report["artifactSha256"]) != identity["sha256"] or
            any(report[key] != identity[key] for key in ("tag", "commit", "components", "os", "architecture"))):
        raise ValueError("Acceptance report does not identify the final artifact, source and platform")
    for name in ("reviewedBy", "reviewedAt", "osVersion"):
        if name in report and (not isinstance(report[name], str) or not report[name].strip() or len(report[name]) > 8192):
            raise ValueError("Acceptance report requires bounded reviewer metadata")
    for name in ("verificationResults", "verificationCommands", "limitations"):
        if name in report:
            values = report[name]
            if (not isinstance(values, list) or len(values) > 128 or (name == "verificationResults" and not values) or
                    any(not isinstance(value, str) or not value.strip() or len(value) > 8192 for value in values)):
                raise ValueError("Acceptance report requires bounded verification results")
    if not isinstance(report["status"], str) or report["status"] not in ("passed", "failed"):
        raise ValueError("Acceptance status must be passed or failed")
    return "externally_reported_" + report["status"]


def public_report(value, roots):
    """Keep raw reports private; replace machine paths in the public JSON copy."""
    if isinstance(value, dict):
        keys = {key: public_report(key, roots) for key in value}
        reserved = set(keys.values())
        unchanged = {key for key, cleaned in keys.items() if key == cleaned}
        result = {}
        suffixes = {}
        for key, item in value.items():
            cleaned = keys[key]
            if cleaned in result or (key != cleaned and cleaned in unchanged):
                suffix = suffixes.get(cleaned, 2)
                while f"{cleaned}#{suffix}" in reserved or f"{cleaned}#{suffix}" in result:
                    suffix += 1
                suffixes[cleaned] = suffix + 1
                cleaned = f"{cleaned}#{suffix}"
            result[cleaned] = public_report(item, roots)
        return result
    if isinstance(value, list):
        return [public_report(item, roots) for item in value]
    if isinstance(value, str):
        value = FILE_URI.sub(lambda match: (match["quote"] or "") + "<local>" + (match["quote"] or ""), value)
        for directory, label in roots:
            value = value.replace(str(directory), label)
        if Path(value).is_absolute() or PureWindowsPath(value).is_absolute():
            return "<local>"
        value = MACHINE_PATH.sub(lambda match: (match["quote"] or "") + "<local>" + (match["quote"] or ""), value)
    return value


def original_build(root: Path, tag: str, source_sha: str, path: Path) -> tuple[dict, bytes]:
    """Bind downloaded original build assets/evidence; external provenance still needs review."""
    raw = path.read_bytes()
    candidate = original_json(raw)
    check_original_candidate(candidate)
    os_name, arch, _, suffix = PLATFORMS[sys.platform]
    components = versions(root, tag)
    if (candidate.get("packageSchemaVersion"), candidate.get("packageMode")) != (SCHEMA_VERSION, PACKAGE_MODE):
        raise ValueError("Original build must be a pure desktop-practice package")
    if (candidate.get("tag"), candidate.get("commit"), candidate.get("components"),
            candidate.get("os"), candidate.get("architecture")) != (tag, source_sha, components, os_name, arch):
        raise ValueError("Original build candidate does not match source, versions or platform")
    filename = f"PractiQ_{components['desktop']}_{os_name}_{arch}{suffix}"
    if candidate.get("file") != filename:
        raise ValueError("Original build candidate has an unexpected asset name")
    asset = path.parent / filename
    if asset.is_symlink() or asset.is_junction() or not asset.is_file():
        raise ValueError("Original build asset must be a regular non-link file")
    for directory in asset.parents:
        if directory.is_symlink() or directory.is_junction() or not directory.is_dir():
            raise ValueError("Original build asset requires real parent directories")
    if not asset.resolve(strict=True).is_relative_to(path.parent.resolve(strict=True)):
        raise ValueError("Original build asset must remain contained in its candidate directory")
    if checksum(asset) != normalized_digest(candidate.get("sha256")) or asset.stat().st_size != candidate.get("sizeBytes"):
        raise ValueError("Original build asset changed")
    run = urlsplit(candidate.get("buildRun") or "")
    if (run.scheme != "https" or not run.hostname or run.username or run.password or run.query or run.fragment
            or not re.fullmatch(r"/[^/]+/[^/]+/actions/runs/[1-9][0-9]*", run.path)):
        raise ValueError("Original build candidate must retain its immutable build-run URL")
    evidence = candidate.get("evidence", {})
    evidence_root = path.parent / "evidence"
    if not evidence_root.resolve().is_relative_to(path.parent.resolve()):
        raise ValueError("Original build evidence directory escaped the downloaded candidate")
    for relative, digest in evidence.items():
        item = path.parent / relative
        if not item.resolve().is_relative_to(evidence_root.resolve()) or checksum(item) != normalized_digest(digest):
            raise ValueError("Original build evidence changed or escaped its directory")
    for name in ("desktop-bundle.json", "licenses.json"):
        if "evidence/" + name not in evidence or read_json(path.parent / "evidence" / name).get("passed") is not True:
            raise ValueError("Original build gate evidence is incomplete")
    if "evidence/desktop-version.json" not in evidence or read_json(path.parent / "evidence/desktop-version.json") != {"passed": True, "platform": sys.platform, "version": components["desktop"]}:
        raise ValueError("Original build desktop version evidence is missing or inconsistent")
    if "evidence/build-manifest.json" not in evidence:
        raise ValueError("Original build manifest is missing")
    check_build(read_json(path.parent / "evidence/build-manifest.json"), sys.platform, components)
    return {"candidateSha256": hashlib.sha256(raw).hexdigest(), "candidate": candidate,
            "originalCandidate": "evidence/original-candidate.json",
            "verifiedCandidateSha256": hashlib.sha256(json.dumps(candidate, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            "assetAndEvidenceVerified": True,
            "provenanceReview": "Verify the original Actions download/source independently; local hashes do not attest its origin"}, raw


def stage(root: Path, tag: str, bundle: Path, installer: Path, output: Path, *,
          reports: Path | None = None, restaged: bool = False,
          source_sha: str | None = None, installer_sha: str | None = None,
          signing_report: Path | None = None, build_candidate: dict | None = None,
          desktop_version: str | None = None, clean_machine_report: Path | None = None,
          live_model_report: Path | None = None, original_candidate_bytes: bytes | None = None,
          payload: Path | None = None, payload_identity: dict | None = None) -> None:
    components = versions(root, tag)
    signing = "unverified" if restaged else "unsigned"
    os_name, arch, _, suffix = PLATFORMS[sys.platform]
    acceptance_paths = {"cleanMachine": clean_machine_report, "liveModel": live_model_report}
    acceptances = {field + "Acceptance": "pending" for field, _ in ACCEPTANCES}
    if not restaged and any(acceptance_paths.values()):
        raise ValueError("Acceptance reports require explicit final-byte staging")
    if (payload is None) != (payload_identity is None):
        raise ValueError("Final payload checks require an explicit directory and its pre-gate identity")
    manifest = read_json(bundle / "build-manifest.json")
    check_build(manifest, sys.platform, components)
    if restaged and (build_candidate is None or original_candidate_bytes is None or payload is None or
                     payload_identity is None or desktop_version != components["desktop"]):
        raise ValueError("Final desktop version and original build identity must be checked")
    if git(root, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("Release source changed during the build")
    fresh_reports = reports is not None
    reports = reports or root / "server/reports/checks/release"
    reports.mkdir(parents=True, exist_ok=not fresh_reports)
    roots = sorted([(bundle.resolve(), "<bundle>"), (root.resolve(), "<source>"),
                    (reports.resolve(), "<reports>"), (Path.home(), "<home>")], key=lambda item: len(str(item[0])), reverse=True)
    if restaged:
        assert build_candidate is not None and original_candidate_bytes is not None
        (reports / "original-candidate.json").write_bytes(original_candidate_bytes)
        original = original_json(original_candidate_bytes)
        if (original != build_candidate["candidate"] or
                hashlib.sha256(original_candidate_bytes).hexdigest() != normalized_digest(build_candidate["candidateSha256"])):
            raise ValueError("Original candidate bytes differ from the verified identity")
        if public_report(original, roots) != original:
            raise ValueError("Original candidate contains private paths; keep raw diagnostics private instead of publishing")
    if desktop_version is not None:
        (reports / "desktop-version.json").write_text(json.dumps({"passed": True, "platform": sys.platform, "version": desktop_version}) + "\n", encoding="utf-8")
    for script, filename, options in (
        ("check-bundle.py", "desktop-bundle.json", []),
        ("check_licenses.py", "licenses.json", ["--notices", str(reports / "expected-THIRD-PARTY.txt")]),
    ):
        subprocess.run([sys.executable, str(root / "app/scripts" / script), "--bundle", str(bundle),
                        "--output", str(reports / filename), *options], cwd=root, check=True)
        if read_json(reports / filename).get("passed") is not True:
            raise ValueError(f"Release gate did not pass: {filename}")
    if payload is not None and payload_fingerprint(payload) != payload_identity:
        raise ValueError("Final installer payload changed during package checks")
    if (reports / "expected-THIRD-PARTY.txt").read_bytes() != (bundle / "THIRD-PARTY.txt").read_bytes():
        raise ValueError("Final bundle third-party notices differ from candidate notices")
    (reports / "notices-match.json").write_text(json.dumps({"passed": True, "sha256": checksum(bundle / "THIRD-PARTY.txt")}) + "\n", encoding="utf-8")
    if source_sha is not None and (git(root, "rev-parse", "HEAD") != source_sha or git(root, "status", "--porcelain", "--untracked-files=all")):
        raise ValueError("Candidate source changed during final-package checks")
    if installer_sha is not None and checksum(installer) != installer_sha:
        raise ValueError("Final installer snapshot changed during package checks")
    if restaged:
        if signing_report:
            shutil.copyfile(signing_report, reports / "signing-report.json")
            signing = external_signing_status(read_json(reports / "signing-report.json"), installer_sha)
        identity = {"tag": tag, "commit": source_sha, "components": components, "os": os_name,
                    "architecture": arch, "sha256": installer_sha}
        for field, kind in ACCEPTANCES:
            if path := acceptance_paths[field]:
                raw = acceptance_bytes(path)
                acceptances[field + "Acceptance"] = external_acceptance_status(json.loads(raw), kind, identity)
                (reports / (kind + "-report.json")).write_bytes(raw)
        (reports / "build-candidate.json").write_text(json.dumps(build_candidate, indent=2) + "\n", encoding="utf-8")
    output.mkdir(parents=True, exist_ok=False)
    name = f"PractiQ_{components['desktop']}_{os_name}_{arch}{suffix}"
    shutil.copyfile(installer, output / name)
    if installer_sha is not None and checksum(output / name) != installer_sha:
        raise ValueError("Final installer changed while copying the public asset")
    evidence = output / "evidence"
    shutil.copytree(reports, evidence)
    for report in evidence.rglob("*.json"):
        if restaged and report.name == "original-candidate.json":
            if report.read_bytes() != original_candidate_bytes:
                raise ValueError("Original candidate bytes changed during evidence copy")
            continue
        report.write_text(json.dumps(public_report(read_json(report), roots), indent=2) + "\n", encoding="utf-8")
    for filename in ("build-manifest.json", "THIRD-PARTY.txt"):
        shutil.copyfile(bundle / filename, evidence / filename)
    if payload is not None and payload_fingerprint(payload) != payload_identity:
        raise ValueError("Final installer payload changed before final asset handoff")
    candidate = {
        "packageSchemaVersion": SCHEMA_VERSION, "packageMode": PACKAGE_MODE,
        "componentScope": "Desktop application; aiServiceSource is independent source version, not deployed in these assets",
        "tag": tag, "commit": git(root, "rev-parse", "HEAD"), "components": components,
        "os": os_name, "architecture": arch, "file": name, "sha256": checksum(output / name),
        "sizeBytes": (output / name).stat().st_size, "signing": signing,
        **acceptances,
        "buildRun": build_candidate["candidate"]["buildRun"] if restaged else f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
        "evidence": {p.relative_to(output).as_posix(): checksum(p) for p in sorted(evidence.rglob("*")) if p.is_file()},
    }
    if restaged:
        candidate["restagedFinalBytes"] = True
        candidate["originalBuildCandidate"] = "evidence/build-candidate.json"
        candidate["buildSourceIdentity"] = "Independent build provenance review required; commit identifies the checker candidate checkout"
        candidate["signingVerification"] = "Not performed by restaging; inspect independent final-artifact signing evidence"
        candidate["acceptanceVerification"] = "Not performed by restaging; independently review external acceptance reports"
        if signing_report:
            candidate["signingReport"] = "evidence/signing-report.json"
        for field, kind in ACCEPTANCES:
            if acceptance_paths[field]:
                candidate[field + "Report"] = "evidence/" + kind + "-report.json"
    (output / "candidate.json").write_text(json.dumps(candidate, indent=2) + "\n", encoding="utf-8")


def stage_installer(root: Path, tag: str) -> None:
    _, _, pattern, _ = PLATFORMS[sys.platform]
    installers = list((root / "app/src-tauri/target/release/bundle").glob(pattern))
    if len(installers) != 1:
        raise ValueError("Expected exactly one installer; remove stale build output before building")
    output = root / "app/.build/release"
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"Asset directory already exists: {output}")
    source_sha = git(root, "rev-parse", "HEAD")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="practiq-ci-assets-", dir=output.parent) as directory:
        staged = Path(directory) / "assets"
        with (installer_snapshot(installers[0]) as (snapshot, installer_sha),
              final_bundle(snapshot, root=root) as bundle):
            payload = bundle.parents[2] if sys.platform == "darwin" else bundle.parent if sys.platform == "win32" else bundle.parents[3]
            identity = payload_fingerprint(payload)
            version = check_desktop_version(snapshot, bundle, versions(root, tag)["desktop"], "PractiQ")
            stage(root, tag, bundle, snapshot, staged, desktop_version=version,
                  source_sha=source_sha, installer_sha=installer_sha, payload=payload, payload_identity=identity)
            if payload_fingerprint(payload) != identity:
                raise ValueError("Final installer payload changed before final asset handoff")
        if git(root, "rev-parse", "HEAD") != source_sha or git(root, "status", "--porcelain", "--untracked-files=all"):
            raise ValueError("Candidate source changed before final asset handoff")
        if output.exists() or output.is_symlink():
            raise FileExistsError(f"Asset directory already exists: {output}")
        staged.rename(output)


@contextmanager
def installer_snapshot(installer: Path):
    """Inspect and deliver the same private read-only bytes even if the input path changes."""
    original_sha = checksum(installer)
    with tempfile.TemporaryDirectory(prefix="practiq-installer-snapshot-") as directory:
        snapshot = Path(directory) / installer.name
        shutil.copyfile(installer, snapshot)
        if checksum(snapshot) != original_sha or checksum(installer) != original_sha:
            raise ValueError("Final installer changed while creating its snapshot")
        snapshot.chmod(snapshot.stat().st_mode & ~0o222)
        yield snapshot, original_sha
        if checksum(snapshot) != original_sha:
            raise ValueError("Final installer snapshot changed after package checks")


def contained_bundle(payload: Path, bundle: Path) -> Path:
    """The bundle and its parent directories must belong to this extracted or mounted payload."""
    if not bundle.resolve().is_relative_to(payload.resolve()):
        raise ValueError("Final bundle escapes the selected installer payload")
    for part in (bundle, *bundle.parents):
        if part == payload.parent:
            break
        if part.is_symlink() or part.is_junction() or not part.is_dir():
            raise ValueError("Final bundle payload requires real contained directories")
        if part == payload:
            break
    for item in bundle.rglob("*"):
        if item.is_junction() or (item.is_symlink() and
                (item.readlink().is_absolute() or not item.exists() or
                 not item.resolve().is_relative_to(bundle.resolve()))):
            raise ValueError("Final bundle links must identify relative bytes inside this payload")
    return bundle


def deb_package_name(root: Path) -> str:
    """Match Tauri's heck::AsKebabCase product name for ASCII release names."""
    config = read_json(root / "app/src-tauri/tauri.conf.json")
    config.update(read_json(root / "app/src-tauri/tauri.linux.conf.json"))
    product = config.get("productName")
    if product is None:
        product = tomllib.loads((root / "app/src-tauri/Cargo.toml").read_text(encoding="utf-8"))["package"]["name"]
    if not isinstance(product, str) or not product.isascii():
        raise ValueError("DEB package identity requires an ASCII candidate product name")
    words = []
    for word in re.findall(r"[A-Za-z0-9]+", product):
        # heck retains digit runs in the current case mode when finding boundaries.
        word = re.sub(r"([A-Z][0-9]*)([A-Z][a-z])", r"\1-\2", word)
        words.append(re.sub(r"([a-z][0-9]*)([A-Z])", r"\1-\2", word).lower())
    package = "-".join(words)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]+", package):
        raise ValueError("DEB package identity requires a valid candidate package name")
    return package



def check_deb_metadata(installer: Path, root: Path) -> None:
    package = subprocess.check_output(["dpkg-deb", "-f", str(installer), "Package"], text=True).strip()
    if package != deb_package_name(root):
        raise ValueError("Final DEB package identity does not match the candidate product name")
    architecture = subprocess.check_output(["dpkg-deb", "-f", str(installer), "Architecture"], text=True).strip()
    if architecture != "amd64":
        raise ValueError("Final DEB architecture must be amd64")
    configured = read_json(root / "app/src-tauri/tauri.linux.conf.json")["bundle"]["linux"]["deb"]["depends"]
    required = {"libwebkit2gtk-4.1-0", "libgtk-3-0", *configured}
    dependencies = subprocess.check_output(["dpkg-deb", "-f", str(installer), "Depends"], text=True).strip()
    mandatory = set()
    for clause in dependencies.split(","):
        # An alternative does not guarantee that this required runtime will be installed.
        if "|" in clause:
            continue
        match = re.fullmatch(r"\s*([a-z0-9][a-z0-9+.-]*)(?::(?:any|amd64))?(?:\s*\([^()]+\))?\s*", clause)
        if match:
            mandatory.add(match[1])
    if not required.issubset(mandatory):
        raise ValueError("Final DEB dependencies omit required desktop runtime libraries")


@contextmanager
def final_bundle(installer: Path, seven_zip: Path | None = None, application_name: str = "PractiQ", *, root: Path = ROOT):
    """Derive resources from the selected snapshot, never an unrelated installation."""
    with tempfile.TemporaryDirectory(prefix="practiq-final-package-") as directory:
        temporary = Path(directory)
        if sys.platform == "darwin":
            mount = temporary / "mounted"
            subprocess.run(["hdiutil", "attach", str(installer), "-readonly", "-nobrowse", "-mountpoint", str(mount)], check=True)
            try:
                yield contained_bundle(mount, mount / "PractiQ.app/Contents/Resources/bundled")
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
            check_deb_metadata(installer, root)
            extracted = temporary / "extracted"
            subprocess.run(["dpkg-deb", "-x", str(installer), str(extracted)], check=True)
            yield contained_bundle(extracted, extracted / "usr/lib/PractiQ/bundled")


def check_windows_architecture(executable: Path) -> None:
    """Inspect bounded PE headers; do not execute or infer architecture from a label."""
    size = executable.stat().st_size
    with executable.open("rb") as stream:
        dos = stream.read(64)
        if len(dos) != 64 or dos[:2] != b"MZ":
            raise ValueError("Final Windows desktop executable requires a valid PE header")
        offset = int.from_bytes(dos[60:64], "little")
        if not 64 <= offset <= size - 26:
            raise ValueError("Final Windows PE header is outside the executable")
        stream.seek(offset)
        header = stream.read(26)
        optional_size = int.from_bytes(header[20:22], "little")
        if header[:4] != b"PE\0\0" or optional_size < 2 or offset + 24 + optional_size > size:
            raise ValueError("Final Windows desktop executable requires complete PE headers")
        if int.from_bytes(header[4:6], "little") != 0x8664 or int.from_bytes(header[24:26], "little") != 0x20B:
            raise ValueError("Final Windows desktop executable must be x64 PE32+")
        characteristics = int.from_bytes(header[22:24], "little")
        if not characteristics & 0x0002 or characteristics & 0x2000:
            raise ValueError("Final Windows PE must be an executable application, not a DLL")

def macho_architecture(stream, offset: int, size: int) -> tuple[int, int]:
    stream.seek(offset)
    header = stream.read(min(size, 32))
    formats = {b"\xcf\xfa\xed\xfe": ("little", 32), b"\xfe\xed\xfa\xcf": ("big", 32),
               b"\xce\xfa\xed\xfe": ("little", 28), b"\xfe\xed\xfa\xce": ("big", 28)}
    if header[:4] not in formats:
        raise ValueError("Final macOS executable requires a Mach-O header")
    order, header_size = formats[header[:4]]
    if len(header) < header_size:
        raise ValueError("Final macOS Mach-O header is truncated")
    cpu, subtype, filetype, count, commands_size = [int.from_bytes(header[n:n + 4], order) for n in range(4, 24, 4)]
    if (filetype != 2 or bool(cpu & 0x1000000) != (header_size == 32) or
            commands_size > size - header_size or count * 8 > commands_size or
            commands_size % (8 if header_size == 32 else 4) or (cpu == 0x100000C and order != "little")):
        raise ValueError("Final macOS Mach-O executable has invalid or unbounded headers")
    return cpu, subtype

def check_macos_architecture(executable: Path) -> None:
    """Require a real arm64 member, not merely a universal container's CPU label."""
    size = executable.stat().st_size
    with executable.open("rb") as stream:
        header = stream.read(8)
        formats = {b"\xca\xfe\xba\xbe": ("big", 20), b"\xbe\xba\xfe\xca": ("little", 20),
                   b"\xca\xfe\xba\xbf": ("big", 32), b"\xbf\xba\xfe\xca": ("little", 32)}
        if header[:4] not in formats:
            architectures = {macho_architecture(stream, 0, size)}
        else:
            order, width = formats[header[:4]]
            count = int.from_bytes(header[4:8], order)
            table_end = 8 + count * width
            # Universal binaries have few members; bound work even for hostile counts.
            if len(header) != 8 or not 1 <= count <= 64 or table_end > size:
                raise ValueError("Final macOS Mach-O universal table is invalid or truncated")
            table = stream.read(count * width)
            if len(table) != count * width:
                raise ValueError("Final macOS Mach-O universal table is truncated")
            architectures, ranges = set(), []
            for index in range(count):
                entry = table[index * width:(index + 1) * width]
                cpu, subtype = int.from_bytes(entry[:4], order), int.from_bytes(entry[4:8], order)
                field = 8 if width == 32 else 4
                offset, length = int.from_bytes(entry[8:8 + field], order), int.from_bytes(entry[8 + field:8 + field * 2], order)
                alignment = int.from_bytes(entry[8 + field * 2:12 + field * 2], order)
                if ((cpu, subtype) in architectures or offset < table_end or length < 28 or offset + length > size or
                        alignment > 63 or offset % (1 << alignment) or (width == 32 and int.from_bytes(entry[28:32], order))):
                    raise ValueError("Final macOS Mach-O universal members are duplicated or out of bounds")
                if macho_architecture(stream, offset, length) != (cpu, subtype):
                    raise ValueError("Final macOS Mach-O member differs from its universal CPU label")
                architectures.add((cpu, subtype))
                ranges.append((offset, offset + length))
            ranges.sort()
            if any(current[0] < prior[1] for prior, current in pairwise(ranges)):
                raise ValueError("Final macOS Mach-O universal members overlap")
        if not any(cpu == 0x100000C for cpu, _ in architectures):
            raise ValueError("Final macOS Mach-O executable requires an arm64 slice")

def check_linux_architecture(executable: Path) -> None:
    """Check the native ELF identity independently of the DEB control metadata."""
    with executable.open("rb") as stream:
        header = stream.read(64)
    if (len(header) != 64 or header[:7] != b"\x7fELF\x02\x01\x01" or
            int.from_bytes(header[16:18], "little") not in (2, 3) or
            int.from_bytes(header[18:20], "little") != 62 or
            int.from_bytes(header[20:24], "little") != 1 or int.from_bytes(header[52:54], "little") != 64):
        raise ValueError("Final Linux executable must be a complete ELF64 little-endian x86-64 executable or PIE")
    size = executable.stat().st_size
    for start, width, count in ((32, 54, 56), (40, 58, 60)):
        offset, entry_size, entries = (int.from_bytes(header[start:start + 8], "little"),
                                       int.from_bytes(header[width:width + 2], "little"),
                                       int.from_bytes(header[count:count + 2], "little"))
        expected = 56 if start == 32 else 64
        if (start == 32 and not entries) or (entries and (entry_size != expected or offset < 64 or offset + entry_size * entries > size)):
            raise ValueError("Final Linux ELF tables are missing or outside the executable")


def check_desktop_version(installer: Path, bundle: Path, expected: str, application_name: str) -> str:
    application = native_application(bundle, application_name)
    if sys.platform != "win32" and not application.stat().st_mode & 0o111:
        raise ValueError("Final desktop executable requires POSIX execute permission")
    if sys.platform == "darwin":
        check_macos_architecture(application)
        info = bundle.parents[1] / "Info.plist"
        actual = plistlib.loads(info.read_bytes()).get("CFBundleShortVersionString")
    elif sys.platform == "win32":
        check_windows_architecture(application)
        for executable in (installer, application):
            environment = os.environ | {"PRACTIQ_RELEASE_VERSION_FILE": str(executable)}
            actual = subprocess.check_output(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference = 'Stop'; [Diagnostics.FileVersionInfo]::GetVersionInfo($env:PRACTIQ_RELEASE_VERSION_FILE).ProductVersion"],
                env=environment, text=True).strip()
            if actual != expected:
                raise ValueError("Final installer desktop version does not match the candidate")
    else:
        check_linux_architecture(application)
        actual = subprocess.check_output(["dpkg-deb", "-f", str(installer), "Version"], text=True).strip()
    if actual != expected:
        raise ValueError("Final installer desktop version does not match the candidate")
    return actual


def restage_installer(root: Path, tag: str, installer: Path, output: Path,
                      reports: Path, signing_report: Path | None = None,
                      build_candidate: Path | None = None, seven_zip: Path | None = None, *,
                      clean_machine_report: Path | None = None, live_model_report: Path | None = None) -> None:
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
    provenance, original_candidate_bytes = original_build(root, tag, candidate["commit"], build_candidate)
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
            with final_bundle(snapshot, seven_zip, application_name, root=root) as bundle:
                payload = bundle.parents[2] if sys.platform == "darwin" else bundle.parent if sys.platform == "win32" else bundle.parents[3]
                payload_identity = payload_fingerprint(payload)
                desktop_version = check_desktop_version(snapshot, bundle, versions(root, tag)["desktop"], application_name)
                stage(root, tag, bundle, snapshot, staged, reports=reports, restaged=True,
                      source_sha=candidate["commit"], installer_sha=original_sha, signing_report=signing_report,
                      build_candidate=provenance, desktop_version=desktop_version,
                      clean_machine_report=clean_machine_report, live_model_report=live_model_report,
                      original_candidate_bytes=original_candidate_bytes, payload=payload, payload_identity=payload_identity)
                if payload_fingerprint(payload) != payload_identity:
                    raise ValueError("Final installer payload changed before final asset handoff")
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
    candidates = []
    candidate_digests = {}
    for path in sorted(inputs.glob("release-*/candidate.json")):
        raw = path.read_bytes()
        candidates.append((path.parent, json.loads(raw)))
        candidate_digests[path.parent] = hashlib.sha256(raw).hexdigest()
    if len(candidates) != 3 or {c["os"] for _, c in candidates} != {"macos", "windows", "linux"}:
        raise ValueError("All three gated platform candidates are required")
    if len({bool(candidate.get("restagedFinalBytes")) for _, candidate in candidates}) != 1:
        raise ValueError("Mixed original CI and final-byte staging modes in release assets")
    for folder, candidate in candidates:
        if (candidate.get("packageSchemaVersion"), candidate.get("packageMode")) != (SCHEMA_VERSION, PACKAGE_MODE):
            raise ValueError("Release assets must use pure desktop-practice package schema 2")
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
        for filename in ("desktop-bundle.json", "licenses.json"):
            if f"evidence/{filename}" not in candidate["evidence"] or read_json(folder / "evidence" / filename).get("passed") is not True:
                raise ValueError(f"Missing or failed release gate: {filename}")
        for filename in ("build-manifest.json", "THIRD-PARTY.txt"):
            if f"evidence/{filename}" not in candidate["evidence"]:
                raise ValueError(f"Missing component or notice evidence: {filename}")
        for field, kind in ACCEPTANCES:
            expected = "pending"
            if field + "Report" in candidate:
                relative = "evidence/" + kind + "-report.json"
                if (not candidate.get("restagedFinalBytes") or candidate[field + "Report"] != relative or
                        relative not in candidate["evidence"]):
                    raise ValueError("Acceptance evidence must use its bound final-candidate report path")
                path = folder / relative
                if (path.is_symlink() or path.is_junction() or not path.is_file() or
                        path.parent.is_symlink() or path.parent.is_junction() or
                        not path.resolve(strict=True).is_relative_to(folder.resolve(strict=True))):
                    raise ValueError("Acceptance report must remain inside its final candidate directory")
                expected = external_acceptance_status(json.loads(acceptance_bytes(path)), kind, candidate)
            if candidate.get(field + "Acceptance", "pending") != expected:
                raise ValueError("Final acceptance status differs from its bound external report")
        comparison = read_json(folder / "evidence/notices-match.json") if "evidence/notices-match.json" in candidate["evidence"] else {}
        if (comparison.get("passed") is not True or
                comparison.get("sha256") != checksum(folder / "evidence/THIRD-PARTY.txt") or
                "evidence/expected-THIRD-PARTY.txt" not in candidate["evidence"] or
                (folder / "evidence/expected-THIRD-PARTY.txt").read_bytes() != (folder / "evidence/THIRD-PARTY.txt").read_bytes()):
            raise ValueError("Missing final embedded-notice comparison")
        if candidate.get("restagedFinalBytes"):
            report = candidate.get("signingReport")
            signing = "unverified"
            if report:
                if report != "evidence/signing-report.json" or report not in candidate["evidence"]:
                    raise ValueError("Signing evidence must identify the final asset SHA-256")
                signing = external_signing_status(read_json(folder / report), candidate["sha256"])
            if candidate.get("signing") != signing:
                raise ValueError("Final signing status differs from its bound external report")
            original = candidate.get("originalBuildCandidate")
            if original != "evidence/build-candidate.json" or original not in candidate["evidence"]:
                raise ValueError("Missing original build identity")
            build = read_json(folder / original)
            prior = build.get("candidate", {})
            check_original_candidate(prior)
            raw_relative = "evidence/original-candidate.json"
            raw_path = folder / raw_relative
            if (build.get("originalCandidate") != raw_relative or raw_relative not in candidate["evidence"] or
                    raw_path.is_symlink() or raw_path.is_junction() or not raw_path.is_file() or
                    raw_path.parent.is_symlink() or raw_path.parent.is_junction() or
                    not raw_path.resolve(strict=True).is_relative_to(folder.resolve(strict=True))):
                raise ValueError("Original candidate bytes must remain bound inside the final evidence directory")
            raw = raw_path.read_bytes()
            if (hashlib.sha256(raw).hexdigest() != normalized_digest(build.get("candidateSha256")) or original_json(raw) != prior or
                    public_report(prior, [(folder.resolve(), "<candidate>"), (Path.home(), "<home>")]) != prior):
                raise ValueError("Original candidate bytes differ from the archived build identity or contain private paths")
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
    expected_archive = {f"service/{path.name}": checksum(path) for path in service_files}
    for folder, candidate in candidates:
        expected_archive[f"{candidate['os']}/candidate.json"] = candidate_digests[folder]
        expected_archive.update({f"{candidate['os']}/{relative}": digest for relative, digest in candidate["evidence"].items()})
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"Asset directory already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="practiq-assembled-assets-", dir=output.parent) as directory:
        staged = Path(directory) / "assets"
        staged.mkdir()
        for folder, candidate in candidates:
            shutil.copyfile(folder / candidate["file"], staged / candidate["file"])
        with zipfile.ZipFile(staged / "release-evidence.zip", "w", zipfile.ZIP_DEFLATED) as archive:
            for folder, candidate in candidates:
                archive.write(folder / "candidate.json", f"{candidate['os']}/candidate.json")
                for relative in sorted(candidate["evidence"]):
                    archive.write(folder / relative, f"{candidate['os']}/{relative}")
            for path in service_files:
                archive.write(path, f"service/{path.name}")
        for _, candidate in candidates:
            asset = staged / candidate["file"]
            if checksum(asset) != candidate["sha256"] or asset.stat().st_size != candidate["sizeBytes"]:
                raise ValueError("Installer identity changed during assembly handoff")
        with zipfile.ZipFile(staged / "release-evidence.zip") as archive:
            if len(archive.namelist()) != len(expected_archive) or set(archive.namelist()) != set(expected_archive):
                raise ValueError("Evidence archive identity changed during assembly handoff")
            for name, digest in expected_archive.items():
                with archive.open(name) as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                        raise ValueError("Evidence identity changed during assembly handoff")
            for _, candidate in candidates:
                if json.loads(archive.read(f"{candidate['os']}/candidate.json")) != candidate:
                    raise ValueError("Candidate identity changed during assembly handoff")
        manifest = {"packageSchemaVersion": SCHEMA_VERSION, "packageMode": PACKAGE_MODE,
                    "componentScope": "Desktop assets; aiServiceSource is source-only and not a deployed component",
                    "tag": tag, "commit": sha, "components": components,
                    "publicationStatus": "draft; independent signing and acceptance review pending" if candidates[0][1].get("restagedFinalBytes") else "draft; signing and manual/live acceptance pending",
                    "assets": [candidate for _, candidate in candidates],
                    "evidenceSha256": checksum(staged / "release-evidence.zip")}
        (staged / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        (staged / "SHA256SUMS.txt").write_text(
            "".join(f"{checksum(path)}  {path.name}\n" for path in sorted(staged.iterdir()) if path.is_file()), encoding="utf-8")
        notes = (root / ".github/RELEASE_TEMPLATE.md").read_text(encoding="utf-8")
        for key, value in {"TAG": tag, "VERSION": components["desktop"], "COMMIT": sha,
                           "AI_VERSION": components["aiServiceSource"]}.items():
            notes = notes.replace(f"@{key}@", value)
        (staged / "RELEASE_NOTES.md").write_text(notes, encoding="utf-8")
        if git(root, "rev-parse", "HEAD") != sha:
            raise ValueError("Candidate source changed before assembly handoff")
        if output.exists() or output.is_symlink():
            raise FileExistsError(f"Asset directory already exists: {output}")
        staged.rename(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "stage", "assemble"))
    parser.add_argument("--tag", required=True)
    parser.add_argument("--inputs", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--installer", type=Path, help="Explicit final native installer; stage with fresh --reports and --output")
    parser.add_argument("--reports", type=Path, help="Fresh directory retaining final-package gate reports, including failures")
    parser.add_argument("--signing-report", type=Path, help="Independent signing report bound by artifactSha256; stage does not verify signing")
    parser.add_argument("--clean-machine-report", type=Path, help="Reviewed clean-machine acceptance metadata bound to final bytes; no acceptance is executed")
    parser.add_argument("--live-model-report", type=Path, help="Reviewed live-model acceptance metadata bound to final bytes; no model is called")
    parser.add_argument("--build-candidate", type=Path, help="Original CI candidate.json with its installer and bound evidence in the same directory")
    parser.add_argument("--seven-zip", type=Path, help="Installed full 7z.exe for Windows NSIS payload extraction")
    args = parser.parse_args()
    explicit = any(value is not None for value in (args.installer, args.reports, args.signing_report, args.build_candidate, args.seven_zip, args.clean_machine_report, args.live_model_report))
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
            restage_installer(ROOT, args.tag, args.installer, args.output, args.reports, args.signing_report, args.build_candidate, args.seven_zip,
                              clean_machine_report=args.clean_machine_report, live_model_report=args.live_model_report)
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
