"""Compare OCR-page read/projection work with a Git baseline; no providers."""

import argparse
import ast
import asyncio
import hashlib
import json
import platform
import subprocess
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from benchmark_source_evidence import measure
from benchmark_web_server import ROOT, baseline_function, digest
from langgraph.runtime import Runtime

from practiq_ai.config import load
from practiq_ai.graphs import document, vision
from practiq_ai.storage import ObjectStore
from tests.support import parsed


async def workload(baseline, rows, context):
    reply = parsed('Printed question') if rows else {'questions': [], 'groups': []}
    figures = []
    if rows:
        reply['questions'][0]['id'] = 'page:1:1'
        reply['figures'] = [{'elementIndex': 9, 'kind': 'table', 'description': 'Printed table',
                            'questionIndexes': [0], 'tableRows': [[f'Cell {row}-{col}' for col in range(4)] for row in range(rows)]}]
        figures = [{'elementIndex': 9, 'kind': 'image', 'bbox': [.1, .1, .9, .9]}]
    counts = {'before': [], 'after': []}
    with TemporaryDirectory(prefix='practiq-ocr-projection-') as directory, pytest.MonkeyPatch.context() as patch:
        store = ObjectStore(replace(load(), storage_dir=Path(directory)))
        try:
            refs = []
            for index in range(4):
                evidence = {'page': index, 'figures': figures if index == 0 else [],
                            'elements': [{'text_info': {'content': 'Printed source evidence ' * 1300}}]}
                ref = await store.put_artifact(json.dumps(evidence).encode(), source_sha256='a' * 64,
                                               kind='ocr-page', index=index, media_type='application/json')
                refs.append(ref.model_dump(mode='json'))
            state = {'artifact': refs[0], 'ocrArtifact': refs[0], 'index': 0,
                     'neighbors': [{'index': i, 'ocrArtifact': ref} for i, ref in enumerate(refs)] if context else []}
            work = {'reads': 0, 'markdown': 0, 'modelCalls': 0}
            read, markdown = store.get_verified, vision.PageFigure.table_markdown

            async def tracked(ref):
                work['reads'] += 1
                return await read(ref)

            def table(self):
                work['markdown'] += 1
                return markdown(self)

            async def call(_model, _messages, schema, _kind, *, runtime):
                work['modelCalls'] += 1
                return schema.model_validate(reply), [], None

            patch.setattr(store, 'get_verified', tracked)
            patch.setattr(vision.PageFigure, 'table_markdown', table)
            patch.setattr(document, 'get_object_store', lambda: store)
            patch.setattr(document, 'get_model', lambda: object())
            patch.setattr(document, 'structured_call', call)
            original = baseline_function(baseline, document, '_vision')
            source = await asyncio.to_thread(subprocess.check_output,
                ['git', 'show', f'{baseline}:server/src/practiq_ai/graphs/document.py'], cwd=ROOT, text=True)
            node = next(node for node in ast.parse(source).body if isinstance(node, ast.ClassDef) and node.name == 'OcrPageParseResult')
            exec(compile(ast.Module(body=[node], type_ignores=[]), '<baseline OCR model>', 'exec'), original.__globals__)  # noqa: S102 - explicitly selected Git baseline
            assert original.__globals__['OcrPageParseResult'].model_json_schema() == document.OcrPageParseResult.model_json_schema()

            async def run(function, label):
                for key in work:
                    work[key] = 0
                value = await function(state, Runtime(context=None))
                counts[label].append(work.copy())
                return value

            def check(value):
                assert not value['failures']
                assert len(value['visionResults'][0]['parsed']['questions']) == bool(rows)

            report = await measure(lambda: run(original, 'before'), lambda: run(document._vision, 'after'), check)
            assert all(item == counts['before'][0] for item in counts['before'])
            assert all(item == counts['after'][0] for item in counts['after'])
            return {'rows': rows, 'neighbors': context, 'inputSha256': digest([reply, state]), 'timing': report,
                    'workPerCall': {key: values[0] for key, values in counts.items()}}
        finally:
            store._executor.shutdown(wait=True)


async def profile(baseline):
    return [await workload(baseline, rows, context) for rows, context in [(0, True), (20, False), (1000, False), (1000, True)]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    baseline = subprocess.check_output(['git', 'rev-parse', args.baseline], cwd=ROOT, text=True).strip()
    report = {'baseline': baseline, 'python': platform.python_version(), 'platform': platform.platform(),
              'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'sourceSha256': hashlib.sha256(Path(document.__file__).read_bytes()).hexdigest(),
              'scope': 'Complete _vision node with synthetic model substitutes, real local artifact reads and hash checks, no provider latency. Three serial before/after pairs, one warmup and seven samples each; warm OS cache, GC enabled. Output hashes must match.',
              'workloads': asyncio.run(profile(baseline))}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
