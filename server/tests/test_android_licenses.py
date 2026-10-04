"""Actual Android runtime artifacts, POMs, license texts and source locks agree."""

import hashlib
import io
import json
import runpy
from pathlib import Path
from zipfile import ZipFile

import pytest

ROOT = Path(__file__).parents[2]


@pytest.fixture
def notice_runtime(tmp_path):
    scope = runpy.run_path(str(ROOT / "app/scripts/android_licenses.py"))
    licenses = tmp_path / "app/licenses"
    licenses.mkdir(parents=True)
    text = licenses / "terms.txt"
    text.write_text("Synthetic complete terms")
    artifact = tmp_path / "runtime.aar"
    runtime_jar = tmp_path / "runtime.jar"
    with ZipFile(runtime_jar, "w") as archive:
        archive.writestr("example/Runtime.class", b"Synthetic actual class bytes")
    with ZipFile(artifact, "w") as archive:
        archive.writestr("classes.jar", runtime_jar.read_bytes())
    pom = tmp_path / "runtime.pom"
    pom.write_text('<project xmlns="http://maven.apache.org/POM/4.0.0"><groupId>example</groupId>'
                   '<artifactId>runtime</artifactId><version>1.0</version><licenses><license>'
                   '<name>Synthetic terms</name><url>https://example.test/terms</url></license></licenses></project>')
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    pinned = {"coordinate": "example:runtime:1.0", "extension": "aar", "artifactSha256": digest(artifact),
              "pomSha256": digest(pom), "pomSource": "https://example.test/runtime/1.0/runtime-1.0.pom",
              "artifactFileName": "runtime-1.0.aar", "artifactIdentity": "runtime-1.0.aar (example:runtime:1.0)",
              "declaration": "Synthetic terms", "texts": [{"file": "terms.txt", "sha256": digest(text),
                  "source": "https://example.test/full-terms", "declarationUrl": "https://example.test/terms"}]}
    (licenses / "android-runtime.lock.json").write_text(json.dumps({"schemaVersion": 1, "artifacts": [pinned]}))
    gradle_lock = tmp_path / "app/src-tauri/gen/android/app/gradle.lockfile"
    gradle_lock.parent.mkdir(parents=True)
    gradle_lock.write_text("example:runtime:1.0=arm64DebugRuntimeClasspath,x86_64DebugRuntimeClasspath\n")
    rows = [{"group": "example", "name": "runtime", "version": "1.0", "classifier": None,
             "extension": "aar", "project": False, "artifact": str(artifact), "artifactSha256": digest(artifact),
             "pom": str(pom), "pomSha256": digest(pom), "artifactIdentity": pinned["artifactIdentity"],
             "runtimeArtifact": str(runtime_jar), "runtimeArtifactSha256": digest(runtime_jar),
             "runtimeArtifactIdentity": "runtime-1.0.aar -> runtime.jar (example:runtime:1.0)"}]
    cargo = []
    for name, crate, relative in (("tauri-android", "tauri", "mobile/android"),
                                   ("tauri-plugin-dialog", "tauri-plugin-dialog", "android")):
        directory = tmp_path / crate
        source = directory / relative
        source.mkdir(parents=True)
        built = source / "project.aar"
        with ZipFile(built, "w") as archive:
            archive.writestr("classes.jar", runtime_jar.read_bytes())
        cargo.append({"name": crate, "manifest_path": str(directory / "Cargo.toml")})
        rows.append({"name": name, "project": True, "artifact": str(built), "artifactSha256": digest(built),
                     "projectDirectory": str(source), "extension": "aar", "runtimeArtifact": str(runtime_jar),
                     "runtimeArtifactSha256": digest(runtime_jar), "runtimeArtifactIdentity": f"classes.jar (project :{name})"})
    report = tmp_path / "runtime.json"
    report.write_text(json.dumps({"schemaVersion": 1, "configuration": "arm64DebugRuntimeClasspath", "artifacts": rows}))
    return scope["runtime_notices"], tmp_path, report, cargo, rows, pinned


