"""Local conversion checks never use a model or a running HTTP service."""
import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from practiq_ai import office


def test_legacy_doc_pdf_preserves_source_and_uses_private_normalized_snapshot(tmp_path, monkeypatch):
    engine = tmp_path / 'bundled' / 'soffice'
    source = Path(__file__).parents[2] / 'app/fixtures/office/中文 试卷.doc'
    docx = source.with_suffix('.docx').read_bytes()
    original, metadata = source.read_bytes(), source.stat()
    calls = []
    snapshots = []

    def run(args, deadline, output):
        assert args[0] == str(engine)
        assert '--headless' in args and '--norestore' in args
        profile = next(arg for arg in args if arg.startswith('-env:UserInstallation='))
        calls.append((profile, deadline))
        if len(calls) == 1:
            assert args[-1] == str(source)
            assert args[args.index('--convert-to') + 1] == 'docx:Office Open XML Text'
            (output / source.with_suffix('.docx').name).write_bytes(docx)
        else:
            from PIL import Image
            snapshot = Path(args[-1])
            assert snapshot != source and snapshot.suffix == '.docx' and snapshot.read_bytes() == docx
            assert output == tmp_path / 'out'
            assert args[args.index('--convert-to') + 1] == 'pdf:writer_pdf_Export'
            snapshots.append(snapshot)
            Image.new('RGB', (24, 24)).save(output / source.with_suffix('.pdf').name, 'PDF')

    monkeypatch.setattr(office, '_run', run)
    artifacts = office.convert(str(engine), source, tmp_path / 'out', 'pdf')
    assert len(artifacts) == 1 and artifacts[0]['name'] == source.with_suffix('.pdf').name
    assert artifacts[0]['sha256'] == hashlib.sha256((tmp_path / 'out' / artifacts[0]['name']).read_bytes()).hexdigest()
    assert len(calls) == 2 and calls[0][0] != calls[1][0] and calls[0][1] == calls[1][1]
    assert len(snapshots) == 1 and not snapshots[0].exists()
    assert source.read_bytes() == original
    assert (source.stat().st_size, source.stat().st_mtime_ns) == (metadata.st_size, metadata.st_mtime_ns)


