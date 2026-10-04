"""Inspect selected APK bytes with an SDK substitute, without installing them."""

import hashlib
import json
import runpy
import shutil
import stat
import struct
import subprocess
import sys
import warnings
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
VERSION = json.loads((ROOT / "app/package.json").read_text())["version"]
MANIFEST_PATH = "assets/bundled/build-manifest.json"
NOTICE_PATH = "assets/bundled/THIRD-PARTY.txt"


def test_android_resource_whitelist_has_only_the_official_cli_asset_producer():
    config = json.loads((ROOT / "app/src-tauri/tauri.conf.json").read_text())
    android = json.loads((ROOT / "app/src-tauri/tauri.android.conf.json").read_text())
    assert config["bundle"]["resources"] == {
        "bundled/build-manifest.json": "bundled/build-manifest.json",
        "bundled/THIRD-PARTY.txt": "bundled/THIRD-PARTY.txt",
    }
    assert "resources" not in android["bundle"]
    gradle = (ROOT / "app/src-tauri/gen/android/app/build.gradle.kts").read_text()
    # The CLI injects both leaves into main/assets before Gradle merges assets.
    # Adding the same leaves through another source directory makes that merge fail.
    assert "syncPracticeResources" not in gradle
    assert "generated/practice-resources" not in gradle
    assert ".assets.srcDir" not in gradle
    assert "duplicatesStrategy" not in gradle


@pytest.mark.parametrize("path,ignored", [
    ("app/src-tauri/gen/android/app/src/main/assets/tauri.conf.json", True),
    ("app/src-tauri/gen/android/app/src/main/assets/bundled/build-manifest.json", True),
    ("app/src-tauri/gen/android/app/src/main/assets/bundled/THIRD-PARTY.txt", True),
    ("app/src-tauri/gen/android/app/src/main/AndroidManifest.xml", False),
    ("app/src-tauri/gen/android/app/src/main/java/com/practiq/android/MainActivity.kt", False),
])
def test_android_cli_generated_assets_are_ignored_without_hiding_host_sources(path, ignored):
    result = subprocess.run(["git", "check-ignore", "--no-index", "--quiet", path], cwd=ROOT, check=False)
    assert result.returncode == (0 if ignored else 1)


def elf(abi: str) -> bytes:
    header = bytearray(64)
    header[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHI", header, 16, 3, 183 if abi == "arm64-v8a" else 62, 1)
    struct.pack_into("<Q", header, 32, 64)
    struct.pack_into("<H", header, 52, 64)
    struct.pack_into("<HH", header, 54, 56, 2)
    payload = b"Synthetic shared-library payload; never executed"
    size = len(header) + 2 * 56 + len(payload)
    load = struct.pack("<IIQQQQQQ", 1, 4, 0, 0, 0, size, 16_384, 16_384)
    relro = struct.pack("<IIQQQQQQ", 0x6474E552, 4, 0, 0, 0, size, 16_384, 1)
    return bytes(header) + load + relro + payload


def manifest(abi: str) -> dict:
    return {"schemaVersion": 2, "packageMode": "desktop-practice", "platform": "android",
            "architecture": "arm64" if abi == "arm64-v8a" else "x86_64", "desktopVersion": VERSION}


def entries(abi: str) -> list[tuple[str | zipfile.ZipInfo, bytes]]:
    return [("AndroidManifest.xml", b"Synthetic binary manifest inspected by the fake SDK"),
            ("classes.dex", b"Synthetic Android code; never executed"),
            (MANIFEST_PATH, json.dumps(manifest(abi)).encode()),
            (NOTICE_PATH, b"Synthetic Android notices"),
            (f"lib/{abi}/libpractiq_desktop.so", elf(abi))]


def write_apk(path: Path, contents: list[tuple[str | zipfile.ZipInfo, bytes]]) -> None:
    with warnings.catch_warnings(), zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        warnings.simplefilter("ignore", UserWarning)
        for name, data in contents:
            info = name if isinstance(name, zipfile.ZipInfo) else zipfile.ZipInfo(name)
            if not info.external_attr:
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, data)


