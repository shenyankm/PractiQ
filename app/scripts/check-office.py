"""Exercise real LibreOffice conversion, without network or model calls."""
import argparse
import csv
import hashlib
import io
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server/src"))
from practiq_ai import office


def fixtures(directory: Path, engine: Path) -> None:
    """Small OOXML samples; no python-docx/openpyxl build dependency."""
    directory.mkdir(parents=True, exist_ok=True)
    rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{target}"/></Relationships>'
    types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>{overrides}</Types>'
    paragraph = '<w:p><w:r><w:t>{text}</w:t></w:r></w:p>'
    rows = ''.join('<w:tr><w:tc>'+paragraph.format(text=f'中文题目 {i:03}: 1 + 2 = ?')+'</w:tc><w:tc>'+paragraph.format(text='答案：3')+'</w:tc></w:tr>' for i in range(70))
    body = paragraph.format(text='PractiQ 中文转换测试 — Fraction 1/2')
    body += '<w:p><m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></w:p>'
    body += '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Test image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
    body += '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="7000"/><w:gridCol w:w="2000"/></w:tblGrid>'+rows+'</w:tbl>'+paragraph.format(text='结束 END')+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr>'
    with zipfile.ZipFile(directory / '中文 试卷.docx', 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', types.format(overrides='<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Default Extension="png" ContentType="image/png"/>'))
        archive.writestr('_rels/.rels', rels.format(target='word/document.xml'))
        archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>'+body+'</w:body></w:document>')
        archive.writestr('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>')
        archive.write(ROOT / 'app/src-tauri/icons/icon.png', 'word/media/image.png')
    with zipfile.ZipFile(directory / '中文 表格.xlsx', 'w', zipfile.ZIP_DEFLATED) as archive:
        overrides = '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        overrides += ''.join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in (1,2))
        archive.writestr('[Content_Types].xml', types.format(overrides=overrides))
        archive.writestr('_rels/.rels', rels.format(target='xl/workbook.xml'))
        archive.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="题目" sheetId="1" r:id="r1"/><sheet name="隐藏表" sheetId="2" state="hidden" r:id="r2"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">题目!$A$1:$C$4</definedName></definedNames></workbook>')
        archive.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+''.join(f'<Relationship Id="r{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in (1,2))+'<Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
        archive.writestr('xl/styles.xml', '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="12"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf xfId="0"/><xf numFmtId="14" applyNumberFormat="1" xfId="0"/></cellXfs></styleSheet>')
        for index, hidden in ((1,False),(2,True)):
            cells = '<row r="1"><c r="A1" t="inlineStr"><is><t>'+('隐藏数据' if hidden else '中文题目')+'</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>001</t></is></c><c r="B2"><f>1+2</f><v>3</v></c><c r="C2" s="1"><v>45000</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>合并单元格</t></is></c></row><row r="8"><c r="A8" t="inlineStr"><is><t>OUTSIDE_PRINT_AREA</t></is></c></row>'
            archive.writestr(f'xl/worksheets/sheet{index}.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="3" width="24" customWidth="1"/></cols><sheetData>'+cells+'</sheetData><mergeCells count="1"><mergeCell ref="A3:C3"/></mergeCells><pageSetup paperSize="9" orientation="portrait"/></worksheet>')
    for source, target in (('中文 试卷.docx','doc:MS Word 97'), ('中文 表格.xlsx','xls:MS Excel 97')):
        with tempfile.TemporaryDirectory() as tmp:
            profile = office._profile(Path(tmp))
            office._run([str(engine), f'-env:UserInstallation={profile.as_uri()}', '--headless', '--convert-to', target, '--outdir', str(directory), str(directory / source)], time.monotonic()+180)


def call_worker(bundle: Path, request: dict) -> dict:
    executable = bundle / 'python' / ('practiq-ai.exe' if sys.platform == 'win32' else 'practiq-ai')
    with tempfile.TemporaryDirectory() as tmp:
        environment = {k:v for k,v in os.environ.items() if not k.startswith(('AI_', 'LLM_'))}
        environment.update(TMPDIR=tmp, TEMP=tmp, TMP=tmp)
        process = subprocess.Popen([str(executable), 'office'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment)
        assert process.stdin is not None and process.stdout is not None
        try:
            process.stdin.write(json.dumps(request)+'\n'); process.stdin.flush()
            lines: queue.Queue[str] = queue.Queue()
            stream = process.stdout
            threading.Thread(target=lambda: lines.put(stream.readline()), daemon=True).start()
            response = json.loads(lines.get(timeout=200))
            assert process.wait(timeout=10) == 0
            assert 'error' not in response, response
            return response['result']
        finally:
            process.stdin.close()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.wait()


def check_external_links(engine: str, version: str, bundle: Path | None, fixtures_dir: Path) -> dict:
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'External content must not be requested')
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix='practiq-office-links-') as tmp:
            for name in ('中文 试卷.docx', '中文 表格.xlsx'):
                source = Path(tmp) / name
                url = f'http://127.0.0.1:{server.server_port}/external'
                with zipfile.ZipFile(fixtures_dir/name) as original, zipfile.ZipFile(source, 'w') as target:
                    for item in original.infolist():
                        data = original.read(item.filename)
                        if item.filename == 'word/_rels/document.xml.rels':
                            data = data.replace(b'Target="media/image.png"', f'Target="{url}" TargetMode="External"'.encode())
                        if item.filename == 'word/document.xml':
                            data = data.replace(b'r:embed="rIdImage"', b'r:link="rIdImage"')
                        if item.filename == 'xl/worksheets/sheet1.xml':
                            data = data.replace(b'<f>1+2</f>', f'<f>WEBSERVICE("{url}")</f>'.encode())
                        target.writestr(item, data)
                output = Path(tmp)/source.stem
                if bundle:
                    call_worker(bundle, {'type':'convert','engine':engine,'version':version,'source':str(source),'output':str(output),'mode':'pdf'})
                else:
                    office.convert(engine, source, output, 'pdf', expected_version=version)
        assert not requests, f'LibreOffice updated external content: {requests}'
        return {'passed':True, 'httpRequests':len(requests), 'cases':['linked Word image', 'Calc WEBSERVICE formula']}
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', type=Path, default=ROOT/'app/src-tauri/bundled')
    parser.add_argument('--generate-fixtures', action='store_true')
    parser.add_argument('--isolated', action='store_true', help='Test a relocated copy with read-only POSIX resources')
    parser.add_argument('--output', type=Path, default=ROOT/'server/reports/checks/office.json')
    args = parser.parse_args()
    from bundle_office import checksum, validate
    if args.isolated:
        import stat
        with tempfile.TemporaryDirectory(prefix='practiq 中文 Program Files ') as temporary:
            relocated = Path(temporary) / 'bundled'
            shutil.copytree(args.bundle, relocated, symlinks=True)
            def fingerprints():
                return {str(p.relative_to(relocated)): checksum(p) for p in relocated.rglob('*') if p.is_file() and not p.is_symlink()}
            before = fingerprints()
            paths = [p for p in relocated.rglob('*') if not p.is_symlink()] + [relocated]
            command = [sys.executable, __file__, '--bundle', str(relocated), '--output', str(args.output.resolve())]
            try:
                # Writable installs must remain immutable too: embedded Python caches break signatures.
                subprocess.run(command, check=True)
                assert fingerprints() == before, 'Conversion modified bundled resources'
                if os.name != 'nt':
                    for path in paths:
                        path.chmod(stat.S_IMODE(path.stat().st_mode) & ~0o222)
                    subprocess.run(command, check=True)
                    assert fingerprints() == before, 'Conversion modified read-only resources'
                if sys.platform == 'darwin':
                    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(relocated/'office/LibreOffice.app')], check=True)
                report = json.loads(args.output.read_text(encoding='utf-8'))
                report['relocation'] = {'unicodeAndSpaces': True, 'readOnlyResources': os.name != 'nt', 'writableResourcesUnchanged': True}
                args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            finally:
                if os.name != 'nt':
                    for path in reversed(paths):
                        path.chmod(stat.S_IMODE(path.stat().st_mode) | stat.S_IWUSR)
        return
    manifest = validate(args.bundle)
    engine = (args.bundle / 'office' / manifest['executable']).resolve()
    status = call_worker(args.bundle, {'type':'detect','engine':str(engine)})
    assert Path(status['path']).resolve() == engine
    assert all(status['capabilities'].values()), status
    fixture_dir = ROOT/'app/fixtures/office'
    if args.generate_fixtures:
        fixtures(fixture_dir, Path(status['path']))
    report = {'engine':status, 'platform':sys.platform, 'packaged':bool(args.bundle), 'modelCalls':0, 'cases':[], 'passed':False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    evidence = args.output.parent / (args.output.stem+'-artifacts')
    evidence.mkdir(exist_ok=True)
    try:
        for source in sorted(fixture_dir.iterdir()):
            if source.suffix not in office.FORMATS:
                continue
            original = hashlib.sha256(source.read_bytes()).hexdigest()
            for mode in ('pdf','text'):
                started = time.monotonic()
                with tempfile.TemporaryDirectory(prefix='practiq-office-eval-') as tmp:
                    output = Path(tmp)/'output'
                    if args.bundle:
                        artifacts = call_worker(args.bundle, {'type':'convert','engine':status['path'],'version':status['version'],'source':str(source),'output':str(output),'mode':mode})['artifacts']
                    else:
                        artifacts = office.convert(status['path'], source, output, mode, expected_version=status['version'])
                    texts = []
                    pages = 0
                    for artifact in artifacts:
                        file = output / artifact['name']
                        shutil.copyfile(file, evidence / f'{source.suffix[1:]}-{artifact["name"]}')
                        if mode == 'pdf':
                            import pypdfium2 as pdfium
                            with pdfium.PdfDocument(file) as pdf:
                                pages += len(pdf)
                                for index in range(len(pdf)):
                                    page = pdf[index]
                                    try:
                                        textpage = page.get_textpage()
                                        try:
                                            texts.append(textpage.get_text_range())
                                        finally:
                                            textpage.close()
                                        bitmap = page.render(scale=1.2)
                                        try:
                                            image = bitmap.to_pil()
                                            try: image.save(evidence / f'{source.suffix[1:]}-page-{index+1}.png')
                                            finally: image.close()
                                        finally: bitmap.close()
                                    finally: page.close()
                        else:
                            texts.append(file.read_text(encoding='utf-8-sig'))
                    combined = '\n'.join(texts)
                    assert '中文' in combined, f'Chinese lost in {source.name} / {mode}'
                    if source.suffix in ('.xls','.xlsx') and mode == 'text':
                        assert len(artifacts) == 2 and '隐藏数据' in combined and '001' in combined and 'OUTSIDE_PRINT_AREA' in combined
                        assert '1+2' not in combined
                        for sheet in texts:
                            rows = list(csv.reader(io.StringIO(sheet)))
                            assert rows[1][:2] == ['001', '3']
                            assert rows[1][2] != '45000' and any(not c.isdigit() for c in rows[1][2])
                    if source.suffix in ('.xls','.xlsx') and mode == 'pdf':
                        assert 'OUTSIDE_PRINT_AREA' not in combined and '隐藏数据' not in combined
                    if source.suffix in ('.doc','.docx'):
                        assert '069' in combined and '答案' in combined and 'END' in combined
                        if mode == 'pdf': assert pages >= 2
                    assert hashlib.sha256(source.read_bytes()).hexdigest() == original
                    report['cases'].append({'input':source.name,'mode':mode,'sourceSha256':original,'outputs':artifacts,'pages':pages,'seconds':round(time.monotonic()-started,3),'passed':True})
        assert len(report['cases']) == 8, 'All four Office formats must be exercised'
        report['externalLinks'] = check_external_links(status['path'], status['version'], args.bundle, fixture_dir)
        report['passed'] = True
    except Exception as error:
        report['error'] = str(error)
        raise
    finally:
        args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'Office conversion: {len(report["cases"])} cases passed; {args.output}')


if __name__ == '__main__':
    main()
