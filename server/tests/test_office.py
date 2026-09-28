"""Local conversion checks never use a model or a running HTTP service."""
import io
import json
import os
import struct
import subprocess
import sys
import time
import zipfile
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

from practiq_ai import office


def test_custom_application_and_path_discovery(tmp_path, monkeypatch):
    assert office.candidates(str(tmp_path / "LibreOffice.app")) == [tmp_path / "LibreOffice.app/Contents/MacOS/soffice"]
    executable = tmp_path / "soffice"
    executable.touch()
    monkeypatch.setattr(office.shutil, "which", lambda name: str(executable))
    monkeypatch.setattr(office.sys, "platform", "darwin")
    assert executable in office.candidates()
    assert office.candidates(str(executable)) == [executable]


def test_windows_registry_and_console_executable(tmp_path, monkeypatch):
    program = tmp_path / "Program Files" / "LibreOffice" / "program"
    program.mkdir(parents=True)
    executable = program / "soffice.com"
    executable.touch()
    registry = SimpleNamespace(HKEY_CURRENT_USER=1, HKEY_LOCAL_MACHINE=2, KEY_WOW64_64KEY=4,
                               KEY_WOW64_32KEY=8, KEY_READ=16,
                               OpenKey=lambda *args: nullcontext(),
                               QueryValueEx=lambda *args: (str(program), 1))
    monkeypatch.setitem(sys.modules, "winreg", registry)
    monkeypatch.setattr(office.sys, "platform", "win32")
    monkeypatch.setattr(office.shutil, "which", lambda name: None)
    assert executable in office.candidates()
    assert office.candidates(str(program / "soffice.exe")) == [executable]