def badging(abi: str) -> str:
    return (f"package: name='com.practiq.android' versionCode='1' versionName='{VERSION}'\n"
            "sdkVersion:'26'\n"
            "targetSdkVersion:'36'\n"
            f"native-code: '{abi}'\n")


@pytest.fixture
def apk_case(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "app/scripts"))
    scope = runpy.run_path(str(ROOT / "app/scripts/check-apk.py"))
    apk = tmp_path / "selected.apk"
    sdk = tmp_path / "sdk/aapt2"
    sdk.parent.mkdir()
    sdk.write_bytes(b"SDK substitute; subprocess calls are mocked")
    sdk.chmod(0o755)
    output = tmp_path / "checks/android-package.json"
    case = {"apk": apk, "sdk": sdk, "output": output, "scope": scope, "abi": "arm64-v8a",
            "badging": badging("arm64-v8a"), "calls": []}

    def dump(command, **kwargs):
        assert command[:3] == [str(sdk), "dump", "badging"]
        selected = Path(command[3])
        assert selected != apk and selected.read_bytes() == case["original"]
        assert not selected.stat().st_mode & 0o222
        case["calls"].append(command)
        if "mutate" in case:
            target = apk if case["mutate"] == "original" else selected
            target.chmod(0o600)
            target.write_bytes(case["original"] + b"Unchecked replacement bytes")
        if "sdk_error" in case:
            raise subprocess.CalledProcessError(1, command, stderr="Synthetic invalid binary manifest")
        return case["badging"]

    monkeypatch.setattr(scope["main"].__globals__["subprocess"], "check_output", dump)

    def invoke(contents=None):
        write_apk(apk, entries(case["abi"]) if contents is None else contents)
        case["original"] = apk.read_bytes()
        monkeypatch.setattr(sys, "argv", ["check-apk.py", "--installer", str(apk), "--abi", case["abi"],
                                          "--aapt2", str(sdk), "--output", str(output),
                                          *(["--expected-notices", str(case["expected_notices"])] if "expected_notices" in case else []),
                                          *(["--retain-installer", str(case["retained"])] if "retained" in case else [])])
        scope["main"]()
        return json.loads(output.read_text())

    case["invoke"] = invoke
    return case


@pytest.mark.parametrize("abi", ["arm64-v8a", "x86_64"])
def test_apk_checks_actual_native_identity_resources_and_same_installer_bytes(apk_case, abi):
    apk_case["abi"] = abi
    apk_case["badging"] = badging(abi)
    report = apk_case["invoke"]()
    assert report["passed"] is True and report["packageMode"] == "desktop-practice"
    assert report["manifest"] == manifest(abi)
    assert report["desktopVersion"] == VERSION
    assert report["nativePackage"] == {"identifier": "com.practiq.android", "versionName": VERSION,
                                        "versionCode": 1, "minSdkVersion": 26, "targetSdkVersion": 36}
    assert report["nativeExecutable"] == f"lib/{abi}/libpractiq_desktop.so"
    assert report["nativeAbi"] == abi and report["embeddedAiEngines"] == []
    assert report["nativeLibrarySha256"] == hashlib.sha256(elf(abi)).hexdigest()
    assert report["noticeSha256"] == hashlib.sha256(b"Synthetic Android notices").hexdigest()
    assert report["installerSha256"] == hashlib.sha256(apk_case["original"]).hexdigest()
    assert report["sizeBytes"] == len(apk_case["original"])
    assert len(apk_case["calls"]) == 1


