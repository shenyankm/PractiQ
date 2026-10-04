"""Bind Android notices to the actual resolved runtime and reviewed source bytes."""

import hashlib
import io
import json
import re
import tomllib
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile


def checked_file(path: Path, digest: str) -> bytes:
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Invalid Android notice SHA-256")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError(f"Android runtime or notice bytes changed: {path.name}")
    return raw


def notice_path(root: Path, relative: str) -> Path:
    directory = (root / "app/licenses").resolve()
    path = directory / relative
    if not path.resolve().is_relative_to(directory):
        raise ValueError("Android notice source escapes the repository notice directory")
    return path


def jar_entries(raw: bytes) -> dict[str, str]:
    with ZipFile(io.BytesIO(raw)) as archive:
        entries = {}
        for item in archive.infolist():
            if item.is_dir():
                continue
            if item.filename in entries:
                raise ValueError("Android runtime or source JAR has duplicate entries")
            entries[item.filename] = hashlib.sha256(archive.read(item)).hexdigest()
        return entries


def check_runtime_artifact(artifact: dict) -> None:
    if not all(key in artifact for key in ("runtimeArtifact", "runtimeArtifactSha256", "runtimeArtifactIdentity")):
        raise ValueError("Android inventory requires the actual selected runtime artifact")
    raw = checked_file(Path(artifact["artifact"]), artifact["artifactSha256"])
    runtime = checked_file(Path(artifact["runtimeArtifact"]), artifact["runtimeArtifactSha256"])
    if artifact["extension"] == "aar":
        original = {}
        with ZipFile(io.BytesIO(raw)) as archive:
            for item in archive.infolist():
                if item.filename == "classes.jar" or (item.filename.startswith("libs/") and item.filename.endswith(".jar")):
                    for name, digest in jar_entries(archive.read(item)).items():
                        values = original.setdefault(name, set())
                        if name.endswith(".class") and values and digest not in values:
                            raise ValueError("Android source AAR has conflicting class entries")
                        values.add(digest)
    else:
        original = {name: {digest} for name, digest in jar_entries(raw).items()}
    # AGP can remove non-code metadata while constructing its runtime JAR.
    # Every retained entry must still come from this exact selected source.
    if any(digest not in original.get(name, set()) for name, digest in jar_entries(runtime).items()):
        raise ValueError("Android selected runtime entries differ from their source artifact")


def check_project_overrides(root: Path, artifact: dict, package: dict, specs: list[dict],
                            cargo_notices: list[dict] | None) -> None:
    actual = artifact.get("sourceOverrides", [])
    if not isinstance(actual, list) or len(actual) != len(specs):
        raise ValueError("Android local source overrides differ from the reviewed lock")
    project = Path(artifact["projectDirectory"]).resolve()
    for spec, selected in zip(specs, actual, strict=True):
        original = project / spec["originalFile"]
        replacement = root / spec["replacementFile"]
        compiled = root / spec["compiledFile"]
        if (not original.resolve().is_relative_to(project)
                or not replacement.resolve().is_relative_to(root.resolve())
                or not compiled.resolve().is_relative_to((root / "app/src-tauri/gen/android/build").resolve())
                or Path(selected["originalFile"]).resolve() != original.resolve()
                or Path(selected["replacementFile"]).resolve() != replacement.resolve()
                or Path(selected["compiledReplacementFile"]).resolve() != compiled.resolve()
                or selected.get("originalCompiled") is not False or selected.get("replacementCompiled") is not True):
            raise ValueError("Android source override is outside its actual compiler inputs")
        before = checked_file(original, spec["originalSha256"])
        after = checked_file(replacement, spec["replacementSha256"])
        checked_file(compiled, spec["replacementSha256"])
        if (selected["originalSha256"] != spec["originalSha256"]
                or selected["replacementSha256"] != spec["replacementSha256"]
                or selected["compiledReplacementSha256"] != spec["replacementSha256"]):
            raise ValueError("Android source override hashes differ from the reviewed lock")
        proof = json.loads(checked_file(notice_path(root, spec["provenanceFile"]), spec["provenanceSha256"]))
        crates = tomllib.loads((root / "app/src-tauri/Cargo.lock").read_text(encoding="utf-8"))["package"]
        matching = [item for item in crates if item["name"] == package["name"] and item["version"] == package["version"]]
        if (len(matching) != 1 or matching[0].get("checksum") != proof["crate"]["sha256"]
                or (proof["package"], proof["version"]) != (package["name"], package["version"])
                or (Path(package["manifest_path"]).parent / proof["originalSource"]["path"]).resolve() != original.resolve()
                or proof["originalSource"]["sha256"] != spec["originalSha256"]
                or proof["replacement"]["path"] != spec["replacementFile"]
                or proof["replacement"]["sha256"] != spec["replacementSha256"]):
            raise ValueError("Android source override provenance differs from locked Cargo source")
        change = proof["replacement"]["change"]
        old, new = change["before"].encode(), change["after"].encode()
        expected = before.replace(old, new, 1)
        if notice := proof["replacement"].get("modificationNotice"):
            anchor, text = notice["after"].encode(), notice["text"].encode()
            if expected.count(anchor) != 1:
                raise ValueError("Android source override modification notice has an invalid position")
            expected = expected.replace(anchor, anchor + text, 1)
        if before.count(old) != 1 or expected != after:
            raise ValueError("Android source override differs from its reviewed one-line change")
        if cargo_notices is not None:
            notices = [row for row in cargo_notices if row["ecosystem"] == "cargo"
                       and (row["name"], row["version"]) == (package["name"], package["version"])]
            if len(notices) != 1:
                raise ValueError("Android source override requires its original Cargo license notices")
            notices[0]["supplementalSources"].append({"source": proof["originalSource"]["source"],
                "verification": "Reviewed lifecycle source modification; complete original Cargo licenses and copyright retained. Actual Kotlin inputs exclude the upstream file and include the byte-identical generated replacement.",
                "evidence": {"file": spec["provenanceFile"], "sha256": spec["provenanceSha256"]}})


