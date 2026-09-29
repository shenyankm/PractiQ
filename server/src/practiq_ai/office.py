"""Desktop-only LibreOffice worker. No HTTP endpoints, credentials or model calls."""

import csv
import hashlib
import io
import json
import os
import shutil
import signal
import stat
import struct
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from .extractors.isolated import _read_file, watch_parent

FILE_LIMIT = 25 * 1024 * 1024
TOTAL_LIMIT = 100 * 1024 * 1024
FILE_COUNT = 100
TIMEOUT = 180
FORMATS = {".doc": "writer", ".docx": "writer", ".xls": "calc", ".xlsx": "calc"}
_children: set[subprocess.Popen] = set()
_lock = threading.Lock()


class OfficeError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _stop(process: subprocess.Popen) -> None:
    try:
        if os.name == "nt":
            if process.poll() is None:
                process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def _stop_children() -> None:
    with _lock:
        for process in _children:
            _stop(process)


def _abandon() -> None:
    _stop_children()
    # Only the native host supplies this dedicated workspace; original inputs never live here.
    directory = Path(os.environ.get("PRACTIQ_OFFICE_WORKSPACE", ""))
    if directory.is_absolute() and directory.name.startswith("practiq-office-") and not directory.is_symlink():
        shutil.rmtree(directory, ignore_errors=True)


def _check_outputs(directory: Path, *, writing: bool = False) -> list[Path]:
    files = list(directory.iterdir())
    # Saving uses a temporary file and a lock; final output count is checked after exit.
    if len(files) > FILE_COUNT + (2 if writing else 0):
        raise OfficeError("OFFICE_OUTPUT_LIMIT")
    total = 0
    for path in files:
        try:
            info = path.lstat()
        except FileNotFoundError:
            if writing:
                continue  # LibreOffice atomically renamed a temporary output.
            raise
        if not stat.S_ISREG(info.st_mode):
            raise OfficeError("OFFICE_OUTPUT_INVALID")
        size = info.st_size
        if size > FILE_LIMIT:
            raise OfficeError("OFFICE_OUTPUT_LIMIT")
        total += size
    if total > TOTAL_LIMIT:
        raise OfficeError("OFFICE_OUTPUT_LIMIT")
    return sorted(files)


def _spawn(arguments: list[str], **options: Any) -> subprocess.Popen:
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return subprocess.Popen(arguments, **options)
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    setter = kernel.SetDllDirectoryW
    setter.argtypes = [wintypes.LPCWSTR]
    setter.restype = wintypes.BOOL
    if not setter(None):
        raise OSError("Cannot restore system DLL search path")
    try:
        return subprocess.Popen(arguments, **options)
    finally:
        # The private worker still needs its bundled libraries for PDF validation.
        setter(vars(sys)["_MEIPASS"])