def test_apk_accepts_actual_sdk_36_badging_and_records_both_sdk_bounds(apk_case):
    # Header observed from the selected build-tools 36.0.0 AAPT2, with its
    # additional compile/platform attributes and current minimum-SDK spelling.
    apk_case["badging"] = (
        f"package: name='com.practiq.android' versionCode='1' versionName='{VERSION}' "
        "platformBuildVersionName='16' platformBuildVersionCode='36' "
        "compileSdkVersion='36' compileSdkVersionCodename='16'\n"
        "minSdkVersion:'26'\ntargetSdkVersion:'36'\nnative-code: 'arm64-v8a'\n"
    )
    identity = apk_case["invoke"]()["nativePackage"]
    assert identity["minSdkVersion"] == 26
    assert identity["targetSdkVersion"] == 36


@pytest.mark.parametrize("field", ["sdkVersion", "minSdkVersion"])
def test_apk_accepts_one_minimum_sdk_alias_and_records_target_sdk(apk_case, field):
    apk_case["badging"] = apk_case["badging"].replace("sdkVersion:", field + ":")
    identity = apk_case["invoke"]()["nativePackage"]
    assert identity["minSdkVersion"] == 26
    assert identity["targetSdkVersion"] == 36


@pytest.mark.parametrize("minimum", [
    "", "sdkVersion:'25'", "minSdkVersion:'27'", "sdkVersion:''", "minSdkVersion:'unknown'",
    "sdkVersion:26", "minSdkVersion:'26' extra", " minSdkVersion:'26'",
    "sdkVersion:'26'\nsdkVersion:'26'", "minSdkVersion:'26'\nminSdkVersion:'26'",
    "sdkVersion:'26'\nminSdkVersion:'26'", "minSdkVersion:'26'\nsdkVersion:'26'",
    "sdkVersion:'26'\nminSdkVersion:''", "minSdkVersion:'26'\nsdkVersion:26",
])
def test_apk_rejects_missing_malformed_wrong_or_ambiguous_minimum_sdk_without_a_report(apk_case, minimum):
    apk_case["badging"] = apk_case["badging"].replace("sdkVersion:'26'", minimum)
    with pytest.raises(ValueError, match="minSdk"):
        apk_case["invoke"]()
    assert not apk_case["output"].exists()


@pytest.mark.parametrize("target", [
    "", "targetSdkVersion:'35'", "targetSdkVersion:''", "targetSdkVersion:'unknown'",
    "targetSdkVersion:36", "targetSdkVersion:'36' extra", " targetSdkVersion:'36'",
    "targetSdkVersion:'36'\ntargetSdkVersion:'36'", "targetSdkVersion:'36'\ntargetSdkVersion:''",
])
def test_apk_rejects_missing_malformed_wrong_or_ambiguous_target_sdk_without_a_report(apk_case, target):
    apk_case["badging"] = apk_case["badging"].replace("targetSdkVersion:'36'", target)
    with pytest.raises(ValueError, match="targetSdk"):
        apk_case["invoke"]()
    assert not apk_case["output"].exists()


@pytest.mark.parametrize("old,new,error", [
    ("com.practiq.android", "com.other.application", "package identity"),
    (f"versionName='{VERSION}'", "versionName='99.0.0'", "version"),
    ("sdkVersion:'26'", "sdkVersion:'25'", "minSdk"),
    ("sdkVersion:'26'", "sdkVersion:'unknown'", "minSdk"),
    ("native-code: 'arm64-v8a'", "native-code: 'x86_64'", "ABI"),
    ("sdkVersion:'26'", "sdkVersion:'26'\nsdkVersion:'27'", "minSdk"),
    ("package:", "unrecognized:", "package identity"),
    ("versionCode='1'", "versionCode='0'", "versionCode"),
])
def test_apk_rejects_native_manifest_identity_and_abi_mismatches_without_a_report(apk_case, old, new, error):
    apk_case["badging"] = apk_case["badging"].replace(old, new)
    with pytest.raises(ValueError, match=error):
        apk_case["invoke"]()
    assert not apk_case["output"].exists()