def test_discovery_reports_no_installation_without_model_settings(monkeypatch):
    monkeypatch.delenv("AI_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(office, "candidates", lambda preferred: [])
    result = office.detect()
    assert result["path"] is None
    assert not any(result["capabilities"].values())


def test_discovery_verifies_each_capability_and_rejects_first_sheet_only(tmp_path, monkeypatch):
    monkeypatch.setattr(office, "candidates", lambda preferred: [tmp_path / "missing", tmp_path / "fake", tmp_path / "soffice"])
    def run(args, *unused):
        if args[0].endswith("missing"):
            raise OSError("missing")
        return b"Not LibreOffice" if args[0].endswith("fake") else b"LibreOffice 26.2"
    monkeypatch.setattr(office, "_run", run)
    def export(engine, source, output, family, mode, deadline):
        if family == "writer" and mode == "pdf":
            raise office.OfficeError("OFFICE_CONVERSION_FAILED")
        return [{}]
    monkeypatch.setattr(office, "_export", export)
    result = office.detect()
    assert result["capabilities"] == {"writer_pdf": False, "writer_text": True, "calc_pdf": True, "calc_text": False}
    assert result["errors"]["calc_text"] == "OFFICE_SHEETS_UNSUPPORTED"
    monkeypatch.setattr(office, "_export", lambda *args: [{}, {}])
    assert all(office.detect()["capabilities"].values())


@pytest.mark.parametrize("mode,family,suffix", [("text", "writer", "txt"), ("text", "calc", "csv"), ("pdf", "writer", "pdf")])
def test_export_validates_content_and_uses_private_profile(tmp_path, monkeypatch, mode, family, suffix):
    def run(args, deadline, output):
        assert "--headless" in args and "--norestore" in args
        profile = next(arg for arg in args if arg.startswith("-env:UserInstallation="))
        assert "profile" in profile
        if suffix == "pdf":
            from PIL import Image
            Image.new("RGB", (24, 24)).save(output / "source.pdf", "PDF")
        else:
            (output / f"source.{suffix}").write_text('"中文","001"\n', encoding="utf-8")
        return b""
    monkeypatch.setattr(office, "_run", run)
    monkeypatch.delenv("AI_SERVICE_TOKEN", raising=False)
    result = office._export(Path("soffice"), tmp_path / "source.docx", tmp_path / "out", family, mode, time.monotonic() + 10)
    assert result[0]["sizeBytes"] > 0 and len(result[0]["sha256"]) == 64
    profile = office._profile(tmp_path)
    text = (profile / "user/registrymodifications.xcu").read_text()
    assert 'DisableMacrosExecution' in text and 'BlockUntrustedRefererLinks' in text
    assert 'Calc/Content/Update"><prop oor:name="Link" oor:op="fuse" oor:finalized="true"><value>1' in text
    assert 'Writer/Content/Update"><prop oor:name="Link" oor:op="fuse" oor:finalized="true"><value>0' in text


@pytest.mark.parametrize("name,data,code", [("source.pdf", b"bad", "OFFICE_OUTPUT_INVALID"), ("source.txt", b"\xff", "OFFICE_OUTPUT_INVALID"), ("source.exe", b"bad", "OFFICE_OUTPUT_INVALID"), (None, b"", "OFFICE_CONVERSION_FAILED")])
def test_zero_exit_is_not_success_without_valid_output(tmp_path, monkeypatch, name, data, code):
    def run(args, deadline, output):
        if name:
            (output / name).write_bytes(data)
    monkeypatch.setattr(office, "_run", run)
    mode = "pdf" if name and name.endswith("pdf") else "text"
    with pytest.raises(office.OfficeError, match=code):
        office._export(Path("soffice"), tmp_path / "source.docx", tmp_path / "out", "writer", mode, time.monotonic() + 10)


def test_output_bounds_and_non_regular_files(tmp_path, monkeypatch):
    (tmp_path / "one").write_bytes(b"123")
    monkeypatch.setattr(office, "FILE_LIMIT", 2)
    with pytest.raises(office.OfficeError, match="OFFICE_OUTPUT_LIMIT"):
        office._check_outputs(tmp_path)
    monkeypatch.setattr(office, "FILE_LIMIT", 5)
    monkeypatch.setattr(office, "TOTAL_LIMIT", 2)
    with pytest.raises(office.OfficeError, match="OFFICE_OUTPUT_LIMIT"):
        office._check_outputs(tmp_path)
    monkeypatch.setattr(office, "TOTAL_LIMIT", 20)
    (tmp_path / "folder").mkdir()
    with pytest.raises(office.OfficeError, match="OFFICE_OUTPUT_INVALID"):
        office._check_outputs(tmp_path)
    monkeypatch.setattr(office, "FILE_COUNT", 1)
    with pytest.raises(office.OfficeError, match="OFFICE_OUTPUT_LIMIT"):
        office._check_outputs(tmp_path)


def test_temporary_output_rename_is_tolerated_only_while_running(tmp_path, monkeypatch):
    path = tmp_path / "temporary.tmp"
    path.touch()
    def gone(self):
        raise FileNotFoundError()
    with monkeypatch.context() as patch:
        patch.setattr(Path, "lstat", gone)
        office._check_outputs(tmp_path, writing=True)
        with pytest.raises(FileNotFoundError):
            office._check_outputs(tmp_path)
    if os.name != "nt":
        path.unlink()
        path.symlink_to(tmp_path.parent)
        with pytest.raises(office.OfficeError, match="OFFICE_OUTPUT_INVALID"):
            office._check_outputs(tmp_path)


def test_run_reaps_timeout_and_nonzero_exit(tmp_path, monkeypatch):
    with pytest.raises(office.OfficeError, match="OFFICE_TIMEOUT"):
        office._run([sys.executable, "-c", "import time; time.sleep(30)"], time.monotonic() + .1)
    assert not office._children
    with pytest.raises(office.OfficeError, match="OFFICE_CONVERSION_FAILED"):
        office._run([sys.executable, "-c", "raise SystemExit(1)"], time.monotonic() + 10)
    assert not office._children
    assert b"hello" in office._run([sys.executable, "-c", "print('hello')"], time.monotonic() + 10)
    monkeypatch.setenv("LLM_API_KEY", "must-not-reach-office")
    result = office._run([sys.executable, "-c", "import os; print(os.getenv('LLM_API_KEY', 'absent'))"], time.monotonic() + 10)
    assert result.strip() == b"absent"


def test_frozen_worker_external_process_uses_system_library_environment(tmp_path, monkeypatch):
    bundle = tmp_path / "bundled"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(bundle), raising=False)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("LD_LIBRARY_PATH", str(bundle))
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/system/libraries")
    monkeypatch.setenv("PATH", os.pathsep.join([str(bundle), "/usr/bin"]))
    code = "import os,json; print(json.dumps([os.getenv('LD_LIBRARY_PATH'),os.getenv('PATH')]))"
    assert json.loads(office._run([sys.executable, "-c", code], time.monotonic()+10)) == ["/system/libraries", "/usr/bin"]
    assert os.environ["LD_LIBRARY_PATH"] == str(bundle)


