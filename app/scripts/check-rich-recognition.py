"""Explicit real-model probe; never called by app-check or CI. Uses .env, isolated local storage."""
import asyncio
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'server/src'))
from dotenv import load_dotenv
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore
from practiq_ai.contracts import DocumentUploadRequest
from practiq_ai.storage import get_object_store

def check_result(result, payload, target):
    formulas = ''.join(b.get('latexValue') or '' for q in result['questions'] for b in q['contentBlocks'])
    compact = ''.join(formulas.split())
    source_text = '\n'.join(q.get('sourceText') or '' for q in result['questions']).replace(r'\|', '|')
    def cells(markdown):
        lines = [line.strip().strip('|') for line in markdown.splitlines() if line.strip()]
        return [[re.sub(r"\s+", "", cell.replace(r"\|", "|")) for cell in re.split(r"(?<!\\)\|", line)] for i, line in enumerate(lines) if i != 1]
    expected = json.loads((ROOT / 'app/fixtures/rich-content/expected.json').read_text())
    table = next(b['markdownValue'] for b in expected['questions'][0]['contentBlocks'] if b['partType'] == 'table')
    checks = {
        'tableCellsExact': any(cells(b.get('markdownValue') or '') == cells(table) for q in result['questions'] for b in q['contentBlocks'] if b['partType'] == 'table'),
        'oneQuestion': len(result['questions']) == 1,
        'matrixPreserved': r'\begin{pmatrix}1&2\\3&4\end{pmatrix}' in compact,
        'radicandPreserved': r'\sqrt{x+1}' in compact,
        'integralDenominatorPreserved': r'\sqrt{1-x^2}' in compact,
        'tableCellTextPreserved': all(v in source_text for v in ['-0.002', '+0.003', 'left | right', 'final row', '中文']),
        'structuredTablePreserved': any(b['partType'] == 'table' for q in result['questions'] for b in q['contentBlocks']),
        'tableAndChartDetected': {'table', 'chart'} <= {v['kind'] for v in result['visualElements']},
    }
    regions = json.loads((ROOT / 'app/fixtures/rich-content/visual-regions.json').read_text())
    assert regions['sourceSha256'] == hashlib.sha256(payload).hexdigest(), 'PDF changed: review visual gold regions'
    for gold in regions['regions']:
        gx0, gy0, gx1, gy1 = gold['bbox']
        coverage = []
        for visual in result['visualElements']:
            if visual['kind'] != gold['kind'] or visual.get('page') != gold['page'] or not visual.get('bbox'):
                continue
            x0, y0, x1, y1 = visual['bbox']
            coverage.append(max(0, min(x1, gx1)-max(x0, gx0))*max(0, min(y1, gy1)-max(y0, gy0))/((gx1-gx0)*(gy1-gy0)))
        checks[gold['kind'] + 'CropCoverage95'] = max(coverage, default=0) >= .95
    (target / 'recognition-checks.json').write_text(json.dumps({
        'sourceSha256': hashlib.sha256(payload).hexdigest(), 'checks': checks,
        'scope': 'Literal fixture checks, not general mathematical equivalence; inspect crops manually.'}, indent=2))
    return checks