@pytest.fixture
def patched_runtime(notice_runtime):
    validate, root, report, cargo, rows, pinned = notice_runtime
    original = Path(rows[1]["projectDirectory"]) / "src/main/java/app/tauri/plugin/PluginManager.kt"
    original.parent.mkdir(parents=True)
    original.write_text("Synthetic upstream header\n// SPDX-License-Identifier: MIT\nif (::activity.isInitialized) {\n  return\n}\n")
    replacement = root / "app/src-tauri/gen/android/patches/tauri-2.11.5/app/tauri/plugin/LifecyclePluginManager.kt"
    replacement.parent.mkdir(parents=True)
    before, after = "if (::activity.isInitialized) {", "if (::activity.isInitialized && this.activity === activity) {"
    notice = {"after": "// SPDX-License-Identifier: MIT\n", "text": "// PractiQ: synthetic changed-file notice.\n"}
    changed = original.read_bytes().replace(before.encode(), after.encode())
    replacement.write_bytes(changed.replace(notice["after"].encode(), (notice["after"] + notice["text"]).encode()))
    original_sha = hashlib.sha256(original.read_bytes()).hexdigest()
    replacement_sha = hashlib.sha256(replacement.read_bytes()).hexdigest()
    cargo[0]["version"] = "2.11.5"
    proof = {"package": "tauri", "version": "2.11.5", "crate": {"sha256": "a" * 64},
             "originalSource": {"path": "mobile/android/" + str(original.relative_to(Path(rows[1]["projectDirectory"]))), "sha256": original_sha,
                                "source": "https://example.test/pinned/PluginManager.kt"},
             "replacement": {"path": str(replacement.relative_to(root)), "sha256": replacement_sha,
                             "change": {"before": before, "after": after}, "modificationNotice": notice}}
    compiled = root / "app/src-tauri/gen/android/build/generated/tauri-lifecycle-sources/app/tauri/plugin/LifecyclePluginManager.kt"
    compiled.parent.mkdir(parents=True)
    compiled.write_bytes(replacement.read_bytes())
    evidence = root / "app/licenses/tauri-android-lifecycle.provenance.json"
    evidence.write_text(json.dumps(proof))
    (root / "app/src-tauri/Cargo.lock").write_text('[[package]]\nname="tauri"\nversion="2.11.5"\nchecksum="' + "a" * 64 + '"\n')
    spec = {"originalFile": str(original.relative_to(Path(rows[1]["projectDirectory"]))), "originalSha256": original_sha,
            "replacementFile": str(replacement.relative_to(root)), "replacementSha256": replacement_sha,
            "compiledFile": str(compiled.relative_to(root)), "provenanceFile": str(evidence.relative_to(root / "app/licenses")), "provenanceSha256": hashlib.sha256(evidence.read_bytes()).hexdigest()}
    rows[1]["sourceOverrides"] = [{"originalFile": str(original), "originalSha256": original_sha,
                                 "replacementFile": str(replacement), "replacementSha256": replacement_sha,
                                 "originalCompiled": False, "replacementCompiled": True,
                                 "compiledReplacementFile": str(compiled), "compiledReplacementSha256": replacement_sha}]
    lock = {"schemaVersion": 1, "artifacts": [pinned], "projectOverrides": {"tauri-android": [spec]}}
    (root / "app/licenses/android-runtime.lock.json").write_text(json.dumps(lock))
    data = json.loads(report.read_text()); data["artifacts"] = rows; report.write_text(json.dumps(data))
    return validate, root, report, cargo, rows, spec, proof


@pytest.mark.parametrize("damage", [None, "original", "replacement", "missing", "extra", "compiled_original",
                                   "uncompiled_replacement", "replacement_escape", "original_escape", "proof", "crate",
                                   "compiled_copy", "notice_removed", "extra_source_change"])
