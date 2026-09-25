"""Build deterministic, offline-importable question-bank ZIP examples."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

fixtures = Path(__file__).resolve().parents[1] / 'fixtures'
for name, title in [('sample', '基础题型示例'), ('composite', '复合题示例'), ('english', '英语题型示例'), ('all-types', '全题型示例题库')]:
    source = fixtures / f'{name}.json'
    if name == 'all-types':
        result = json.loads((fixtures / 'sample.json').read_text(encoding='utf-8'))
        english = json.loads((fixtures / 'english.json').read_text(encoding='utf-8'))
        for field in ('questions', 'groups', 'visualElements', 'warnings'):
            result[field].extend(english[field])
    else:
        result = json.loads(source.read_text(encoding='utf-8'))
    files = {
        'manifest.json': json.dumps({'format': 'practiq-question-bank', 'version': 2,
            'bank': {'title': title, 'description': '人工编写的操作样例，不代表模型准确率。'}}, ensure_ascii=False).encode(),
        'questions.json': json.dumps(result, ensure_ascii=False, indent=2).encode() if name == 'all-types' else source.read_bytes(),
    }
    for visual in result['visualElements']:
        for field in ('imageRef', 'sourceRef'):
            reference = visual.get(field)
            if reference:
                key = reference['objectKey']
                files[f'resources/{key}'] = (fixtures / 'resources' / key).read_bytes()
    for question in result['questions']:
        reference = question.get('audioRef')
        if reference:
            key = reference['objectKey']
            files[f'resources/{key}'] = (fixtures / 'resources' / key).read_bytes()
    with ZipFile(fixtures / f'{name}.zip', 'w') as archive:
        for name, data in sorted(files.items()):
            info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