@pytest.mark.parametrize("field,value", [("schemaVersion", 1), ("packageMode", "bundled-ai"),
                                         ("platform", "linux"), ("architecture", "x86_64"),
                                         ("desktopVersion", "99.0.0"), ("packages", [])])
def test_apk_rejects_embedded_metadata_outside_the_selected_candidate(apk_case, field, value):
    data = manifest("arm64-v8a") | {field: value}
    contents = [(name, json.dumps(data).encode() if name == MANIFEST_PATH else payload)
                for name, payload in entries("arm64-v8a")]
    with pytest.raises(ValueError, match="metadata|platform|architecture|version|mode|schema"):
        apk_case["invoke"](contents)
    assert not apk_case["output"].exists()


@pytest.mark.parametrize("mutation", ["missing", "empty", "symlink", "not_elf", "wrong_machine", "elf32", "extra_abi"])
def test_apk_requires_a_regular_nonempty_native_library_for_the_selected_abi(apk_case, mutation):
    native = "lib/arm64-v8a/libpractiq_desktop.so"
    contents = [(name, data) for name, data in entries("arm64-v8a") if name != native]
    if mutation == "symlink":
        link = zipfile.ZipInfo(native)
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        contents.append((link, b"/unrelated/libpractiq_desktop.so"))
    elif mutation == "extra_abi":
        contents.extend([(native, elf("arm64-v8a")), ("lib/x86_64/libother.so", elf("x86_64"))])
    elif mutation != "missing":
        data = {"empty": b"", "not_elf": b"Pretend native library", "wrong_machine": elf("x86_64"),
                "elf32": elf("arm64-v8a")[:4] + b"\x01" + elf("arm64-v8a")[5:]}[mutation]
        contents.append((native, data))
    with pytest.raises(ValueError, match="regular|native library|ELF|ABI"):
        apk_case["invoke"](contents)
    assert not apk_case["output"].exists()


@pytest.mark.parametrize("changes,truncate", [
    ([(32, "Q", 0)], None),
    ([(32, "Q", 32)], None),
    ([(32, "Q", 2**64 - 1)], None),
    ([(54, "H", 0)], None),
    ([(54, "H", 55)], None),
    ([(54, "H", 57)], None),
    ([(56, "H", 0)], None),
    ([(56, "H", 4097)], None),
    ([(56, "H", 65535)], None),
    ([], 64 + 55),
    ([], 64 + 2 * 56 - 1),
    ([(64, "I", 2)], None),
], ids=["missing-table", "overlapping-header", "table-offset-overflow", "zero-entry-width",
        "short-entry-width", "long-entry-width", "no-headers", "header-count-limit",
        "extended-count", "first-header-truncated", "last-header-truncated", "no-load-segment"])
def test_apk_rejects_invalid_or_unbounded_program_headers(apk_case, changes, truncate):
    data = bytearray(elf("arm64-v8a"))
    for offset, format_, value in changes:
        struct.pack_into("<" + format_, data, offset, value)
    if truncate is not None:
        data = data[:truncate]
    contents = [(name, bytes(data) if name == "lib/arm64-v8a/libpractiq_desktop.so" else payload)
                for name, payload in entries("arm64-v8a")]
    with pytest.raises(ValueError, match="ELF|program|LOAD"):
        apk_case["invoke"](contents)
    assert not apk_case["output"].exists() and apk_case["calls"] == []


@pytest.mark.parametrize("changes", [
    [(64 + 48, "Q", 0)], [(64 + 48, "Q", 1)], [(64 + 48, "Q", 4096)],
    [(64 + 48, "Q", 24_576)], [(64 + 16, "Q", 1)],
    [(64 + 32, "Q", 16_385)], [(64 + 40, "Q", 1)],
    [(64 + 8, "Q", 1024), (64 + 16, "Q", 1024)],
    [(64 + 16, "Q", 2**64 - 16_384), (64 + 40, "Q", 32_768)],
], ids=["zero-alignment", "one-alignment", "4k-alignment", "non-power-of-two",
        "incongruent-address", "file-range", "memory-smaller-than-file", "file-offset",
        "virtual-range-overflow"])