def test_android_local_source_patch_requires_exact_upstream_replacement_and_actual_compiler_inputs(patched_runtime, damage):
    validate, root, report, cargo, rows, spec, proof = patched_runtime
    if damage in {"original", "replacement"}:
        Path(rows[1]["sourceOverrides"][0][damage + "File"]).write_text("Unreviewed source bytes")
    elif damage == "missing":
        rows[1].pop("sourceOverrides")
    elif damage == "extra":
        rows[1]["sourceOverrides"].append(rows[1]["sourceOverrides"][0])
    elif damage == "compiled_original":
        rows[1]["sourceOverrides"][0]["originalCompiled"] = True
    elif damage == "uncompiled_replacement":
        rows[1]["sourceOverrides"][0]["replacementCompiled"] = False
    elif damage in {"replacement_escape", "original_escape"}:
        spec[damage.split("_", 1)[0] + "File"] = "../outside.kt"
    elif damage == "proof":
        (root / "app/licenses/tauri-android-lifecycle.provenance.json").write_text("Changed proof")
    elif damage == "crate":
        (root / "app/src-tauri/Cargo.lock").write_text('[[package]]\nname="tauri"\nversion="2.11.5"\nchecksum="' + "b" * 64 + '"\n')
    elif damage == "compiled_copy":
        Path(rows[1]["sourceOverrides"][0]["compiledReplacementFile"]).write_text("Unreviewed compiled source copy")
    elif damage in {"notice_removed", "extra_source_change"}:
        source = Path(rows[1]["sourceOverrides"][0]["replacementFile"])
        changed = source.read_bytes().replace(proof["replacement"]["modificationNotice"]["text"].encode(), b"") if damage == "notice_removed" else source.read_bytes() + b"// Unreviewed extra source change\n"
        source.write_bytes(changed)
        Path(rows[1]["sourceOverrides"][0]["compiledReplacementFile"]).write_bytes(changed)
        digest = hashlib.sha256(changed).hexdigest()
        spec["replacementSha256"] = proof["replacement"]["sha256"] = digest
        rows[1]["sourceOverrides"][0].update(replacementSha256=digest, compiledReplacementSha256=digest)
        evidence = root / "app/licenses/tauri-android-lifecycle.provenance.json"
        evidence.write_text(json.dumps(proof))
        spec["provenanceSha256"] = hashlib.sha256(evidence.read_bytes()).hexdigest()
    data = json.loads(report.read_text()); data["artifacts"] = rows; report.write_text(json.dumps(data))
    lock = json.loads((root / "app/licenses/android-runtime.lock.json").read_text())
    lock["projectOverrides"]["tauri-android"] = [spec]
    (root / "app/licenses/android-runtime.lock.json").write_text(json.dumps(lock))
    if damage is None:
        notices = [{"ecosystem": "cargo", "name": "tauri", "version": "2.11.5", "supplementalSources": []}]
        assert validate(root, report, "arm64", cargo, cargo_notices=notices)
        assert notices[0]["supplementalSources"][0]["evidence"]["sha256"] == spec["provenanceSha256"]
    else:
        with pytest.raises(ValueError, match="override|source|provenance|Cargo|runtime|notice"):
            validate(root, report, "arm64", cargo)


def test_android_notices_bind_the_actual_maven_runtime_and_local_cargo_sources(notice_runtime):
    validate, root, report, cargo, _, _ = notice_runtime
    rows = validate(root, report, "arm64", cargo)
    assert len(rows) == 1 and rows[0]["ecosystem"] == "maven"
    assert rows[0]["texts"] and "exact runtime POM SHA-256" in rows[0]["supplementalSources"][0]["verification"]