@pytest.mark.parametrize('case,code', [
    ('missing', 'OFFICE_CONVERSION_FAILED'), ('wrong_name', 'OFFICE_OUTPUT_INVALID'),
    ('extra', 'OFFICE_OUTPUT_INVALID'), ('directory', 'OFFICE_OUTPUT_INVALID'),
    ('bad_zip', 'OFFICE_OUTPUT_INVALID'), ('missing_members', 'OFFICE_OUTPUT_INVALID'),
    ('macro', 'OFFICE_OUTPUT_INVALID'), ('oversized', 'OFFICE_OUTPUT_LIMIT'),
    ('expanded', 'OFFICE_OUTPUT_INVALID'),
    ('bad_crc', 'OFFICE_OUTPUT_INVALID'), ('bad_image_crc', 'OFFICE_OUTPUT_INVALID'),
    ('bad_xml', 'OFFICE_OUTPUT_INVALID'), ('bad_utf16_xml', 'OFFICE_OUTPUT_INVALID'),
    ('doctype', 'OFFICE_OUTPUT_INVALID'), ('doctype_utf16', 'OFFICE_OUTPUT_INVALID'),
    ('duplicate', 'OFFICE_OUTPUT_INVALID'),
])
def test_legacy_doc_pdf_rejects_invalid_intermediate_without_export(tmp_path, monkeypatch, case, code):
    source = Path(__file__).parents[2] / 'app/fixtures/office/中文 试卷.doc'
    workspaces = []

    def run(args, deadline, output):
        workspaces.append(output)
        target = output / source.with_suffix('.docx').name
        if case == 'missing':
            return
        if case == 'directory':
            target.mkdir()
        elif case == 'bad_zip':
            target.write_bytes(b'not a ZIP')
        elif case == 'oversized':
            monkeypatch.setattr(office, 'FILE_LIMIT', source.stat().st_size)
            target.write_bytes(b'x' * (office.FILE_LIMIT + 1))
        else:
            with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('[Content_Types].xml', '<Types/>')
                if case != 'missing_members':
                    xml = '<document/>'
                    if case == 'expanded':
                        xml = 'x' * 10000
                    elif case in {'bad_xml', 'bad_utf16_xml'}:
                        xml = '<document>'
                    elif case in {'doctype', 'doctype_utf16'}:
                        xml = '<!DOCTYPE document [<!ENTITY x "boom">]><document>&x;</document>'
                    archive.writestr('word/document.xml', xml.encode('utf-16') if case.endswith('utf16') or case == 'bad_utf16_xml' else xml)
                    if case == 'duplicate':
                        with pytest.warns(UserWarning, match='Duplicate name'):
                            archive.writestr('word/document.xml', '<document/>')
                if case == 'macro':
                    archive.writestr('word/vbaProject.bin', b'macro')
                if case == 'bad_image_crc':
                    archive.writestr('word/media/image.png', b'image-data')
            if case in {'bad_crc', 'bad_image_crc'}:
                data = bytearray(target.read_bytes())
                offset = data.index(b'PK\x01\x02') if case == 'bad_crc' else data.rindex(b'PK\x01\x02')
                struct.pack_into('<I', data, offset + 16, 0)
                target.write_bytes(data)
            if case == 'wrong_name':
                target.rename(output / 'wrong.docx')
            elif case == 'extra':
                (output / 'extra.docx').write_bytes(target.read_bytes())
            elif case == 'expanded':
                monkeypatch.setattr(office, 'TOTAL_LIMIT', 1000)

    monkeypatch.setattr(office, '_run', run)
    monkeypatch.setattr(office, '_export', lambda *args: pytest.fail('Invalid intermediate must not start PDF export'))
    with pytest.raises(office.OfficeError, match=code):
        office.convert('/bundled/soffice', source, tmp_path / 'out', 'pdf')
    assert len(workspaces) == 1 and not workspaces[0].exists()


@pytest.mark.parametrize('stage', ['normalization', 'pdf'])
def test_legacy_doc_pdf_cleans_intermediate_after_conversion_failure(tmp_path, monkeypatch, stage):
    source = Path(__file__).parents[2] / 'app/fixtures/office/中文 试卷.doc'
    workspaces = []
    def run(args, deadline, output):
        workspaces.append(output)
        if stage == 'normalization':
            raise office.OfficeError('OFFICE_CONVERSION_FAILED')
        (output / source.with_suffix('.docx').name).write_bytes(source.with_suffix('.docx').read_bytes())
    def export(*args):
        raise office.OfficeError('OFFICE_CONVERSION_FAILED')
    monkeypatch.setattr(office, '_run', run)
    monkeypatch.setattr(office, '_export', export)
    with pytest.raises(office.OfficeError, match='OFFICE_CONVERSION_FAILED'):
        office.convert('/bundled/soffice', source, tmp_path / 'out', 'pdf')
    assert len(workspaces) == 1 and not workspaces[0].exists()


@pytest.mark.parametrize('stage', ['normalization', 'pdf'])
def test_legacy_doc_pdf_shared_deadline_stops_before_next_engine_launch(tmp_path, monkeypatch, stage):
    source = Path(__file__).parents[2] / 'app/fixtures/office/中文 试卷.doc'
    now, calls = 0, []
    monkeypatch.setattr(office, 'TIMEOUT', 1)
    monkeypatch.setattr(office.time, 'monotonic', lambda: now)
    def version(engine, deadline):
        nonlocal now
        assert deadline == 1
        if stage == 'normalization':
            now = 2
        return 'pinned-version'
    def run(args, deadline, output):
        nonlocal now
        calls.append(deadline)
        (output / source.with_suffix('.docx').name).write_bytes(source.with_suffix('.docx').read_bytes())
        now = 2
    monkeypatch.setattr(office, 'engine_version', version)
    monkeypatch.setattr(office, '_run', run)
    monkeypatch.setattr(office, '_export', lambda *args: pytest.fail('Expired budget must not start PDF export'))
    with pytest.raises(office.OfficeError, match='OFFICE_TIMEOUT'):
        office.convert('/bundled/soffice', source, tmp_path / 'out', 'pdf', expected_version='pinned-version')
    assert calls == ([] if stage == 'normalization' else [1])