def test_windows_frozen_dll_search_is_restored_after_spawn_failure(monkeypatch):
    import ctypes
    calls = []
    def setter(value):
        calls.append(value)
        return True
    monkeypatch.setattr(ctypes, "WinDLL", lambda *args, **kwargs: SimpleNamespace(SetDllDirectoryW=setter), raising=False)
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", "private-bundle", raising=False)
    def missing(*args, **kwargs):
        raise FileNotFoundError()
    monkeypatch.setattr(office.subprocess, "Popen", missing)
    with pytest.raises(FileNotFoundError):
        office._spawn(["missing"])
    assert calls == [None, "private-bundle"]


@pytest.mark.parametrize("extension", ["doc", "docx", "xls", "xlsx", "docm", "xlsm", "xlsb"])
def test_invalid_office_input_never_launches_engine(tmp_path, monkeypatch, extension):
    source = tmp_path / f"source.{extension}"
    source.write_bytes(b"not an Office file")
    monkeypatch.setattr(office, "_export", lambda *args: pytest.fail("must reject before starting LibreOffice"))
    with pytest.raises(office.OfficeError):
        office.convert("unused", source, tmp_path / "out", "text")


def test_office_input_checks_package_members_and_macro_payload(tmp_path, monkeypatch):
    source = tmp_path / "测试 file.docx"
    monkeypatch.setattr(office, "_export", lambda *args: [{"name": "source.txt"}])
    def write(macro=False):
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("[Content_Types].xml", "test")
            archive.writestr("word/document.xml", "test")
            if macro:
                archive.writestr("word/vbaProject.bin", "macro")
    write()
    before = source.read_bytes()
    monkeypatch.setattr(office, "_run", lambda *args: b"LibreOffice 26.2")
    assert office.convert("unused", source, tmp_path / "out", "text", expected_version="LibreOffice 26.2")
    with pytest.raises(office.OfficeError, match="OFFICE_ENGINE_INVALID"):
        office.convert("unused", source, tmp_path / "out", "text", expected_version="LibreOffice 25.8")
    assert office.convert("unused", source, tmp_path / "out", "text")[0]["name"] == "source.txt"
    assert source.read_bytes() == before
    write(True)
    with pytest.raises(office.OfficeError, match="OFFICE_INPUT_INVALID"):
        office.convert("unused", source, tmp_path / "out", "text")
    write()
    monkeypatch.setattr(office, "TOTAL_LIMIT", 1)
    with pytest.raises(office.OfficeError, match="OFFICE_INPUT_INVALID"):
        office.convert("unused", source, tmp_path / "out", "text")


@pytest.mark.parametrize("suffix", ["docx", "xlsx"])
def test_encrypted_ooxml_container_is_rejected_without_password_prompt(tmp_path, monkeypatch, suffix):
    source = tmp_path / f"encrypted.{suffix}"
    # Encrypted OOXML uses an OLE container instead of a ZIP package.
    source.write_bytes(bytes.fromhex("d0cf11e0a1b11ae1") + b"EncryptionInfo\0EncryptedPackage")
    monkeypatch.setattr(office, "_export", lambda *args: pytest.fail("encrypted input must not launch Office"))
    with pytest.raises(office.OfficeError, match="OFFICE_INPUT_INVALID"):
        office.convert("unused", source, tmp_path / "out", "pdf")