def test_fastdoubleparser_complete_mit_terms_are_bound_to_its_embedded_pinned_notice():
    lock = json.loads((ROOT / "app/licenses/android-runtime.lock.json").read_text())
    pinned = next(row for row in lock["artifacts"] if row["coordinate"] == "com.fasterxml.jackson.core:jackson-core:2.15.3")
    terms = next(item for item in pinned["texts"] if item.get("sourceReference"))
    assert terms["sha256"] == "5f7260e2124be5a560d2c5ec1824475f76bb02dcb352b7f4848a1d702948007c"
    raw = (ROOT / "app/licenses" / terms["file"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == terms["sha256"]
    assert b"Copyright (c) 2023 Werner Randelshofer, Switzerland." in raw
    notice = next(item for item in pinned["texts"] if item.get("artifactEntry") == "META-INF/FastDoubleParser-NOTICE")
    assert terms["sourceReference"] == {"artifactEntry": notice["artifactEntry"], "sha256": notice["sha256"],
        "url": "https://github.com/wrandelshofer/FastDoubleParser/blob/522be16e145f43308c43b23094e31d5efcaa580e/LICENSE"}
    assert terms["source"] == terms["sourceReference"]["url"]
    assert len([item for item in pinned["texts"] if "sourceReference" not in item]) == 6


@pytest.mark.parametrize("entry", [None, "", 42])
def test_android_embedded_notice_entry_cannot_bypass_source_binding_with_invalid_types(notice_runtime, entry):
    validate, root, report, cargo, _, pinned = notice_runtime
    pinned["texts"][0].pop("declarationUrl")
    pinned["texts"][0]["artifactEntry"] = entry
    (root / "app/licenses/android-runtime.lock.json").write_text(json.dumps({"schemaVersion": 1, "artifacts": [pinned]}))
    with pytest.raises(ValueError, match="embedded notice entry"):
        validate(root, report, "arm64", cargo)


@pytest.mark.parametrize("damage", [None, "missing", "terms_sha", "notice_sha", "reference", "source", "unpinned",
                                   "notice_entry", "notice_extra", "notice_empty", "ambiguous", "notice_text", "reference_null"])
def test_android_supplemental_terms_require_the_exact_embedded_notice_and_fixed_source(notice_runtime, damage):
    validate, root, report, cargo, rows, pinned = notice_runtime
    url = "https://github.com/example/runtime/blob/" + "a" * 40 + "/LICENSE"
    reference = {"artifactEntry": "META-INF/NOTICE", "sha256": "", "url": url}
    embedded = ("Synthetic component is MIT licensed.\n" + url + "\n").encode()
    if damage == "notice_text":
        embedded = b"Synthetic component notice does not name the claimed fixed source.\n"
    reference["sha256"] = hashlib.sha256(embedded).hexdigest()
    artifact = Path(rows[0]["artifact"])
    with ZipFile(artifact, "a") as archive:
        archive.writestr("META-INF/NOTICE", embedded)
    pinned["artifactSha256"] = rows[0]["artifactSha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
    terms = root / "app/licenses/component-MIT.txt"
    terms.write_text("Synthetic complete MIT terms and original copyright")
    supplemental: dict[str, object] = {"file": terms.name, "sha256": hashlib.sha256(terms.read_bytes()).hexdigest(),
                                       "source": url, "sourceReference": reference}
    if damage == "missing":
        terms.unlink()
    elif damage == "terms_sha":
        supplemental["sha256"] = "b" * 64
    elif damage == "notice_sha":
        reference["sha256"] = "b" * 64
    elif damage == "reference":
        reference["url"] = supplemental["source"] = url.replace("a" * 40, "b" * 40)
    elif damage == "source":
        supplemental["source"] = "https://example.test/unrelated-MIT"
    elif damage == "unpinned":
        reference["url"] = supplemental["source"] = url.replace("a" * 40, "main")
    elif damage == "notice_entry":
        reference["artifactEntry"] = "META-INF/UNRELATED"
    elif damage == "notice_extra":
        reference["artifactEntry"] += "!ignored!ignored"
    elif damage == "notice_empty":
        reference["artifactEntry"] = ""
    elif damage == "ambiguous":
        supplemental["declarationUrl"] = "https://example.test/terms"
    elif damage == "reference_null":
        supplemental["sourceReference"] = None
    pinned["texts"].append(supplemental)
    (root / "app/licenses/android-runtime.lock.json").write_text(json.dumps({"schemaVersion": 1, "artifacts": [pinned]}))
    data = json.loads(report.read_text()); data["artifacts"] = rows; report.write_text(json.dumps(data))
    if damage is None:
        package = validate(root, report, "arm64", cargo)[0]
        assert package["texts"][-1]["sha256"] == supplemental["sha256"]
        proof = package["supplementalSources"][-1]
        assert proof["source"] == url and reference["sha256"] in proof["verification"]
        assert "embedded notice" in proof["verification"] and "POM" not in proof["verification"]
    else:
        with pytest.raises((ValueError, FileNotFoundError, KeyError)):
            validate(root, report, "arm64", cargo)


@pytest.mark.parametrize("mutation", [None, "bytes", "identity", "escape"])
def test_android_notices_bind_inherited_identity_and_terms_to_a_contained_parent_pom(notice_runtime, mutation):
    validate, root, report, cargo, rows, pinned = notice_runtime
    parent = root / "app/licenses/parent.pom"
    parent.write_text('<project xmlns="http://maven.apache.org/POM/4.0.0"><groupId>example</groupId>'
                      '<artifactId>parent</artifactId><version>1.0</version><licenses><license>'
                      '<url>https://example.test/terms</url></license></licenses></project>')
    pom = Path(rows[0]["pom"])
    pom.write_text('<project xmlns="http://maven.apache.org/POM/4.0.0"><parent><groupId>example</groupId>'
                   '<artifactId>parent</artifactId><version>1.0</version></parent><artifactId>runtime</artifactId></project>')
    pinned["pomSha256"] = rows[0]["pomSha256"] = hashlib.sha256(pom.read_bytes()).hexdigest()
    pinned["parentPoms"] = [{"file": "parent.pom", "sha256": hashlib.sha256(parent.read_bytes()).hexdigest()}]
    if mutation == "bytes":
        parent.write_text("Changed parent descriptor")
    elif mutation == "identity":
        parent.write_text(parent.read_text().replace("<artifactId>parent</artifactId>", "<artifactId>other</artifactId>"))
        pinned["parentPoms"][0]["sha256"] = hashlib.sha256(parent.read_bytes()).hexdigest()
    elif mutation == "escape":
        outside = root / "private-parent.pom"
        outside.write_bytes(parent.read_bytes())
        pinned["parentPoms"][0]["file"] = "../../private-parent.pom"
    (root / "app/licenses/android-runtime.lock.json").write_text(json.dumps({"schemaVersion": 1, "artifacts": [pinned]}))
    data = json.loads(report.read_text())
    data["artifacts"] = rows
    report.write_text(json.dumps(data))
    if mutation is None:
        assert validate(root, report, "arm64", cargo)[0]["texts"]
    else:
        with pytest.raises(ValueError):
            validate(root, report, "arm64", cargo)


def test_android_notices_require_a_reviewed_selected_artifact_identity(notice_runtime):
    validate, root, report, cargo, _, pinned = notice_runtime
    pinned.pop("artifactIdentity")
    data = json.loads(report.read_text())
    data["artifacts"][0].pop("artifactIdentity")
    report.write_text(json.dumps(data))
    (root / "app/licenses/android-runtime.lock.json").write_text(json.dumps({"schemaVersion": 1, "artifacts": [pinned]}))
    with pytest.raises(ValueError):
        validate(root, report, "arm64", cargo)


@pytest.mark.parametrize("damage", ["runtime_duplicate", "source_duplicate", "source_conflict"])
def test_android_runtime_rejects_ambiguous_or_conflicting_class_entries(notice_runtime, damage):
    validate, root, report, cargo, rows, pinned = notice_runtime
    artifact = Path(rows[0]["artifact"])
    runtime = Path(rows[0]["runtimeArtifact"])
    if damage == "runtime_duplicate":
        with ZipFile(runtime, "w") as archive:
            archive.writestr("example/Runtime.class", b"Unrelated first class bytes")
            archive.writestr("example/Runtime.class", b"Synthetic actual class bytes")
    else:
        conflict = io.BytesIO()
        with ZipFile(conflict, "w") as archive:
            archive.writestr("example/Runtime.class", b"Unrelated first class bytes")
            if damage == "source_duplicate":
                archive.writestr("example/Runtime.class", b"Synthetic actual class bytes")
        with ZipFile(artifact, "w") as archive:
            if damage == "source_conflict":
                archive.writestr("libs/other.jar", conflict.getvalue())
                archive.writestr("classes.jar", runtime.read_bytes())
            else:
                archive.writestr("classes.jar", conflict.getvalue())
    pinned["artifactSha256"] = rows[0]["artifactSha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
    rows[0]["runtimeArtifactSha256"] = hashlib.sha256(runtime.read_bytes()).hexdigest()
    data = json.loads(report.read_text())
    data["artifacts"] = rows
    report.write_text(json.dumps(data))
    (root / "app/licenses/android-runtime.lock.json").write_text(json.dumps({"schemaVersion": 1, "artifacts": [pinned]}))
    with pytest.raises(ValueError, match="duplicate|conflicting"):
        validate(root, report, "arm64", cargo)


@pytest.mark.parametrize("mutation", ["missing", "abi", "artifact", "pom", "text", "lock", "gradle_lock",
                                     "extra", "omitted", "duplicate", "project", "project_missing", "declaration", "identity", "runtime", "classifier", "runtime_missing"])
def test_android_notices_reject_unverified_bytes_and_incomplete_runtime(notice_runtime, mutation):
    validate, root, report, cargo, rows, pinned = notice_runtime
    data = json.loads(report.read_text())
    notice_lock = root / "app/licenses/android-runtime.lock.json"
    if mutation == "missing":
        report = None
    elif mutation == "abi":
        data["configuration"] = "x86_64DebugRuntimeClasspath"
    elif mutation in {"artifact", "pom"}:
        Path(rows[0][mutation]).write_text("Changed bytes")
    elif mutation == "text":
        (root / "app/licenses/terms.txt").write_text("Changed text")
    elif mutation == "lock":
        pinned["artifactSha256"] = "a" * 64
    elif mutation == "gradle_lock":
        (root / "app/src-tauri/gen/android/app/gradle.lockfile").write_text("example:runtime:2.0=arm64DebugRuntimeClasspath\n")
    elif mutation == "extra":
        data["artifacts"][0]["name"] = "extra"
    elif mutation == "omitted":
        data["artifacts"].pop(0)
    elif mutation == "duplicate":
        data["artifacts"].append(data["artifacts"][0])
    elif mutation == "project":
        data["artifacts"][1]["projectDirectory"] = str(root / "wrong-source")
    elif mutation == "project_missing":
        data["artifacts"].pop(1)
    elif mutation == "declaration":
        pinned["texts"][0]["declarationUrl"] = "https://wrong.test/terms"
    elif mutation == "runtime":
        with ZipFile(rows[0]["runtimeArtifact"], "w") as archive:
            archive.writestr("example/Runtime.class", b"Unrelated compiled classes")
        data["artifacts"][0]["runtimeArtifactSha256"] = hashlib.sha256(Path(rows[0]["runtimeArtifact"]).read_bytes()).hexdigest()
    elif mutation == "classifier":
        data["artifacts"][0]["runtimeArtifactIdentity"] = "runtime-1.0-tests.aar -> runtime.jar (example:runtime:1.0)"
    elif mutation == "runtime_missing":
        data["artifacts"][0].pop("runtimeArtifact")
    elif mutation == "identity":
        path = Path(rows[0]["pom"])
        path.write_text(path.read_text().replace("<version>1.0</version>", "<version>2.0</version>"))
        pinned["pomSha256"] = data["artifacts"][0]["pomSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    notice_lock.write_text(json.dumps({"schemaVersion": 1, "artifacts": [pinned]}))
    if report:
        report.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        validate(root, report, "arm64", cargo)
