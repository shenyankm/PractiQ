"""Build the offline UI acceptance gallery from successful browser captures."""
import csv
import hashlib
import html
import json
import re
import shutil
import struct
import subprocess
from collections import Counter
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
SOURCES = [ROOT / path for path in ('app/.build/uiux-legend-final-results', 'app/.build/uiux-action-final-results', 'app/.build/uiux-accepted-results', 'web/.build/uiux-web-results')]
PREFIX = {'mobile': 'MOB', 'desktop': 'DSK', 'web-import': 'WEB'}
items, seen, logical_seen = [], {}, set()
candidates = [(source, path) for source in SOURCES for path in source.rglob('*.png')]
for source, path in sorted(candidates, key=lambda pair: pair[1].stat().st_mtime_ns, reverse=True):
    if path.name.startswith('test-failed'):
        continue
    context_dir = path.parent
    while context_dir != source and not (context_dir / 'capture-context.json').exists():
        context_dir = context_dir.parent
    context_path = context_dir / 'capture-context.json'
    if not context_path.exists():
        continue
    context = json.loads(context_path.read_text())
    if context.get('status', 'passed') != 'passed':
        continue
    sidecar = Path(str(path) + '.json')
    metadata = json.loads(sidecar.read_text()) if sidecar.exists() else context.copy()
    if not sidecar.exists():
        match = re.search(r'file-picker-(\d+)-(dark|light)', path.stem)
        if match:
            metadata.update(viewportWidth=int(match[1]), theme=match[2])
    logical_key = (source.relative_to(ROOT).parts[0], metadata['title'], str(path.relative_to(context_dir)),
                   metadata['viewportWidth'], metadata['viewportHeight'], metadata['theme'], metadata['locale'])
    # Keep the newest successful capture when a scenario is rerun.
    if logical_key in logical_seen:
        continue
    logical_seen.add(logical_key)
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', path
    width, height = struct.unpack('>II', data[16:24])
    digest = hashlib.sha256(data).hexdigest()
    provenance = {'path': str(path.relative_to(ROOT)), **metadata}
    if digest in seen:
        seen[digest]['sources'].append(provenance)
        continue
    viewport = metadata['viewportWidth']
    surface = 'web-import' if source.relative_to(ROOT).parts[0] == 'web' else 'mobile' if viewport < 768 else 'desktop'
    title = metadata['title'] + ' · ' + path.stem
    lower = title.lower()
    category = ('练习与考试' if any(word in lower for word in ('question layouts', 'practice', 'answer-card', 'answer card', 'exam', 'setup', '配分')) else
                '设置与恢复' if any(word in lower for word in ('settings', 'restore', 'backup', 'connection')) else
                '题库与题目' if any(word in lower for word in ('bank', 'mistake', 'editor', 'question')) else '综合场景')
    if surface == 'web-import':
        category = '结果复核' if 'review' in lower or 'question layouts' in lower else '导入设置' if 'settings' in lower else '导入与任务管理'
    row = dict(surface=surface, title=title, category=category,
               state='交互/弹层' if any(word in path.stem for word in ('menu', 'help', 'confirm', 'zoom', 'error', 'popover')) else '页面/内容',
               viewportWidth=viewport, viewportHeight=metadata['viewportHeight'], viewport=f'{viewport} px',
               pixelWidth=width, pixelHeight=height,
               theme=metadata['theme'], locale=metadata['locale'],
               framing='页面' if sidecar.exists() else '元素裁图', sha256=digest, bytes=len(data), sources=[provenance])
    seen[digest] = row
    row['_path'] = path
    items.append(row)

assert items, 'Run the browser checks before building the gallery'
assert {row['surface'] for row in items} == set(PREFIX), 'Capture all three layouts'
items.sort(key=lambda row: (list(PREFIX).index(row['surface']), row['category'], row['title'], row['theme']))
counts = Counter()
for surface, prefix in PREFIX.items():
    for stale in (OUT / surface).glob(f'{prefix}-*.png'):
        stale.unlink()
for row in items:
    surface = row['surface']
    counts[surface] += 1
    row['id'] = f'{PREFIX[surface]}-{counts[surface]:03d}'
    slug = re.sub(r'[^a-zA-Z0-9-]+', '-', row['_path'].stem).strip('-')[:70]
    row['file'] = f'{surface}/{row["id"]}-{slug}-{row["viewportWidth"]}w-{row["theme"]}-{row["locale"]}.png'
    target = OUT / row['file']
    target.parent.mkdir(exist_ok=True)
    shutil.copyfile(row.pop('_path'), target)
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
diff = subprocess.check_output(['git', 'diff', '--', 'app', 'web', 'shared'], cwd=ROOT)
untracked = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '--', 'app', 'web', 'shared'], cwd=ROOT, text=True).splitlines()
source_hashes = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in untracked}
manifest = dict(capturedOn='2026-10-21', sourceRevision=revision, workingDiffSha256=hashlib.sha256(diff).hexdigest(), untrackedSourceSha256=source_hashes,
                evidence='Chromium responsive previews and synthetic HTTP/native fixtures; no live models or native windows', counts=dict(counts), items=items)
