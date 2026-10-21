"""Freeze paired synthetic sources in five formats; run with the bundled artifact Python.

No model outputs are used as labels. Existing regression gold and sources stay unchanged.
"""
import hashlib
import json
import textwrap
from copy import deepcopy
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
FONT = Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
SOURCES = ['text-grouped', 'text-chinese', 'text-composites', 'text-no-answer',
           'text-grammar-evidence', 'text-listening-evidence']
MAIN = ROOT / 'server/evals/cases.json'
original = json.loads(MAIN.read_text())
by_id = {c['id']: c for c in original['cases']}
assert not (HERE / 'cases.json').exists(), 'Never regenerate a frozen evaluation in place'
font = ImageFont.truetype(str(FONT), 30)
pdfmetrics.registerFont(TTFont('Source', str(FONT)))


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as output:
        output.write(data.encode('utf-8') if isinstance(data, str) else data)


def package(path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(path, 'x', ZIP_DEFLATED) as output:
        for name, xml in entries.items():
            entry = ZipInfo(name, (2026, 10, 21, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            output.writestr(entry, xml.encode('utf-8'))


def docx(path, lines):
    paragraphs = ''.join('<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial Unicode MS" w:hAnsi="Arial Unicode MS" w:eastAsia="Arial Unicode MS"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">' + escape(line) + '</w:t></w:r></w:p>' for line in lines)
    package(path, {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:bottom="720" w:left="720" w:right="720"/></w:sectPr></w:body></w:document>',
    })


def xlsx(path, lines, sheet):
    rows = ''.join(f'<row r="{i}" ht="22" customHeight="1"><c r="A{i}" t="inlineStr"><is><t xml:space="preserve">{escape(line)}</t></is></c></row>' for i, line in enumerate(lines, 1))
    package(path, {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': f'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="120" customWidth="1"/></cols><sheetData>' + rows + '</sheetData></worksheet>',
    })


def page(lines):
    image = Image.new('RGB', (1600, 1200), 'white')
    draw = ImageDraw.Draw(image)
    y = 50
    for line in lines:
        for part in textwrap.wrap(line, 84, replace_whitespace=False, drop_whitespace=False) or ['']:
            assert y + 38 <= image.height, 'Source would be clipped'
            draw.text((50, y), part, font=font, fill='black')
            y += 38
    return image


cases = []
provenance = {'schemaVersion': 1, 'labelSource': 'Unchanged existing synthetic regression gold; not teacher/independent annotations',
              'baseManifestSha256': hashlib.sha256(MAIN.read_bytes()).hexdigest(),
              'fontSha256': hashlib.sha256(FONT.read_bytes()).hexdigest(), 'cases': []}
for number, source_id in enumerate(SOURCES, 1):
    source = by_id[source_id]
    text = (MAIN.parent / source['path']).read_text()
    lines = text.splitlines()
    for kind, suffix in [('text', 'txt'), ('docx', 'docx'), ('pdf', 'pdf'), ('xlsx', 'xlsx'), ('image', 'png')]:
        selected = by_id['image-two-column'] if kind == 'image' and number == 6 else source
        case = deepcopy(selected)
        name = f'{kind}-{number:02}'
        path = HERE / 'sources' / kind / (name + '.' + suffix)
        case.update(id='f30-' + name, sourceType=kind, path=str(path.relative_to(HERE)), tags=[*case['tags'], 'format-matrix'])
        case['expectedProcess'] = {'requiredCallKinds': ['document_parse' if kind == 'text' else 'vision_parse']}
        record = {'id': case['id'], 'regressionCaseId': selected['id'], 'sourceSha256': hashlib.sha256((MAIN.parent / selected['path']).read_bytes()).hexdigest()}
        if kind == 'text':
            write(path, text)
        elif kind == 'docx':
            docx(path, lines)
        elif kind == 'xlsx':
            sheet = 'Arithmetic' if number == 1 else f'Paper{number:02}'
            xlsx(path, lines, sheet)
            groups = case.get('expectedGroups') or []
            if not any(g['title'] == sheet and g['questionIndexes'] == list(range(len(case['expectedQuestions']))) for g in groups):
                groups.append({'title': sheet, 'questionIndexes': list(range(len(case['expectedQuestions'])))})
            case['expectedGroups'] = groups
            record['worksheet'] = sheet
        elif kind == 'pdf':
            path.parent.mkdir(parents=True, exist_ok=True)
            assert not path.exists()
            doc = canvas.Canvas(str(path), pagesize=(595, 842), invariant=1)
            doc.setFont('Source', 10)
            y = 810
            for line in lines:
                for part in textwrap.wrap(line, 90, replace_whitespace=False, drop_whitespace=False) or ['']:
                    assert y >= 30, 'PDF source would be clipped'
                    doc.drawString(30, y, part)
                    y -= 14
            doc.save()
        else:
            if number == 6:
                pages = [Image.open(MAIN.parent / selected['path']).convert('RGB'), page(['End of paper. No additional questions.'])]
            else:
                split = min(range(1, len(lines)), key=lambda i: (bool(lines[i].strip()), abs(i - len(lines) / 2)))
                pages = [page(lines[:split]), page(lines[split:])]
            width, height = max(p.width for p in pages), sum(p.height for p in pages)
            assert width * height <= 25_000_000
            joined = Image.new('RGB', (width, height), 'white')
            members = []
            y = 0
            for i, image in enumerate(pages, 1):
                member = HERE / 'groups' / name / f'page-{i:02}.png'
                member.parent.mkdir(parents=True, exist_ok=True)
                assert not member.exists()
                image.save(member, 'PNG')
                joined.paste(image, (0, y))
                assert joined.crop((0, y, image.width, y + image.height)).tobytes() == image.tobytes()
                members.append({'path': str(member.relative_to(HERE)), 'sha256': hashlib.sha256(member.read_bytes()).hexdigest(),
                                'x': 0, 'y': y, 'width': image.width, 'height': image.height})
                y += image.height
            path.parent.mkdir(parents=True, exist_ok=True)
            assert not path.exists()
            joined.save(path, 'PNG')
            record.update(imageGroup=members, composition='Lossless ordered vertical composition for the existing single-image import API')
        assert case['expectedQuestions'] == selected['expectedQuestions']
        record.update(path=case['path'], sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        provenance['cases'].append(record)
        cases.append(case)
assert len(cases) == 30
assert all(sum(c['sourceType'] == k for c in cases) == 6 for k in ['text', 'docx', 'pdf', 'xlsx', 'image'])
write(HERE / 'cases.json', json.dumps({'schemaVersion': 2, 'cases': cases}, ensure_ascii=False, indent=2) + '\n')
write(HERE / 'provenance.json', json.dumps(provenance, ensure_ascii=False, indent=2) + '\n')
print('Frozen 30 cases: six per format, six two-image groups; source questions/answers unchanged')