@pytest.mark.parametrize('extension,mode', [('doc', 'text'), ('docx', 'pdf'), ('docx', 'text'), ('xls', 'pdf'), ('xls', 'text'), ('xlsx', 'pdf'), ('xlsx', 'text')])
def test_other_office_paths_do_not_normalize_legacy_word(tmp_path, monkeypatch, extension, mode):
    fixtures = Path(__file__).parents[2] / 'app/fixtures/office'
    source = next(fixtures.glob(f'*.{extension}'))
    def export(engine, snapshot, output, family, selected_mode, deadline):
        assert snapshot == source and selected_mode == mode
        return [{'name': 'existing-path'}]
    monkeypatch.setattr(office, '_export', export)
    monkeypatch.setattr(office, '_run', lambda *args: pytest.fail('This format/mode must not add normalization'))
    assert office.convert('/bundled/soffice', source, tmp_path / 'out', mode) == [{'name': 'existing-path'}]


def test_table_ending_docx_text_uses_private_snapshot_without_changing_input(tmp_path, monkeypatch):
    source = Path(__file__).parents[2] / 'app/fixtures/office/regressions/table-ending.docx'
    original = source.read_bytes()

    def export(engine, snapshot, output, family, mode, deadline):
        assert snapshot != source and snapshot.name == source.name
        with zipfile.ZipFile(source) as before, zipfile.ZipFile(snapshot) as after:
            assert before.namelist() == after.namelist()
            for name in before.namelist():
                expected = before.read(name)
                if name == 'word/document.xml':
                    expected = expected.replace(b'</w:tbl><w:sectPr>', b'</w:tbl><w:p/><w:sectPr>')
                assert after.read(name) == expected
        return [{'name':'table-ending.txt'}]

    monkeypatch.setattr(office, '_export', export)
    assert office.convert('unused', source, tmp_path/'out', 'text')
    assert source.read_bytes() == original


@pytest.mark.parametrize('prefix', ['w:', 'custom:', ''])
@pytest.mark.parametrize('section', ['', '<{p}sectPr/>'])
def test_writer_table_termination_preserves_namespaces_and_non_table_documents(prefix, section):
    namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    declaration = f'xmlns:{prefix[:-1]}' if prefix else 'xmlns'
    raw = f'<{prefix}document {declaration}="{namespace}"><{prefix}body><{prefix}tbl/>{section.format(p=prefix)}</{prefix}body></{prefix}document>'.encode()
    expected = raw.replace(f'<{prefix}tbl/>'.encode(), f'<{prefix}tbl/><{prefix}p/>'.encode())
    assert office._terminate_writer_table(raw) == expected
    assert office._terminate_writer_table(expected) == expected
    assert office._terminate_writer_table(raw.decode().encode('utf-16')) == raw.decode().encode('utf-16')


@pytest.mark.parametrize('raw', [b'<broken>', b'<!DOCTYPE x [<!ENTITY x "boom">]><x>&x;</x>'])
def test_writer_snapshot_rejects_malformed_xml_and_entities(raw):
    with pytest.raises(office.OfficeError, match='OFFICE_INPUT_INVALID'):
        office._terminate_writer_table(raw)