(OUT / 'capture-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
fields = ['id','surface','category','state','viewportWidth','viewportHeight','pixelWidth','pixelHeight','theme','locale','framing','file','sha256','bytes','title']
with (OUT / 'capture-manifest.csv').open('w', newline='') as stream:
    writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='ignore', lineterminator='\n')
    writer.writeheader()
    writer.writerows(items)
esc = html.escape
sections = []
for surface, prefix in PREFIX.items():
    rows = [row for row in items if row['surface'] == surface]
    filters = '<label>搜索<input type="search" placeholder="编号、场景、测试名称"></label>'
    for field, label in [('category','场景'),('state','状态'),('viewport','视口宽度'),('theme','主题'),('locale','语言'),('framing','构图')]:
        filters += f'<label>{label}<select data-field="{field}"><option value="">全部</option>' + ''.join(f'<option>{esc(str(value))}</option>' for value in sorted({row[field] for row in rows})) + '</select></label>'
    cards = []
    for row in rows:
        attrs = ' '.join(f'data-{key}="{esc(str(row[key]), quote=True)}"' for key in ['category','state','viewport','theme','locale','framing'])
        cards.append(f'<article {attrs}><a href="{esc(row["file"])}" target="_blank"><img loading="lazy" src="{esc(row["file"])}" alt="{row["id"]} {esc(row["title"])}"></a><b>{row["id"]}</b><p>{esc(row["title"])}</p><small>{row["viewportWidth"]}×{row["viewportHeight"]} 视口 · {row["pixelWidth"]}×{row["pixelHeight"]} 图片 · {esc(row["theme"])} · {esc(row["locale"])} · {row["framing"]}</small></article>')
    sections.append(f'<section id="{surface}"><h2>{prefix} · {len(rows)} 张</h2><form>{filters}<button type="reset">重置本组</button></form><p class="count"></p><div class="grid">' + ''.join(cards) + '</div></section>')
(OUT / 'index.html').write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PractiQ UI 修复验收图库</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7f4f1;color:#302939;font:14px/1.6 system-ui}header,main{padding:24px 32px}h1{font-size:28px}h2{font-size:22px}section{margin-bottom:40px}nav,form{display:flex;gap:12px;flex-wrap:wrap}a{color:#795088}form{padding:16px;background:#fffcfa;border:1px solid #ded5da;border-radius:16px}label{display:grid;gap:6px}input,select,button{min-height:40px;border:1px solid #958798;border-radius:10px;background:#fffcfa;padding:8px;color:inherit}button{cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,330px),1fr));gap:16px}article{border:1px solid #ded5da;border-radius:16px;background:#fffcfa;padding:16px;min-width:0}article a{display:flex;height:340px;justify-content:center;background:#efeae6}img{max-width:100%;height:100%;object-fit:contain}article p,small{overflow-wrap:anywhere}article[hidden]{display:none}@media(max-width:767px){header,main{padding:16px}input,select,button{min-height:48px}}
</style><header><h1>PractiQ UI 修复验收图库</h1><p>2026-10-21 · Chromium 响应式预览与合成数据。主题、语言、视口来自采集时的页面。非原生设备或真实服务验收。</p><nav><a href="#mobile">移动端</a><a href="#desktop">桌面端</a><a href="#web-import">Web 导入端</a><a href="capture-manifest.json">JSON 清单</a><a href="capture-manifest.csv">CSV 清单</a><a href="README.md">验收说明</a></nav></header><main>''' + ''.join(sections) + '''</main><script>
for(const section of document.querySelectorAll('section')){const form=section.querySelector('form'),cards=[...section.querySelectorAll('article')];function filter(){const search=form.querySelector('input').value.trim().toLowerCase();let count=0;for(const card of cards){card.hidden=!(card.textContent.toLowerCase().includes(search)&&[...form.querySelectorAll('select')].every(select=>!select.value||card.dataset[select.dataset.field]===select.value));if(!card.hidden)count++}section.querySelector('.count').textContent=`显示 ${count} / ${cards.length} 张`}form.addEventListener('submit',event=>event.preventDefault());form.addEventListener('input',filter);form.addEventListener('reset',()=>setTimeout(filter));filter()}
</script></html>''')
# Integrity checks also catch generator regressions without another dependency.
assert len({row['id'] for row in items}) == len(items)
assert len({row['sha256'] for row in items}) == len(items)
for surface, prefix in PREFIX.items():
    assert [row['id'] for row in items if row['surface'] == surface] == [f'{prefix}-{number:03d}' for number in range(1, counts[surface] + 1)]
for row in items:
    data = (OUT / row['file']).read_bytes()
    assert len(data) == row['bytes'] and hashlib.sha256(data).hexdigest() == row['sha256']
with (OUT / 'capture-manifest.csv').open() as stream:
    assert len(list(csv.DictReader(stream))) == len(items)
print(json.dumps({'screenshots':len(items),'counts':dict(counts),'integrity':'passed'},ensure_ascii=False))