def test_apk_rejects_unsafe_load_segments(apk_case, changes):
    data = bytearray(elf("arm64-v8a"))
    for offset, format_, value in changes:
        struct.pack_into("<" + format_, data, offset, value)
    contents = [(name, bytes(data) if name == "lib/arm64-v8a/libpractiq_desktop.so" else payload)
                for name, payload in entries("arm64-v8a")]
    with pytest.raises(ValueError, match="ELF|LOAD|16 KiB"):
        apk_case["invoke"](contents)
    assert not apk_case["output"].exists() and apk_case["calls"] == []


@pytest.mark.parametrize("changes", [
    [(120 + 40, "Q", 4096)],
    [(120 + 16, "Q", 2**64 - 16), (120 + 40, "Q", 32)],
], ids=["unaligned-relro-end", "relro-address-overflow"])
def test_apk_rejects_unsafe_relro_segments(apk_case, changes):
    data = bytearray(elf("arm64-v8a"))
    for offset, format_, value in changes:
        struct.pack_into("<" + format_, data, offset, value)
    contents = [(name, bytes(data) if name == "lib/arm64-v8a/libpractiq_desktop.so" else payload)
                for name, payload in entries("arm64-v8a")]
    with pytest.raises(ValueError, match="ELF|RELRO|16 KiB"):
        apk_case["invoke"](contents)
    assert not apk_case["output"].exists() and apk_case["calls"] == []


@pytest.mark.parametrize("changes", [
    [(56, "H", 1)],
    [(64 + 48, "Q", 32_768)],
    [(64 + 8, "Q", 1), (64 + 16, "Q", 1), (64 + 32, "Q", 0)],
    [(64 + 8, "Q", 16_384), (64 + 16, "Q", 16_384), (64 + 32, "Q", 0)],
    [(120 + 16, "Q", 16_368), (120 + 32, "Q", 32), (120 + 40, "Q", 16)],
    [(120, "I", 0), (120 + 8, "Q", 2**64 - 1), (120 + 16, "Q", 2**64 - 1)],
], ids=["no-relro", "32k-load-alignment", "congruent-nonaligned-addresses", "zero-file-bss",
        "relro-file-larger-than-memory", "null-header-undefined-fields"])
def test_apk_accepts_valid_aligned_load_and_relro_segments(apk_case, changes):
    data = bytearray(elf("arm64-v8a"))
    for offset, format_, value in changes:
        struct.pack_into("<" + format_, data, offset, value)
    contents = [(name, bytes(data) if name == "lib/arm64-v8a/libpractiq_desktop.so" else payload)
                for name, payload in entries("arm64-v8a")]
    assert apk_case["invoke"](contents)["passed"]


@pytest.mark.parametrize("fault", ["valid", "wrong-machine", "unaligned-relro", "unaligned-alias", "missing-table"])
def test_apk_checks_all_native_libraries_not_only_the_app_library(apk_case, fault):
    data = bytearray(elf("x86_64" if fault == "wrong-machine" else "arm64-v8a"))
    if fault in {"unaligned-relro", "unaligned-alias"}:
        struct.pack_into("<Q", data, 120 + 40, 4096)
    if fault == "missing-table":
        struct.pack_into("<H", data, 56, 0)
    name = "libdependency.binary" if fault == "unaligned-alias" else "libdependency.so"
    contents = entries("arm64-v8a") + [(f"lib/arm64-v8a/{name}", bytes(data))]
    if fault == "valid":
        assert apk_case["invoke"](contents)["passed"]
    else:
        with pytest.raises(ValueError, match="ELF|RELRO|program"):
            apk_case["invoke"](contents)
        assert not apk_case["output"].exists() and apk_case["calls"] == []