def test_empty_sheets_are_exportable_but_identified_before_ai_submission(tmp_path, monkeypatch):
    def run(args, deadline, output):
        (output / "source-empty.csv").write_bytes(b'"",,\n')
        (output / "source-zero.csv").write_bytes(b'0\n')
    monkeypatch.setattr(office, "_run", run)
    result = office._export(Path("soffice"), tmp_path / "source.xlsx", tmp_path / "out", "calc", "text", time.monotonic()+10)
    assert [item["hasContent"] for item in result] == [False, True]


def test_parent_eof_reaps_only_its_office_process(tmp_path):
    marker = tmp_path / "child.json"
    workspace = tmp_path / "practiq-office-owned"
    workspace.mkdir()
    (workspace / "source.docx").write_bytes(b"private snapshot")
    child_code = "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(120)"
    probe = """
import sys,time
from practiq_ai import office
def slow(preferred):
    return office._run([sys.executable, '-c', sys.argv[1], sys.argv[2]], time.monotonic()+60)
office.detect=slow
office.main()
"""
    worker = subprocess.Popen([sys.executable, "-c", probe, child_code, str(marker)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              env={**os.environ, "PRACTIQ_OFFICE_WORKSPACE": str(workspace)})
    unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    try:
        assert worker.stdin is not None
        worker.stdin.write(b'{"type":"detect","preferred":null}\n')
        worker.stdin.flush()
        deadline = time.monotonic()+15
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(.05)
        assert marker.exists()
        pid = int(marker.read_text())
        worker.stdin.close()
        assert worker.wait(timeout=10) == 70
        assert not workspace.exists() and marker.exists()
        assert unrelated.poll() is None
        if os.name != "nt":
            with pytest.raises(ProcessLookupError):
                os.kill(pid, 0)
        # Windows process-tree termination is additionally exercised by Job Object CI tests.
    finally:
        if worker.poll() is None:
            worker.kill()
        worker.wait()
        unrelated.kill()
        unrelated.wait()


@pytest.mark.parametrize("payload", [{}, [], {"type": "detect", "preferred": 3}, {"type": "convert", "engine": 1, "version": "x", "source": "x", "output": "y", "mode": "pdf"}])
def test_private_worker_rejects_malformed_requests(payload, monkeypatch, capsys):
    monkeypatch.setattr(office.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(payload).encode() + b"\n")))
    monkeypatch.setattr(office, "watch_parent", lambda cleanup: None)
    if os.name == "nt":
        from practiq_ai.extractors import windows_job
        monkeypatch.setattr(windows_job, "protect_descendants", lambda: None)
    office.main()
    assert json.loads(capsys.readouterr().out)["error"] == "OFFICE_INPUT_INVALID"


def test_private_worker_detection_has_no_service_bootstrap(monkeypatch, capsys):
    monkeypatch.setattr(office.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b'{"type":"detect","preferred":null}\n')))
    monkeypatch.setattr(office, "watch_parent", lambda cleanup: None)
    monkeypatch.setattr(office, "detect", lambda preferred: {"path": None})
    if os.name == "nt":
        from practiq_ai.extractors import windows_job
        monkeypatch.setattr(windows_job, "protect_descendants", lambda: None)
    office.main()
    assert json.loads(capsys.readouterr().out) == {"result": {"path": None}}


def test_private_conversion_requires_and_forwards_the_detected_version(monkeypatch, capsys):
    request = {"type": "convert", "engine": "soffice", "version": "LibreOffice 26.2", "source": "source.docx", "output": "output", "mode": "text"}
    monkeypatch.setattr(office.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode() + b"\n")))
    monkeypatch.setattr(office, "watch_parent", lambda cleanup: None)
    def convert(engine, source, output, mode, *, expected_version):
        assert (engine, source, output, mode, expected_version) == ("soffice", Path("source.docx"), Path("output"), "text", "LibreOffice 26.2")
        return [{"name": "source.txt"}]
    monkeypatch.setattr(office, "convert", convert)
    if os.name == "nt":
        from practiq_ai.extractors import windows_job
        monkeypatch.setattr(windows_job, "protect_descendants", lambda: None)
    office.main()
    assert json.loads(capsys.readouterr().out) == {"result": {"artifacts": [{"name": "source.txt"}]}}