async def main():
    load_dotenv(ROOT / '.env')
    os.environ['LANGSMITH_TRACING'] = os.environ['LANGCHAIN_TRACING_V2'] = 'false'
    with tempfile.TemporaryDirectory(prefix='practiq-rich-') as directory:
        os.environ['AI_STORAGE_BACKEND'] = 'local'
        os.environ['AI_STORAGE_DIR'] = directory
        from practiq_ai.graphs.document import build_document_graph
        merged = '--merged' in sys.argv
        source = ROOT / ('app/fixtures/rich-content/merged-cross-page.pdf' if merged else 'app/fixtures/rich-content/source.pdf')
        payload = source.read_bytes()
        ref = await get_object_store().put_document(payload, DocumentUploadRequest(
            sourceType='pdf', fileName=source.name, mediaType='application/pdf',
            sha256=hashlib.sha256(payload).hexdigest(), sizeBytes=len(payload)))
        memory = InMemoryStore()
        graph = build_document_graph(InMemorySaver(), store=memory)
        target = ROOT / 'app/reports/rich-content'
        if merged:
            target = target / 'merged'
        target.mkdir(parents=True, exist_ok=True)
        config = {'configurable': {'thread_id': str(uuid4())}, 'run_id': uuid4()}
        try:
            output = await graph.ainvoke({'document': ref.model_dump()}, config)
        except Exception as exc:
            state = (await graph.aget_state(config)).values
            from practiq_ai.execution import namespace
            calls = await memory.asearch(namespace(config['configurable']['thread_id'], 'calls'), limit=100)
            failure = {'validationIssues': [c.value.get('validationIssues') for c in calls], 'code': getattr(exc, 'code', type(exc).__name__), 'failures': state.get('failures'),
                       'visionResults': state.get('visionResults'), 'usage': state.get('usage')}
            (target / 'failure.json').write_text(json.dumps(failure, ensure_ascii=False, indent=2, default=str))
            print(json.dumps({'failed': failure['code'], 'report': str(target / 'failure.json')}))
            return False
        output['fixtureSourceSha256'] = hashlib.sha256(payload).hexdigest()
        output['implementationSha256'] = {name: hashlib.sha256((ROOT / 'server/src/practiq_ai' / name).read_bytes()).hexdigest() for name in ('graphs/document.py', 'graphs/vision.py', 'contracts.py')}
        result = output['result']
        target = ROOT / 'app/reports/rich-content'
        if merged:
            target = target / 'merged'
        target.mkdir(parents=True, exist_ok=True)
        (target / 'recognition.json').write_text(json.dumps(output, ensure_ascii=False, indent=2, default=str))
        # Preserve crops for human semantic/legibility review, not just checksum checks.
        from practiq_ai.contracts import ArtifactReference
        for i, visual in enumerate(result['visualElements']):
            for field in ('imageRef', 'sourceRef'):
                if visual.get(field):
                    reference = ArtifactReference.model_validate(visual[field])
                    image = await get_object_store().get_verified(reference)
                    path = target / 'resources' / reference.objectKey
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(image)
                    (target / f'{field}-{i}.png').write_bytes(image)
        if merged:
            text = '\n'.join([q.get('sourceText') or '' for q in result['questions']] + [v.get('extractedText') or '' for v in result['visualElements']])
            checks = {'oneQuestion': len(result['questions']) == 1,
                      'continuationCells': all(cell in text for cell in ['Morning', 'Afternoon', '11', '12', '21', '22', '31', '32', '41', '42']),
                      'complexTableReview': all(q['needsReview'] for q in result['questions']),
                      'twoOriginalPages': {v['page'] for v in result['visualElements'] if v.get('sourceRef')} == {0, 1},
                      'answerFromNextPage': any('Trial B' in (q.get('answerPayload') or {}).get('text', '') for q in result['questions'])}
            (target / 'recognition-checks.json').write_text(json.dumps(checks, indent=2))
        else:
            checks = check_result(result, payload, target)
        print(json.dumps({'checks': checks, 'status': output['status'], 'questions': len(result['questions']),
                          'visuals': len(result['visualElements']), 'report': str(target / 'recognition.json')}))
        return all(checks.values())


if __name__ == '__main__':
    if '--check-report' in sys.argv:
        target = ROOT / 'app/reports/rich-content'
        saved = json.loads((target / 'recognition.json').read_text())
        assert saved['fixtureSourceSha256'] == hashlib.sha256((ROOT / 'app/fixtures/rich-content/source.pdf').read_bytes()).hexdigest()
        result = saved['result']
        checks = check_result(result, (ROOT / 'app/fixtures/rich-content/source.pdf').read_bytes(), target)
        print(json.dumps(checks))
        sys.exit(0 if all(checks.values()) else 1)
    sys.exit(0 if asyncio.run(main()) else 1)