def test_missing_bundle_never_searches_system_path(tmp_path, monkeypatch):
    monkeypatch.delenv("AI_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("PATH", str(tmp_path))
    (tmp_path / "soffice").touch()
    with pytest.raises(office.OfficeError, match="OFFICE_NOT_FOUND"):
        office.detect(str(tmp_path / "missing"))
    with pytest.raises(office.OfficeError, match="OFFICE_NOT_FOUND"):
        office.detect("soffice")


def test_bundled_engine_verifies_capabilities_and_rejects_invalid_binary(tmp_path, monkeypatch):
    engine = tmp_path / "中文 Program Files" / "soffice"
    engine.parent.mkdir()
    engine.touch()
    monkeypatch.setattr(office, "_run", lambda *args: b"Not LibreOffice")
    with pytest.raises(office.OfficeError, match="OFFICE_ENGINE_INVALID"):
        office.detect(str(engine))
    monkeypatch.setattr(office, "_run", lambda *args: b"LibreOffice 26.8.0.3")
    def export(engine, source, output, family, mode, deadline):
        if family == "writer" and mode == "pdf":
            raise office.OfficeError("OFFICE_CONVERSION_FAILED")
        return [{}]
    monkeypatch.setattr(office, "_export", export)
    result = office.detect(str(engine))
    assert result["capabilities"] == {"writer_pdf": False, "writer_text": True, "calc_pdf": True, "calc_text": False}
    assert result["errors"]["calc_text"] == "OFFICE_SHEETS_UNSUPPORTED"
    monkeypatch.setattr(office, "_export", lambda *args: [{}, {}])
    assert all(office.detect(str(engine))["capabilities"].values())


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
    assert '<prop oor:name="DisablePythonRuntime" oor:op="fuse" oor:finalized="true"><value>true</value></prop>' in text
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
    assert office._run([sys.executable, "-c", "import sys; print(sys.dont_write_bytecode)"], time.monotonic() + 10).strip() == b"True"
    monkeypatch.setenv("LLM_API_KEY", "must-not-reach-office")
    result = office._run([sys.executable, "-c", "import os; print(os.getenv('LLM_API_KEY', 'absent'))"], time.monotonic() + 10)
    assert result.strip() == b"absent"


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
            archive.writestr("word/document.xml", "<document/>")
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
    # Publish the ready marker only after its PID contents are complete.
    child_code = (
        "import os,sys,time; from pathlib import Path; "
        "marker=Path(sys.argv[1]); pending=marker.with_suffix('.tmp'); "
        "pending.write_text(str(os.getpid())); pending.replace(marker); time.sleep(120)"
    )
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
        worker.stdin.write(b'{"type":"detect","engine":"/bundled/soffice"}\n')
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


@pytest.mark.parametrize("payload", [{}, [], {"type": "detect", "engine": 3}, {"type": "convert", "engine": 1, "version": "x", "source": "x", "output": "y", "mode": "pdf"}])
def test_private_worker_rejects_malformed_requests(payload, monkeypatch, capsys):
    monkeypatch.setattr(office.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(payload).encode() + b"\n")))
    monkeypatch.setattr(office, "watch_parent", lambda cleanup: None)
    if os.name == "nt":
        from practiq_ai.extractors import windows_job
        monkeypatch.setattr(windows_job, "protect_descendants", lambda: None)
    office.main()
    assert json.loads(capsys.readouterr().out)["error"] == "OFFICE_INPUT_INVALID"


def test_private_worker_detection_has_no_service_bootstrap(monkeypatch, capsys):
    monkeypatch.setattr(office.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b'{"type":"detect","engine":"/bundled/soffice"}\n')))
    monkeypatch.setattr(office, "watch_parent", lambda cleanup: None)
    monkeypatch.setattr(office, "detect", lambda engine: {"path": None})
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
    def normalize(args, deadline, output):
        assert args[args.index('--convert-to') + 1] == 'docx:Office Open XML Text'
        (output / source.with_suffix('.docx').name).write_bytes(next(fixtures.glob('*.docx')).read_bytes())
    monkeypatch.setattr(office, '_run', normalize)
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


@pytest.mark.parametrize("member", ["word/document.xml", "[Content_Types].xml"])
def test_docx_snapshot_rejects_corrupt_member_crc(tmp_path, monkeypatch, member):
    source = Path(__file__).parents[2] / "app/fixtures/office/regressions/table-ending.docx"
    original = zipfile.ZipFile.read

    def read(archive, name, *args, **kwargs):
        if (name.filename if isinstance(name, zipfile.ZipInfo) else name) == member:
            raise zipfile.BadZipFile("Bad CRC-32")
        return original(archive, name, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "read", read)
    with pytest.raises(office.OfficeError, match="OFFICE_INPUT_INVALID"):
        office.convert("unused", source, tmp_path / "out", "text")
