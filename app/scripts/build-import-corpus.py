"""Generate synthetic all-type import documents; requires the artifact Python runtime.
No model calls. LibreOffice is validated against the existing bundled manifest.
"""
import csv
import hashlib
import json
import os
import subprocess
import tempfile
import zipfile
from html import escape
from pathlib import Path

import pypdfium2 as pdfium
from bundle_office import validate
from PIL import Image
from pypdf import PdfWriter
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'app/fixtures/ai-import'
OUT = BASE / 'formats'
RICH = ROOT / 'app/fixtures/rich-content'
NS = ' '.join(f'xmlns:{k}="{v}"' for k, v in {
    'office':'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    'text':'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
    'table':'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
    'draw':'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
    'style':'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
    'fo':'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
    'svg':'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
    'xlink':'http://www.w3.org/1999/xlink',
}.items())


def run_conversion(engine, source, fmt, directory):
    with tempfile.TemporaryDirectory(prefix='practiq-corpus-profile-') as profile, tempfile.TemporaryDirectory(prefix='practiq-corpus-export-') as export:
        env = {k:v for k,v in os.environ.items() if not k.startswith(('AI_', 'LLM_'))}
        env['PYTHONDONTWRITEBYTECODE'] = '1'
        subprocess.run([str(engine), '-env:UserInstallation='+Path(profile).as_uri(), '--headless', '--norestore',
                        '--convert-to', fmt, '--outdir', export, str(source)],
                       check=True, timeout=180, env=env, capture_output=True)
        target = Path(export) / (source.stem+'.'+fmt.split(':')[0])
        assert target.is_file() and target.stat().st_size, target
        destination = directory / target.name
        destination.write_bytes(target.read_bytes())
    return destination


def paragraph(value):
    return '<text:p>'+escape(value)+'</text:p>'


def odf(path, kind, body, pictures):
    mime = 'application/vnd.oasis.opendocument.'+kind
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('mimetype', mime, compress_type=zipfile.ZIP_STORED)
        entries = f'<manifest:file-entry manifest:full-path="/" manifest:media-type="{mime}"/>'
        entries += '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
        for name, data in pictures.items():
            z.writestr('Pictures/'+name, data)
            entries += f'<manifest:file-entry manifest:full-path="Pictures/{name}" manifest:media-type="image/png"/>'
        z.writestr('META-INF/manifest.xml', '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">'+entries+'</manifest:manifest>')
        styles = '<style:style style:name="col" style:family="table-column"><style:table-column-properties style:column-width="16cm"/></style:style><style:style style:name="cell" style:family="table-cell"><style:table-cell-properties fo:wrap-option="wrap"/></style:style>'
        tag = 'text' if kind == 'text' else 'spreadsheet'
        z.writestr('content.xml', f'<office:document-content {NS} office:version="1.2"><office:automatic-styles>{styles}</office:automatic-styles><office:body><office:{tag}>{body}</office:{tag}></office:body></office:document-content>')