def _run(arguments: list[str], deadline: float, output: Path | None = None) -> bytes:
    # Logs can contain source text. Keep them out of diagnostics and limit version output.
    with TemporaryDirectory(prefix="practiq-office-log-") as directory:
        log = Path(directory) / "version"
        with log.open("wb") as stream:
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("AI_", "LLM_", "DATABASE_"))}
            # LibreOffice embeds Python; bytecode writes would invalidate signed resources.
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            if getattr(sys, "frozen", False):
                if sys.platform == "linux":
                    env["LD_LIBRARY_PATH"] = env.get("LD_LIBRARY_PATH_ORIG", "")
                root = Path(vars(sys)["_MEIPASS"]).resolve()
                for key in ("PATH", "DYLD_LIBRARY_PATH"):
                    if key in env:
                        env[key] = os.pathsep.join(part for part in env[key].split(os.pathsep)
                                                   if not part or not Path(part).resolve().is_relative_to(root))
            if sys.platform == "darwin":
                # Native CoreText finds macOS fonts; generic headless VCL can omit CJK glyphs.
                env.setdefault("SAL_USE_VCLPLUGIN", "osx")
            with _lock:
                process = _spawn(arguments, stdin=subprocess.DEVNULL,
                                           stdout=stream if output is None else subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, env=env,
                                           start_new_session=os.name != "nt",
                                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                _children.add(process)
            try:
                while process.poll() is None:
                    if time.monotonic() >= deadline:
                        raise OfficeError("OFFICE_TIMEOUT")
                    if output is not None:
                        _check_outputs(output, writing=True)
                    elif log.stat().st_size > 65536:
                        raise OfficeError("OFFICE_ENGINE_INVALID")
                    time.sleep(0.05)
                if process.returncode:
                    raise OfficeError("OFFICE_CONVERSION_FAILED")
            finally:
                with _lock:
                    _stop(process)
                    _children.discard(process)
        return _read_file(log, 65536) if output is None else b""


def _profile(directory: Path) -> Path:
    profile = directory / "profile"
    (profile / "user").mkdir(parents=True)
    # Never inherit the user's trusted macro locations or link-update preferences.
    # Native exports need no Python; its LO 26.8 loader fails under Unicode Linux paths.
    (profile / "user/registrymodifications.xcu").write_text('''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse" oor:finalized="true"><value>true</value></prop><prop oor:name="DisablePythonRuntime" oor:op="fuse" oor:finalized="true"><value>true</value></prop><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse" oor:finalized="true"><value>true</value></prop><prop oor:name="SecureURL" oor:op="fuse" oor:finalized="true"><value/></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse" oor:finalized="true"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse" oor:finalized="true"><value>0</value></prop><prop oor:name="Field" oor:op="fuse"><value>false</value></prop><prop oor:name="Chart" oor:op="fuse"><value>false</value></prop></item>
</oor:items>''', encoding="utf-8")
    return profile


def _export(engine: Path, source: Path, output: Path, family: str, mode: str, deadline: float) -> list[dict[str, Any]]:
    output.mkdir()
    filters = {("writer", "pdf"): "pdf:writer_pdf_Export", ("calc", "pdf"): "pdf:calc_pdf_Export",
               ("writer", "text"): "txt:Text (encoded):UTF8",
               ("calc", "text"): "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false,-1"}
    with TemporaryDirectory(prefix="practiq-office-profile-") as directory:
        profile = _profile(Path(directory))
        _run([str(engine), f"-env:UserInstallation={profile.as_uri()}", "--headless", "--norestore",
              "--convert-to", filters[family, mode], "--outdir", str(output), str(source)], deadline, output)
    suffix = ".pdf" if mode == "pdf" else ".txt" if family == "writer" else ".csv"
    files = _check_outputs(output)
    if not files:
        raise OfficeError("OFFICE_CONVERSION_FAILED")
    artifacts = []
    for path in files:
        if path.suffix.lower() != suffix:
            raise OfficeError("OFFICE_OUTPUT_INVALID")
        data = _read_file(path, FILE_LIMIT)
        has_content = True
        if suffix == ".pdf":
            import pypdfium2 as pdfium
            try:
                with pdfium.PdfDocument(data) as document:
                    if not 0 < len(document) <= 100:
                        raise OfficeError("OFFICE_OUTPUT_LIMIT")
            except OfficeError:
                raise
            except Exception as exc:
                raise OfficeError("OFFICE_OUTPUT_INVALID") from exc
        else:
            try:
                text = data.decode("utf-8-sig")
                has_content = bool(text.strip())
                if suffix == ".csv":
                    has_content = False
                    for row in csv.reader(io.StringIO(text), strict=True):
                        has_content |= any(cell.strip() for cell in row)
            except (UnicodeError, csv.Error) as exc:
                raise OfficeError("OFFICE_OUTPUT_INVALID") from exc
        artifacts.append({"name": path.name, "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "hasContent": has_content})
    return artifacts


WRITER_PROBE = '''<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:mimetype="application/vnd.oasis.opendocument.text" office:version="1.2"><office:body><office:text><text:p>PractiQ 中文 001</text:p></office:text></office:body></office:document>'''
CALC_PROBE = '''<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:mimetype="application/vnd.oasis.opendocument.spreadsheet" office:version="1.2"><office:body><office:spreadsheet><table:table table:name="中文"><table:table-row><table:table-cell office:value-type="string"><text:p>001</text:p></table:table-cell></table:table-row></table:table><table:table table:name="Second"><table:table-row><table:table-cell office:value-type="string"><text:p>PractiQ</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document>'''


def engine_version(engine: Path, deadline: float) -> str:
    version = _run([str(engine), "--version"], min(deadline, time.monotonic() + 10)).decode("utf-8", errors="replace").strip()
    if not version.startswith(("LibreOffice ", "LibreOfficeDev ")):
        raise OfficeError("OFFICE_ENGINE_INVALID")
    return version


def detect(engine: str) -> dict[str, Any]:
    path = Path(engine)
    if not path.is_absolute() or not path.is_file():
        raise OfficeError("OFFICE_NOT_FOUND")
    deadline = time.monotonic() + TIMEOUT
    try:
        version = engine_version(path, deadline)
    except (OSError, OfficeError) as exc:
        raise OfficeError("OFFICE_ENGINE_INVALID") from exc
    status: dict[str, Any] = {"path": str(path), "version": version, "capabilities": {}, "errors": {}}
    with TemporaryDirectory(prefix="practiq-office-probe-") as directory:
        root = Path(directory)
        for family, extension, text in (("writer", "fodt", WRITER_PROBE), ("calc", "fods", CALC_PROBE)):
            source = root / f"probe.{extension}"
            source.write_text(text, encoding="utf-8")
            for mode in ("pdf", "text"):
                key = f"{family}_{mode}"
                try:
                    artifacts = _export(path, source, root / key, family, mode, deadline)
                    if family == "calc" and mode == "text" and len(artifacts) != 2:
                        raise OfficeError("OFFICE_SHEETS_UNSUPPORTED")
                    status["capabilities"][key] = True
                except (OSError, OfficeError) as exc:
                    status["capabilities"][key] = False
                    status["errors"][key] = exc.code if isinstance(exc, OfficeError) else "OFFICE_CONVERSION_FAILED"
    return status


def _validate_legacy(data: bytes, family: str) -> None:
    """Check bounded CFB directory metadata, not document content or embedded OLE objects."""
    try:
        if len(data) < 512 or data[:8] != bytes.fromhex("d0cf11e0a1b11ae1"):
            raise ValueError("Not a compound file")
        version, order, shift = struct.unpack_from("<HHH", data, 26)
        if (version, shift) not in ((3, 9), (4, 12)) or order != 0xfffe:
            raise ValueError("Invalid sector format")
        size = 1 << shift
        sectors = len(data) // size - 1
        if len(data) % size or sectors < 1:
            raise ValueError("Truncated compound file")

        def sector(index: int) -> bytes:
            if not 0 <= index < sectors:
                raise ValueError("Sector outside input")
            return data[(index + 1) * size:(index + 2) * size]

        fat_count, directory_start = struct.unpack_from("<II", data, 44)
        difat_start, difat_count = struct.unpack_from("<II", data, 68)
        if not 0 < fat_count <= sectors or difat_count > sectors:
            raise ValueError("Invalid allocation count")
        fat_sectors = [s for s in struct.unpack_from("<109I", data, 76) if s != 0xffffffff]
        seen = set()
        for _ in range(difat_count):
            if difat_start in seen:
                raise ValueError("Cyclic DIFAT")
            seen.add(difat_start)
            values = struct.unpack(f"<{size // 4}I", sector(difat_start))
            fat_sectors.extend(s for s in values[:-1] if s != 0xffffffff)
            if len(fat_sectors) > fat_count:
                raise ValueError("Oversized DIFAT")
            difat_start = values[-1]
        if len(fat_sectors) != fat_count or len(set(fat_sectors)) != fat_count:
            raise ValueError("Invalid FAT")
        fat = b"".join(sector(index) for index in fat_sectors)
        directory = bytearray()
        seen.clear()
        while directory_start != 0xfffffffe:
            if directory_start in seen or directory_start >= len(fat) // 4:
                raise ValueError("Invalid directory chain")
            seen.add(directory_start)
            directory.extend(sector(directory_start))
            directory_start = struct.unpack_from("<I", fat, directory_start * 4)[0]
        if len(directory) < 128 or directory[66] != 5:
            raise ValueError("Missing root storage")

        # Only root children identify the document; embedded Word/Excel streams do not.
        pending = [struct.unpack_from("<I", directory, 76)[0]]
        names: dict[str, int] = {}
        seen.clear()
        while pending:
            index = pending.pop()
            if index == 0xffffffff:
                continue
            if index in seen or index >= len(directory) // 128:
                raise ValueError("Invalid directory tree")
            seen.add(index)
            entry = directory[index * 128:(index + 1) * 128]
            length = struct.unpack_from("<H", entry, 64)[0]
            if not 2 <= length <= 64 or length % 2 or entry[length-2:length] != b"\0\0" or entry[66] not in (1, 2):
                raise ValueError("Invalid directory entry")
            name = entry[:length-2].decode("utf-16-le").casefold()
            if not name or "\0" in name or name in names:
                raise ValueError("Invalid stream name")
            names[name] = entry[66]
            pending.extend(struct.unpack_from("<II", entry, 68))
        streams = {name for name, kind in names.items() if kind == 2}
        required = ({"worddocument"} <= streams and bool({"0table", "1table"} & streams)
                    if family == "writer" else bool({"workbook", "book"} & streams))
        if not required or {"encryptioninfo", "encryptedpackage"} & streams:
            raise ValueError("Wrong or encrypted document family")
    except (ValueError, struct.error) as exc:
        raise OfficeError("OFFICE_INPUT_INVALID") from exc


def convert(engine: str, source: Path, output: Path, mode: str, *, expected_version: str | None = None) -> list[dict[str, Any]]:
    family = FORMATS.get(source.suffix.lower())
    if family is None or mode not in ("pdf", "text"):
        raise OfficeError("OFFICE_FORMAT_UNSUPPORTED")
    if source.is_symlink():
        raise OfficeError("OFFICE_INPUT_INVALID")
    data = _read_file(source, FILE_LIMIT)
    if source.suffix.lower() in (".doc", ".xls"):
        _validate_legacy(data, family)
    else:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                names = archive.namelist()
                required = "word/document.xml" if family == "writer" else "xl/workbook.xml"
                if (required not in names or "[Content_Types].xml" not in names
                        or len(entries) > 10000 or sum(entry.file_size for entry in entries) > TOTAL_LIMIT
                        or any(entry.flag_bits & 1 or entry.filename.lower().endswith("vbaproject.bin") for entry in entries)):
                    raise OfficeError("OFFICE_INPUT_INVALID")
        except zipfile.BadZipFile as exc:
            raise OfficeError("OFFICE_INPUT_INVALID") from exc
    deadline = time.monotonic() + TIMEOUT
    if expected_version is not None and engine_version(Path(engine), deadline) != expected_version:
        raise OfficeError("OFFICE_ENGINE_INVALID")
    return _export(Path(engine), source, output, family, mode, deadline)


def main() -> None:
    if os.name == "nt":
        from .extractors.windows_job import protect_descendants
        protect_descendants()
    raw = sys.stdin.buffer.readline(65537)
    watch_parent(_abandon)
    try:
        if len(raw) > 65536:
            raise OfficeError("OFFICE_INPUT_INVALID")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise OfficeError("OFFICE_INPUT_INVALID")
        if request.get("type") == "detect" and set(request) == {"type", "engine"}:
            if not isinstance(request["engine"], str):
                raise OfficeError("OFFICE_INPUT_INVALID")
            result = detect(request["engine"])
        elif request.get("type") == "convert" and set(request) == {"type", "engine", "version", "source", "output", "mode"}:
            if any(not isinstance(request[key], str) for key in ("engine", "version", "source", "output", "mode")):
                raise OfficeError("OFFICE_INPUT_INVALID")
            result = {"artifacts": convert(request["engine"], Path(request["source"]), Path(request["output"]), request["mode"], expected_version=request["version"])}
        else:
            raise OfficeError("OFFICE_INPUT_INVALID")
        print(json.dumps({"result": result}), flush=True)
    except (OfficeError, OSError, ValueError, TypeError) as exc:
        print(json.dumps({"error": exc.code if isinstance(exc, OfficeError) else "OFFICE_CONVERSION_FAILED"}), flush=True)
    finally:
        _stop_children()


if __name__ == "__main__":
    main()