@pytest.mark.parametrize("path", ["../outside", "/absolute", "assets/../outside", "C:/absolute", "assets\\outside",
                                 "assets//outside", "./outside", "assets/./outside", "classes.dex"])
def test_apk_rejects_ambiguous_or_escaping_archive_paths(apk_case, path):
    with pytest.raises(ValueError, match="archive path|duplicate"):
        apk_case["invoke"](entries("arm64-v8a") + [(path, b"Unexpected archive entry")])
    assert not apk_case["output"].exists()
    assert apk_case["calls"] == []


@pytest.mark.parametrize("path", ["assets/python3.14", "lib/arm64-v8a/libpython3.14.so", "assets/office/soffice",
                                 "assets/LibreOffice.app/program", "assets/practiq-ai", "assets/worker.py",
                                 "assets/base_library.zip", "assets/PYTHON-LICENSE.txt", "assets/practiq_ai/runtime.bin"])
def test_apk_rejects_embedded_ai_engines_anywhere_in_the_archive(apk_case, path):
    with pytest.raises(ValueError, match="embedded AI"):
        apk_case["invoke"](entries("arm64-v8a") + [(path, b"Stale engine bytes")])
    assert not apk_case["output"].exists()


@pytest.mark.parametrize("mutation", ["missing_notice", "empty_notice", "extra_resource", "oversized_manifest"])
def test_apk_requires_only_bounded_metadata_and_nonempty_notices(apk_case, mutation):
    contents = entries("arm64-v8a")
    if mutation == "missing_notice":
        contents = [(name, data) for name, data in contents if name != NOTICE_PATH]
    elif mutation == "empty_notice":
        contents = [(name, b"" if name == NOTICE_PATH else data) for name, data in contents]
    elif mutation == "extra_resource":
        contents.append(("assets/bundled/unexpected.bin", b"Unexpected resource"))
    else:
        contents = [(name, b" " * 65_537 if name == MANIFEST_PATH else data) for name, data in contents]
    with pytest.raises(ValueError, match="resources|notices|size limit"):
        apk_case["invoke"](contents)
    assert not apk_case["output"].exists()


@pytest.mark.parametrize("mutation", ["original", "snapshot"])
def test_apk_check_uses_private_checked_bytes_and_rejects_mutated_snapshots(apk_case, mutation):
    apk_case["mutate"] = mutation
    if mutation == "snapshot":
        with pytest.raises(ValueError, match="snapshot"):
            apk_case["invoke"]()
        assert not apk_case["output"].exists()
    else:
        report = apk_case["invoke"]()
        assert report["installerSha256"] == hashlib.sha256(apk_case["original"]).hexdigest()
        assert apk_case["apk"].read_bytes() != apk_case["original"]


def test_apk_check_requires_fresh_reports_and_never_overwrites_existing_evidence(apk_case):
    apk_case["output"].parent.mkdir()
    apk_case["output"].write_text("Existing evidence")
    with pytest.raises(FileExistsError):
        apk_case["invoke"]()
    assert apk_case["output"].read_text() == "Existing evidence"
    assert apk_case["calls"] == []


def test_apk_check_requires_successful_explicit_sdk_inspection(apk_case):
    apk_case["sdk_error"] = True
    with pytest.raises(subprocess.CalledProcessError):
        apk_case["invoke"]()
    assert not apk_case["output"].exists()


@pytest.mark.parametrize("matches", [True, False])
def test_apk_check_binds_actual_notices_to_the_fresh_expected_candidate_without_false_reports(apk_case, matches):
    expected = apk_case["apk"].parent / "expected-THIRD-PARTY.txt"
    expected.write_bytes(b"Synthetic Android notices" if matches else b"Different candidate notices")
    apk_case["expected_notices"] = expected
    if matches:
        report = apk_case["invoke"]()
        assert report["passed"] and report["noticeSha256"] == hashlib.sha256(expected.read_bytes()).hexdigest()
    else:
        with pytest.raises(ValueError, match="notices"):
            apk_case["invoke"]()
        assert not apk_case["output"].exists()