def frame(name, width, height):
    return f'<draw:frame draw:name="{name}" text:anchor-type="as-char" svg:width="{width}cm" svg:height="{height}cm"><draw:image xlink:href="Pictures/{name}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT/'resources').mkdir(exist_ok=True)
    bundle = ROOT/'app/src-tauri/bundled'
    manifest = validate(bundle)
    engine = (bundle/'office'/manifest['executable']).resolve()
    base = (BASE/'all-question-types.txt').read_text()
    rich = json.loads((RICH/'expected.json').read_text())['questions'][0]
    formulas = [b['latexValue'] for b in rich['contentBlocks'] if b['partType']=='formula']
    table = [['Sample','x_i','Error','Note'],['A',r'\frac{1}{2}','-0.002','left | right'],['B',r'10^{-6}','0','中文，空值用 —'],['C',r'\sqrt{2}','+0.003','final row']]
    extra = '\n=== Section 11: rich-math-table-chart ===\n\n'+rich['stem']+'\n'+'\n'.join(formulas)+'\n'
    extra += '\n'.join(' | '.join(row) for row in table)+'\nChart: y = x^2, x from 0 to 5. Points (0,0), (1,1), (2,4), (3,9), (4,16), (5,25). See resources/chart.png; axes, curve, grid and labels must remain visible.\nReference answer: '+rich['answerPayload']['text']+'\n'+rich['analysis']+'\n'
    text = base+extra
    (OUT/'all-types.txt').write_text(text)
    (OUT/'resources/chart.png').write_bytes((RICH/'resources/chart.png').read_bytes())
    sections = text.split('=== Section ')[1:]
    with (OUT/'all-types.csv').open('w', newline='') as f:
        writer = csv.writer(f);writer.writerow(['section','source_content'])
        writer.writerows((part.split('\n',1)[0].replace(' ===',''),part.split('\n',1)[1].strip()) for part in sections)
    font = Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
    pdfmetrics.registerFont(TTFont('Corpus', str(font)))
    style = ParagraphStyle('body', fontName='Corpus', fontSize=10, leading=14, spaceAfter=3)
    heading = ParagraphStyle('head', parent=style, fontSize=13, leading=18, textColor=colors.HexColor('#173b67'), spaceBefore=10, spaceAfter=6)
    with tempfile.TemporaryDirectory(prefix='practiq-corpus-') as tmp:
        tmp = Path(tmp)
        story=[]
        for section in base.split('=== Section ')[1:]:
            title, content = section.split('\n',1)
            paragraphs=[Paragraph(escape(line),style) for line in content.strip().splitlines()]
            story.append(KeepTogether([Paragraph(escape(title.replace(' ===','')),heading),*paragraphs]));story.append(Spacer(1,8))
        source=tmp/'base.pdf'
        SimpleDocTemplate(str(source),pagesize=(595.28,841.89),leftMargin=40,rightMargin=40,topMargin=36,bottomMargin=36).build(story)
        writer=PdfWriter();writer.append(source);writer.append(RICH/'source.pdf');writer.write(OUT/'all-types.pdf')
        rich_pdf=pdfium.PdfDocument(RICH/'source.pdf')
        rich_image=rich_pdf[0].render(scale=1.5).to_pil().convert('RGB')
        rich_image.save(tmp/'rich.png');rich_pdf.close()
        pictures={'rich.png':(tmp/'rich.png').read_bytes(),'chart.png':(RICH/'resources/chart.png').read_bytes()}
        body=''.join(paragraph(line) for line in base.splitlines())
        # Word preserves the rich formula/table/chart source page as an embedded graphic.
        body += paragraph('Section 11: rich-math-table-chart — source page below')
        body += '<text:p>'+frame('rich.png',16,16*rich_image.height/rich_image.width)+'</text:p>'
        odt=tmp/'all-types.odt';odf(odt,'text',body,pictures)
        docx=run_conversion(engine,odt,'docx:Office Open XML Text',OUT)
        run_conversion(engine,docx,'doc:MS Word 97',OUT)
        sheets=[]
        for i,section in enumerate(sections,1):
            lines=section.strip().splitlines()
            rows=''.join('<table:table-row><table:table-cell table:style-name="cell" office:value-type="string">'+paragraph(line)+'</table:table-cell></table:table-row>' for line in lines)
            sheets.append(f'<table:table table:name="Section {i:02}"><table:table-column table:style-name="col"/>'+rows+'</table:table>')
        rows=''.join('<table:table-row>'+''.join('<table:table-cell office:value-type="string">'+paragraph(c)+'</table:table-cell>' for c in row)+'</table:table-row>' for row in table)
        sheets.append('<table:table table:name="Data table">'+rows+'</table:table>')
        sheets.append('<table:table table:name="Rich source"><table:shapes>'+frame('rich.png',16,16*rich_image.height/rich_image.width).replace('text:anchor-type="as-char"', 'svg:x="0cm" svg:y="0cm"')+'</table:shapes><table:table-column table:style-name="col"/><table:table-row><table:table-cell>'+paragraph('Rich source page: supplied formulas, table and chart')+'</table:table-cell></table:table-row></table:table>')
        ods=tmp/'all-types.ods';odf(ods,'spreadsheet',''.join(sheets),pictures)
        xlsx=run_conversion(engine,ods,'xlsx:Calc MS Excel 2007 XML',OUT)
        run_conversion(engine,xlsx,'xls:MS Excel 97',OUT)
    # Each standalone raster contains every PDF page, with readable page boundaries.
    pdf=pdfium.PdfDocument(OUT/'all-types.pdf');pages=[p.render(scale=1.6).to_pil().convert('RGB') for p in pdf]
    width=max(p.width for p in pages);height=max(p.height for p in pages)
    columns=2;poster=Image.new('RGB',(columns*width,((len(pages)+1)//2)*height),'#dddddd')
    for i,page in enumerate(pages):poster.paste(page,((i%columns)*width,(i//columns)*height))
    assert poster.width*poster.height <= 25_000_000
    poster.save(OUT/'all-types.png');poster.save(OUT/'all-types.jpg',quality=94,subsampling=0)
    pages[0].save(OUT/'all-types-scanned.pdf',save_all=True,append_images=pages[1:],resolution=115.2)
    pdf.close()
    contact=poster.copy();contact.thumbnail((1200,1800));contact.save(OUT/'resources/preview.png')
    for p in OUT.rglob('*'):
        if p.is_file():assert p.stat().st_size < 25*1024*1024,p
    expected={'scope':'Synthetic sources; fixture validation is not live-model acceptance','types':16,'questionRows':25,'compositeParents':6,'answerableRows':19,'baseCases':['text-basic','text-multiple-choice','text-fill-blank','text-grading-evidence','text-composites','text-listening-evidence','text-grammar-evidence','text-sentence-selection','text-paragraph-matching','text-translation-writing'],'richQuestion':rich,'table':table,'formulaLatex':formulas,'rasterSize':list(poster.size),'pdfPages':len(pages),'officeVersion':manifest['version'],'files':{str(p.relative_to(OUT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.rglob('*')) if p.suffix in {'.txt','.csv','.pdf','.png','.jpg','.doc','.docx','.xls','.xlsx'}}}
    (BASE/'formats-expected.json').write_text(json.dumps(expected,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'pdfPages':len(pages),'rasterSize':poster.size,'files':len(expected['files'])}))


if __name__ == '__main__':
    main()