@pytest.mark.parametrize("extension,family", [("doc", "writer"), ("xls", "calc")])
def test_legacy_input_checks_root_stream_family_before_launch(tmp_path, monkeypatch, extension, family):
    fixtures = Path(__file__).parents[2] / "app/fixtures/office"
    original = next(fixtures.glob(f"*.{extension}")).read_bytes()
    source = tmp_path / f"selected.{extension}"
    source.write_bytes(original)
    monkeypatch.setattr(office, "_export", lambda *args: [{"name": "converted"}])
    assert office.convert("unused", source, tmp_path / "out", "pdf")
    assert source.read_bytes() == original
    # A real Word container renamed to XLS (and vice versa) is not accepted.
    other = next(fixtures.glob("*.xls" if extension == "doc" else "*.doc")).read_bytes()
    monkeypatch.setattr(office, "_export", lambda *args: pytest.fail("wrong family reached LibreOffice"))
    for data in [other, original[:512], original[:512] + b"truncated"]:
        source.write_bytes(data)
        with pytest.raises(office.OfficeError, match="OFFICE_INPUT_INVALID"):
            office.convert("unused", source, tmp_path / "out", "pdf")


def compound_directory(names, *, nested=False):
    """Minimal CFB metadata fixture; no document parser or Office program is needed."""
    header = bytearray(512)
    header[:8] = bytes.fromhex("d0cf11e0a1b11ae1")
    struct.pack_into("<HHHH", header, 24, 0x3e, 3, 0xfffe, 9)
    struct.pack_into("<III", header, 40, 0, 1, 1)
    struct.pack_into("<II", header, 68, 0xfffffffe, 0)
    struct.pack_into("<109I", header, 76, 0, *([0xffffffff] * 108))
    fat = struct.pack("<128I", 0xfffffffd, 0xfffffffe, *([0xffffffff] * 126))
    directory = bytearray(512)
    for i, name in enumerate(["Root Entry", *names]):
        encoded = (name + "\0").encode("utf-16-le")
        directory[i*128:i*128+len(encoded)] = encoded
        struct.pack_into("<HBBIII", directory, i*128+64, len(encoded), 5 if i == 0 else 1 if nested and i == 1 else 2, 1,
                         0xffffffff, i+1 if i and i < len(names) and not nested else 0xffffffff,
                         1 if i == 0 else 2 if nested and i == 1 else 0xffffffff)
    return header + fat + directory


@pytest.mark.parametrize("names,nested", [(["PowerPoint Document"], False), (["EncryptionInfo", "EncryptedPackage"], False), (["WordDocument"], False), (["Embedded", "WordDocument", "0Table"], True)])
def test_unrelated_or_encrypted_compound_containers_are_rejected(names, nested):
    data = compound_directory(names, nested=nested)
    for family in ("writer", "calc"):
        with pytest.raises(office.OfficeError, match="OFFICE_INPUT_INVALID"):
            office._validate_legacy(bytes(data), family)


@pytest.mark.parametrize("offset,packed", [(28, b"xx"), (44, struct.pack("<I", 9999)), (48, struct.pack("<I", 9999)),
                                          (512+4, struct.pack("<I", 1)), (1024+76, struct.pack("<I", 9999)),
                                          (1024+128+72, struct.pack("<I", 1)), (1024+128+64, b"\x41\x00")])
def test_malformed_compound_allocation_and_directory_are_bounded(offset, packed):
    data = compound_directory(["WordDocument", "0Table"])
    data[offset:offset+len(packed)] = packed
    with pytest.raises(office.OfficeError, match="OFFICE_INPUT_INVALID"):
        office._validate_legacy(bytes(data), "writer")