@pytest.mark.parametrize("replace_original", [False, True])
def test_apk_retains_only_checked_snapshot_bytes_as_readonly_after_original_replacement(apk_case, replace_original):
    retained = apk_case["apk"].parent / "retained/PractiQ.apk"
    apk_case["retained"] = retained
    if replace_original:
        apk_case["mutate"] = "original"
    report = apk_case["invoke"]()
    assert retained.read_bytes() == apk_case["original"]
    assert hashlib.sha256(retained.read_bytes()).hexdigest() == report["installerSha256"]
    assert stat.S_IMODE(retained.stat().st_mode) == 0o444
    assert report["retainedInstallerSha256"] == report["installerSha256"]
    assert not list(retained.parent.glob(".practiq-retained-*"))


@pytest.mark.parametrize("fault", ["copy", "snapshot", "snapshot_after_copy"])
def test_apk_retention_rejects_changed_copy_or_snapshot_without_delivering_false_evidence(apk_case, monkeypatch, fault):
    retained = apk_case["apk"].parent / "retained/PractiQ.apk"
    apk_case["retained"] = retained
    if fault == "snapshot":
        apk_case["mutate"] = "snapshot"
    else:
        copy = shutil.copyfile
        def corrupted_copy(source, destination, *args, **kwargs):
            result = copy(source, destination, *args, **kwargs)
            if Path(destination).name.startswith(".practiq-retained-"):
                if fault == "copy":
                    Path(destination).write_bytes(b"Unchecked retained replacement bytes")
                else:
                    Path(source).chmod(0o600)
                    Path(source).write_bytes(apk_case["original"] + b"Snapshot changed after retained copy")
            return result
        monkeypatch.setattr(shutil, "copyfile", corrupted_copy)
    with pytest.raises(ValueError, match="retained|snapshot"):
        apk_case["invoke"]()
    assert not retained.exists() and not apk_case["output"].exists()
    assert not list(retained.parent.glob(".practiq-retained-*"))


@pytest.mark.parametrize("existing", ["file", "symlink"])
def test_apk_retention_rejects_existing_destinations_before_sdk_checks(apk_case, existing):
    retained = apk_case["apk"].parent / "retained/PractiQ.apk"
    retained.parent.mkdir()
    prior = retained.parent / "prior.apk"
    prior.write_bytes(b"Prior retained evidence")
    if existing == "symlink":
        retained.symlink_to(prior)
    else:
        retained.write_bytes(prior.read_bytes())
    apk_case["retained"] = retained
    with pytest.raises(FileExistsError):
        apk_case["invoke"]()
    assert retained.read_bytes() == b"Prior retained evidence" and not apk_case["output"].exists()
    assert apk_case["calls"] == []


def test_apk_retention_preserves_a_destination_created_during_checks_before_handoff(apk_case, monkeypatch):
    retained = apk_case["apk"].parent / "retained/PractiQ.apk"
    apk_case["retained"] = retained
    sdk = apk_case["scope"]["main"].__globals__["subprocess"]
    dump = sdk.check_output
    def create_destination(command, **kwargs):
        result = dump(command, **kwargs)
        retained.parent.mkdir()
        retained.write_bytes(b"Other retained evidence created during checks")
        return result
    monkeypatch.setattr(sdk, "check_output", create_destination)
    with pytest.raises(FileExistsError):
        apk_case["invoke"]()
    assert retained.read_bytes() == b"Other retained evidence created during checks"
    assert not apk_case["output"].exists() and not list(retained.parent.glob(".practiq-retained-*"))
