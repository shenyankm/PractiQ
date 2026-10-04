"""Inspect one selected APK without installing it, executing its libraries or starting AI."""

import argparse
import hashlib
import json
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release
from desktop_package import validate_manifest

ABIS = {"arm64-v8a": ("arm64", 183), "x86_64": ("x86_64", 62)}
BUNDLE = "assets/bundled/"
RESOURCE_NAMES = {BUNDLE + "build-manifest.json", BUNDLE + "THIRD-PARTY.txt"}
MAX_APK_BYTES = 512 * 1024 * 1024
MAX_ENTRIES = 100_000
MAX_MEMBER_BYTES = 512 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
MAX_PROGRAM_HEADERS = 4096
PAGE_SIZE = 16_384
MAX_ELF_ADDRESS = 2**64 - 1


def archive_entries(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    """Inspect the whole archive namespace before reading any selected member."""
    result = {}
    entries = archive.infolist()
    if len(entries) > MAX_ENTRIES or sum(item.file_size for item in entries) > MAX_UNCOMPRESSED_BYTES:
        raise ValueError("APK archive exceeds the size limit")
    for item in entries:
        name = item.filename
        path = name[:-1] if item.is_dir() else name
        parts = path.split("/")
        if (not path or name != item.orig_filename or "\\" in name or ":" in parts[0]
                or any(part in {"", ".", ".."} for part in parts)):
            raise ValueError(f"Unsafe APK archive path: {name}")
        if path in result:
            raise ValueError(f"APK archive contains a duplicate path: {name}")
        kind = stat.S_IFMT(item.external_attr >> 16)
        if kind not in ({0, stat.S_IFDIR} if item.is_dir() else {0, stat.S_IFREG}):
            raise ValueError(f"APK archive entries must be regular files or directories: {name}")
        if item.flag_bits & 1 or item.file_size > MAX_MEMBER_BYTES:
            raise ValueError(f"APK archive member is encrypted or exceeds the size limit: {name}")
        result[path] = item
    for name in result:
        for parent in PurePosixPath(name).parents:
            if str(parent) in result and not result[str(parent)].is_dir():
                raise ValueError(f"APK archive path has a file as its parent: {name}")
        for part in PurePosixPath(name).parts:
            lower = part.lower()
            if (lower in {"python", "office", "python-license.txt", "base_library.zip", "practiq-ai", "practiq-ai.exe", "practiq_ai"}
                    or lower.startswith(("libreoffice", "soffice", "libpython"))
                    or re.fullmatch(r"python(?:[0-9]+(?:\.[0-9]+)*)?", lower)
                    or (lower.startswith("python") and lower.endswith((".exe", ".dll", ".zip", ".framework")))
                    or PurePosixPath(part).suffix.lower() in {".py", ".pyc", ".pyo", ".pyd"}):
                raise ValueError(f"APK contains embedded AI engines: {name}")
    return result


def bounded_member(archive: zipfile.ZipFile, member: zipfile.ZipInfo, maximum: int) -> bytes:
    if member.is_dir() or member.file_size > maximum:
        raise ValueError(f"APK resource exceeds its size limit or is not a regular file: {member.filename}")
    with archive.open(member) as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum or len(data) != member.file_size:
        raise ValueError(f"APK resource exceeds its size limit: {member.filename}")
    return data


def native_member(archive: zipfile.ZipFile, member: zipfile.ZipInfo, abi: str) -> str:
    if member.is_dir() or not member.file_size:
        raise ValueError("APK requires a regular nonempty native library")
    with archive.open(member) as stream:
        header = stream.read(64)
        if (len(header) != 64 or header[:7] != b"\x7fELF\x02\x01\x01"
                or struct.unpack_from("<HHI", header, 16) != (3, ABIS[abi][1], 1)
                or struct.unpack_from("<H", header, 52)[0] != 64):
            raise ValueError("APK native library must be an ELF64 shared library for the selected ABI")
        offset = struct.unpack_from("<Q", header, 32)[0]
        width, count = struct.unpack_from("<HH", header, 54)
        if (offset < 64 or width != 56 or not 1 <= count <= MAX_PROGRAM_HEADERS
                or offset + count * width > member.file_size):
            raise ValueError("APK native ELF program header table is invalid or exceeds its limit")
        stream.seek(offset)
        table = stream.read(count * width)
        if len(table) != count * width:
            raise ValueError("APK native ELF program header table is truncated")
        has_load = False
        for kind, _flags, file_offset, address, _physical, file_size, memory_size, alignment in struct.iter_unpack("<IIQQQQQQ", table):
            if kind not in {1, 0x6474E552}:  # PT_LOAD and GNU_RELRO; PT_NULL fields are undefined.
                continue
            if memory_size > MAX_ELF_ADDRESS - address:
                raise ValueError("APK native ELF segment address overflows")
            if kind == 1:
                has_load = True
                if file_size > memory_size or (file_size and file_offset + file_size > member.file_size):
                    raise ValueError("APK native ELF LOAD segment range is invalid")
                if (alignment < PAGE_SIZE or alignment & (alignment - 1)
                        or file_offset % alignment != address % alignment):
                    raise ValueError("APK native ELF LOAD segments require congruent 16 KiB alignment")
            elif (address + memory_size) % PAGE_SIZE:
                raise ValueError("APK native ELF RELRO end requires 16 KiB alignment")
        if not has_load:
            raise ValueError("APK native ELF requires a LOAD segment")
        stream.seek(0)
        digest = hashlib.sha256()
        total = 0
        while block := stream.read(1024 * 1024):
            total += len(block)
            if total > MAX_MEMBER_BYTES:
                raise ValueError("APK native library exceeds the size limit")
            digest.update(block)
    if total != member.file_size:
        raise ValueError("APK native library size does not match its archive entry")
    return digest.hexdigest()


def native_library(archive: zipfile.ZipFile, members: dict[str, zipfile.ZipInfo], abi: str) -> tuple[str, str]:
    native = f"lib/{abi}/libpractiq_desktop.so"
    platforms = {PurePosixPath(name).parts[1] for name, item in members.items()
                 if not item.is_dir() and name.startswith("lib/") and len(PurePosixPath(name).parts) >= 3}
    if platforms != {abi}:
        raise ValueError("APK native library ABI does not match the selected ABI")
    member = members.get(native)
    if member is None:
        raise ValueError("APK requires a regular nonempty native library")
    native_sha = native_member(archive, member, abi)
    for name, item in members.items():
        if name == native or item.is_dir() or not name.startswith(f"lib/{abi}/"):
            continue
        with archive.open(item) as stream:
            magic = stream.read(4)
        if name.endswith(".so") or magic == b"\x7fELF":
            native_member(archive, item, abi)
    return native, native_sha


def native_manifest(installer: Path, aapt2: Path, abi: str, version: str) -> dict:
    """Use the explicitly selected Android SDK to inspect its binary manifest."""
    output = subprocess.check_output([str(aapt2), "dump", "badging", str(installer)], text=True, encoding="utf-8", timeout=30)
    if len(output) > 1024 * 1024:
        raise ValueError("APK SDK manifest output exceeds the size limit")
    package = [line.removeprefix("package:").strip() for line in output.splitlines() if line.startswith("package:")]
    if len(package) != 1:
        raise ValueError("APK native package identity is missing or ambiguous")
    attributes = re.findall(r"([A-Za-z][A-Za-z0-9]*)='([^']*)'", package[0])
    if len({key for key, _value in attributes}) != len(attributes) or re.sub(r"[A-Za-z][A-Za-z0-9]*='[^']*'", "", package[0]).strip():
        raise ValueError("APK native package identity is malformed")
    values = dict(attributes)
    if values.get("name") != "com.practiq.android":
        raise ValueError("APK native package identity does not match com.practiq.android")
    if values.get("versionName") != version:
        raise ValueError("APK native version does not match the app candidate version")
    if not re.fullmatch(r"[1-9][0-9]*", values.get("versionCode", "")):
        raise ValueError("APK native versionCode must be a positive integer")
    sdk = [line for line in output.splitlines() if line.lstrip().startswith(("sdkVersion", "minSdkVersion"))]
    if len(sdk) != 1 or sdk[0] not in {"sdkVersion:'26'", "minSdkVersion:'26'"}:
        raise ValueError("APK native minSdk must be 26")
    target = [line for line in output.splitlines() if line.lstrip().startswith("targetSdkVersion")]
    if target != ["targetSdkVersion:'36'"]:
        raise ValueError("APK native targetSdk must be 36")
    architectures = [line.removeprefix("native-code:").strip() for line in output.splitlines() if line.startswith("native-code:")]
    if architectures != [f"'{abi}'"]:
        raise ValueError("APK SDK native ABI does not match the selected ABI")
    return {"identifier": values["name"], "versionName": values["versionName"],
            "versionCode": int(values["versionCode"]), "minSdkVersion": 26, "targetSdkVersion": 36}


def validate_apk(installer: Path, aapt2: Path, abi: str, version: str) -> dict:
    if abi not in ABIS:
        raise ValueError("Select arm64-v8a or x86_64 as the APK ABI")
    if not installer.is_file() or not installer.stat().st_size or installer.stat().st_size > MAX_APK_BYTES:
        raise ValueError("Selected APK must be a nonempty file within the size limit")
    with zipfile.ZipFile(installer) as archive:
        members = archive_entries(archive)
        resources = {name for name in members if name.startswith(BUNDLE)}
        if resources != RESOURCE_NAMES:
            raise ValueError("APK resources must contain only metadata and notices")
        manifest = json.loads(bounded_member(archive, members[BUNDLE + "build-manifest.json"], 65_536))
        validate_manifest(manifest, "android", version)
        if manifest["architecture"] != ABIS[abi][0]:
            raise ValueError("APK metadata architecture differs from the selected ABI")
        notices = bounded_member(archive, members[BUNDLE + "THIRD-PARTY.txt"], 32 * 1024 * 1024)
        if not notices:
            raise ValueError("APK notices are empty")
        executable, native_sha = native_library(archive, members, abi)
    identity = native_manifest(installer, aapt2, abi, version)
    return {"passed": True, "packageMode": manifest["packageMode"], "manifest": manifest,
            "embeddedAiEngines": [], "nativePackage": identity, "desktopVersion": identity["versionName"],
            "nativeExecutable": executable, "nativeAbi": abi, "nativeLibrarySha256": native_sha,
            "noticeSha256": hashlib.sha256(notices).hexdigest(), "sizeBytes": installer.stat().st_size}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--abi", choices=ABIS, required=True)
    parser.add_argument("--aapt2", type=Path, required=True)
    parser.add_argument("--expected-notices", type=Path, help="Fresh candidate notice file to compare with actual APK bytes")
    parser.add_argument("--retain-installer", type=Path, help="Fresh destination for the exact checked private APK bytes")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.output.is_symlink():
        raise FileExistsError(f"APK report already exists: {args.output}")
    if args.retain_installer is not None:
        if args.retain_installer.exists() or args.retain_installer.is_symlink():
            raise FileExistsError(f"Retained APK already exists: {args.retain_installer}")
        if args.retain_installer.resolve() == args.output.resolve():
            raise ValueError("Retained APK and report must use separate paths")
    aapt2 = args.aapt2.resolve(strict=True)
    if not aapt2.is_file():
        raise ValueError("Select an explicit Android SDK aapt2 executable")
    root = Path(__file__).resolve().parents[2]
    version = release.read_json(root / "app/package.json")["version"]
    installer = args.installer.resolve(strict=True)
    if not installer.is_file() or not installer.stat().st_size or installer.stat().st_size > MAX_APK_BYTES:
        raise ValueError("Selected APK must be a nonempty file within the size limit")
    retained_temporary = None
    try:
        with release.installer_snapshot(installer) as (snapshot, digest):
            report = validate_apk(snapshot, aapt2, args.abi, version)
            report["installerSha256"] = digest
            if args.expected_notices is not None:
                with args.expected_notices.open("rb") as expected:
                    notices = expected.read(32 * 1024 * 1024 + 1)
                if len(notices) > 32 * 1024 * 1024:
                    raise ValueError("Expected APK notices exceed the size limit")
                expected_sha = hashlib.sha256(notices).hexdigest()
                if report["noticeSha256"] != expected_sha:
                    raise ValueError("Actual APK notices differ from the expected candidate notices")
                report["expectedNoticeSha256"] = expected_sha
            if args.retain_installer is not None:
                args.retain_installer.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(prefix=".practiq-retained-", suffix=".apk", dir=args.retain_installer.parent, delete=False) as staged:
                    retained_temporary = Path(staged.name)
                shutil.copyfile(snapshot, retained_temporary)
                if release.checksum(retained_temporary) != digest:
                    raise ValueError("Retained APK copy differs from the checked snapshot")
                retained_temporary.chmod(0o444)
        if retained_temporary is not None:
            if args.retain_installer.exists() or args.retain_installer.is_symlink():
                raise FileExistsError(f"Retained APK already exists: {args.retain_installer}")
            if release.checksum(retained_temporary) != digest:
                raise ValueError("Retained APK copy changed before handoff")
            retained_temporary.rename(args.retain_installer)
            report["retainedInstallerSha256"] = digest
    finally:
        if retained_temporary is not None and retained_temporary.exists():
            retained_temporary.chmod(0o600)
            retained_temporary.unlink()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as output:
        json.dump(report, output, indent=2)
    print(json.dumps({"passed": True, "nativeAbi": args.abi, "embeddedAiEngines": []}))


if __name__ == "__main__":
    main()