def runtime_notices(root: Path, inventory_path: Path | None, architecture: str, cargo_packages: list[dict],
                    *, raw_inventory: bytes | None = None, cargo_notices: list[dict] | None = None) -> list[dict]:
    if inventory_path is None:
        raise ValueError("Android package requires the resolved Gradle runtime inventory")
    inventory = json.loads(inventory_path.read_bytes() if raw_inventory is None else raw_inventory)
    configurations = {"arm64": {"arm64DebugRuntimeClasspath", "universalDebugRuntimeClasspath"},
                      "x86_64": {"x86_64DebugRuntimeClasspath"}}[architecture]
    if inventory.get("schemaVersion") != 1 or inventory.get("configuration") not in configurations:
        raise ValueError("Android runtime configuration does not match the APK architecture")
    lock = json.loads((root / "app/licenses/android-runtime.lock.json").read_text(encoding="utf-8"))
    expected = {row["coordinate"]: row for row in lock["artifacts"]}
    if lock.get("schemaVersion") != 1 or len(expected) != len(lock["artifacts"]):
        raise ValueError("Invalid Android runtime notice lock")
    overrides = lock.get("projectOverrides", {})
    if not isinstance(overrides, dict) or set(overrides) - {"tauri-android", "tauri-plugin-dialog"}:
        raise ValueError("Unknown Android local source override project")
    gradle_lock = (root / "app/src-tauri/gen/android/app/gradle.lockfile").read_text(encoding="utf-8")
    locked = {line.split("=", 1)[0] for line in gradle_lock.splitlines()
              if "=" in line and inventory["configuration"] in line.split("=", 1)[1].split(",")}
    if not set(expected).issubset(locked):
        raise ValueError("Android runtime versions differ from the Gradle dependency lock")
    rows, seen, projects = [], set(), set()
    for artifact in inventory["artifacts"]:
        check_runtime_artifact(artifact)
        if artifact["project"]:
            name = artifact["name"]
            cargo_name, relative = {"tauri-android": ("tauri", "mobile/android"),
                                    "tauri-plugin-dialog": ("tauri-plugin-dialog", "android")}.get(name, (None, None))
            matches = [item for item in cargo_packages if item["name"] == cargo_name]
            if name in projects or len(matches) != 1 or Path(artifact["projectDirectory"]).resolve() != (
                    Path(matches[0]["manifest_path"]).parent / relative).resolve():
                raise ValueError("Android local project does not match its locked Cargo source")
            projects.add(name)
            check_project_overrides(root, artifact, matches[0], overrides.get(name, []), cargo_notices)
            continue  # Its full license texts are included by the Cargo inventory.
        coordinate = f'{artifact["group"]}:{artifact["name"]}:{artifact["version"]}'
        if coordinate in seen or coordinate not in expected or artifact.get("classifier"):
            raise ValueError("Android runtime closure differs from the reviewed notice lock")
        seen.add(coordinate)
        pinned = expected[coordinate]
        expected_name = pinned.get("artifactFileName", f'{artifact["name"]}-{artifact["version"]}.{artifact["extension"]}')
        identity = artifact["runtimeArtifactIdentity"].split(" -> ", 1)[0].split(" (", 1)[0]
        if (identity != expected_name or not isinstance(pinned.get("artifactIdentity"), str)
                or not pinned["artifactIdentity"] or artifact.get("artifactIdentity") != pinned["artifactIdentity"]):
            raise ValueError("Android selected runtime extension or classifier differs from its reviewed artifact")
        if artifact["artifactSha256"] != pinned["artifactSha256"] or artifact["extension"] != pinned["extension"]:
            raise ValueError("Android runtime artifact differs from its reviewed source")
        pom = checked_file(Path(artifact["pom"]), pinned["pomSha256"])
        if artifact["pomSha256"] != pinned["pomSha256"]:
            raise ValueError("Android runtime POM differs from its reviewed source")
        tree = ElementTree.fromstring(pom)
        namespace = {"m": "http://maven.apache.org/POM/4.0.0"}
        fields = [tree.findtext(f"m:{field}", namespaces=namespace) for field in ("groupId", "artifactId", "version")]
        parent = tree.find("m:parent", namespace)
        declarations = {item.findtext("m:url", namespaces=namespace) for item in tree.findall("m:licenses/m:license", namespace)}
        for proof in pinned.get("parentPoms", []):
            if parent is None:
                raise ValueError("Android POM has an unexpected parent license proof")
            parent_tree = ElementTree.fromstring(checked_file(notice_path(root, proof["file"]), proof["sha256"]))
            parent_id = [parent.findtext(f"m:{field}", namespaces=namespace) for field in ("groupId", "artifactId", "version")]
            actual_id = [parent_tree.findtext(f"m:{field}", namespaces=namespace) for field in ("groupId", "artifactId", "version")]
            if parent_id != actual_id:
                raise ValueError("Android POM parent license proof has a different identity")
            fields = [fields[0] or parent_id[0], fields[1], fields[2] or parent_id[2]]
            if not declarations:
                declarations = {item.findtext("m:url", namespaces=namespace) for item in parent_tree.findall("m:licenses/m:license", namespace)}
            parent = parent_tree.find("m:parent", namespace)
        if fields != [artifact["group"], artifact["name"], artifact["version"]]:
            raise ValueError("Android POM identity differs from its artifact")
        if not pinned["texts"] or any(text.get("declarationUrl") not in declarations for text in pinned["texts"]
                                      if "artifactEntry" not in text and "sourceReference" not in text):
            raise ValueError("Android full license texts are not bound to its POM declaration")
        texts, sources = [], []
        for item in pinned["texts"]:
            path = notice_path(root, item["file"])
            checked_file(path, item["sha256"])
            reference = item.get("sourceReference")
            entry = item.get("artifactEntry")
            if "artifactEntry" in item and (not isinstance(entry, str) or not entry):
                raise ValueError("Invalid Android embedded notice entry reference")
            verification = f'Full text bound to exact runtime POM SHA-256 {pinned["pomSha256"]}'
            if "sourceReference" in item:
                if (not isinstance(reference, dict) or not all(isinstance(reference.get(key), str) for key in ("artifactEntry", "sha256", "url"))
                        or "artifactEntry" in item or "declarationUrl" in item or item["source"] != reference["url"]
                        or not re.fullmatch(r"https://github\.com/[^/]+/[^/]+/blob/[0-9a-f]{40}/[^?#]+", reference["url"])
                        or not re.fullmatch(r"[0-9a-f]{64}", reference["sha256"])):
                    raise ValueError("Android supplemental license source reference is not fixed and unambiguous")
                entry = reference["artifactEntry"]
            if entry is not None:
                parts = entry.split("!")
                if len(parts) > 2 or not all(parts):
                    raise ValueError("Invalid Android embedded notice entry reference")
                with ZipFile(artifact["artifact"]) as archive:
                    embedded = archive.read(parts[0])
                    if len(parts) == 2:
                        with ZipFile(io.BytesIO(embedded)) as nested:
                            embedded = nested.read(parts[1])
                expected_sha = reference["sha256"] if reference is not None else item["sha256"]
                if hashlib.sha256(embedded).hexdigest() != expected_sha:
                    raise ValueError("Android embedded license text differs from its exact runtime artifact")
                if reference is not None:
                    if reference["url"] not in embedded.decode("utf-8").splitlines():
                        raise ValueError("Android supplemental source is not referenced by its exact embedded notice")
                    verification = f'Supplemental full text referenced by exact embedded notice {entry} SHA-256 {expected_sha} from runtime artifact SHA-256 {pinned["artifactSha256"]}'
                else:
                    verification = f'Full text bound to exact embedded artifact entry {entry} SHA-256 {expected_sha} from runtime artifact SHA-256 {pinned["artifactSha256"]}'
            texts.append({"path": str(path), "sha256": item["sha256"]})
            sources.append({"source": item["source"], "verification": verification})
        rows.append({"ecosystem": "maven", "name": f'{artifact["group"]}:{artifact["name"]}',
                     "version": artifact["version"], "declaration": pinned["declaration"],
                     "source": pinned["pomSource"], "artifactSha256": pinned["artifactSha256"],
                     "pomSha256": pinned["pomSha256"], "supplementalSources": sources,
                     "texts": texts})
    if seen != set(expected) or projects != {"tauri-android", "tauri-plugin-dialog"}:
        raise ValueError("Android runtime closure differs from the reviewed notice lock")
    return sorted(rows, key=lambda row: row["name"])
