"""Compare passive read/planning work against a Git baseline without providers."""

import argparse
import asyncio
import hashlib
import json
import platform
import subprocess
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from statistics import median
from tempfile import TemporaryDirectory
from time import perf_counter
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import httpx
import pytest
from benchmark_source_evidence import measure
from benchmark_web_server import ROOT, baseline_function, digest

from practiq_ai import task_api, webapp
from practiq_ai.config import load
from practiq_ai.contracts import DocumentParseResult
from practiq_ai.database import utcnow
from practiq_ai.graphs import chunking, document
from practiq_ai.storage import ObjectStore
from tests.support import make_image, parsed, question, source


def retained(samples):
    return [value for index, value in enumerate(samples) if index % 8]


async def planning(baseline, count):
    text = '\n'.join(f'{i}. Short answer: Prompt {i} ' + 'printed material ' * 85
                     + f'\nReference answer: A{i}\nSupplied explanation: Reason {i}' for i in range(1, count + 1))
    files, reference = source(text)
    ref = await files.put_artifact(text.encode(), source_sha256=reference['sha256'], kind='text', index=0, media_type='text/plain')
    state = {'document': reference, 'textRef': ref.model_dump(mode='json')}
    lag = {'before': [], 'after': []}
    original = baseline_function(baseline, document, '_assemble')

    async def run(function, label):
        chunking._typed_frames.cache_clear()
        chunking._table_frames.cache_clear()
        ticks = []

        async def heartbeat():
            while True:
                started = perf_counter()
                await asyncio.sleep(.005)
                ticks.append(max(0, (perf_counter() - started - .005) * 1000))

        monitor = asyncio.create_task(heartbeat())
        await asyncio.sleep(0)
        try:
            result = await function(state)
            await asyncio.sleep(.001)
        finally:
            monitor.cancel()
            await asyncio.gather(monitor, return_exceptions=True)
        lag[label].append(max(ticks, default=0))
        return result

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(document, 'get_object_store', lambda: files)
        # The compiled baseline keeps its own module globals.
        original.__globals__['get_object_store'] = lambda: files
        def check(value):
            assert sum(len(part or {}) for part in value['chunkPresence']) == count and value['chunkRefs']

        report = await measure(lambda: run(original, 'before'), lambda: run(document._assemble, 'after'), check)
    for name, values in lag.items():
        report[name]['eventLoopLagSamplesMs'] = retained(values)
        report[name]['medianMaxEventLoopLagMs'] = median(retained(values))
    return {'records': count, 'sourceChars': len(text), 'inputSha256': digest(state), 'planning': report}


async def http_reads(baseline, count):
    thread = str(UUID(int=1))
    now = utcnow()
    result = DocumentParseResult.model_validate({'schemaVersion': 3,
        'questions': [{**question(f'Prompt {i}'), 'id': f'q{i}', 'sourceText': 'Printed source text ' * 100} for i in range(count)],
        'groups': [], 'visualElements': [], 'warnings': [], 'confidenceScore': 80}).model_dump(mode='json')
    task = {'document': source('Synthetic source')[1], 'parent_thread_id': None, 'created_at': now, 'expires_at': now + timedelta(days=1)}
    snapshot = SimpleNamespace(values={'result': result, 'status': 'SUCCEEDED', 'phase': 'completed'},
                               interrupts=(), next=(), created_at=now.isoformat())
    service = SimpleNamespace(db=SimpleNamespace(store=SimpleNamespace(asearch=AsyncMock(return_value=[]))), checkpoint_id=lambda *_: 'synthetic')
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(task_api, 'client', lambda: service)
        patch.setattr(task_api, '_read_task', AsyncMock(return_value=(task, snapshot, None)))
        patch.setattr(task_api, '_calls', AsyncMock(return_value=[]))
        original = baseline_function(baseline, task_api, '_task_detail')
        current = task_api._task_detail
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test',
                                    headers={'Authorization': 'Bearer synthetic-benchmark-only'}) as client:
            async def detail(function):
                with pytest.MonkeyPatch.context() as selected:
                    selected.setattr(task_api, '_task_detail', function)
                    response = await client.get(f'/api/document-tasks/{thread}')
                    assert response.status_code == 200
                    return response.json()

            def check(value):
                assert len(value['result']['questions']) == count

            report = await measure(lambda: detail(original), lambda: detail(current), check)
            detail_response = await client.get(f'/api/document-tasks/{thread}')
            full = await client.get(f'/api/document-tasks/{thread}/preview')
            metadata = await client.get(f'/api/document-tasks/{thread}/preview?include_result=false')
            full_json = full.json()
            assert full.status_code == metadata.status_code == 200
            assert full_json['units'][0]['questions'] == detail_response.json()['result']['questions']
            assert metadata.json() == {**full_json, 'units': []}
            return {'questions': count, 'detail': report, 'payload': {
                'detailBytes': len(detail_response.content), 'fullPreviewBytes': len(full.content),
                'metadataPreviewBytes': len(metadata.content),
                'beforeCombinedBytes': len(detail_response.content) + len(full.content),
                'afterCombinedBytes': len(detail_response.content) + len(metadata.content),
            }}


class PrefixComplete(Exception):
    pass


async def ocr_reads(baseline, count, delay):
    with TemporaryDirectory(prefix='practiq-read-bench-') as directory:
        store = ObjectStore(replace(load(), storage_dir=Path(directory)))
        try:
            reference = source('Synthetic PDF')[1]
            reference.update(sourceType='pdf', mediaType='application/pdf')
            image = await store.put_artifact(make_image(), source_sha256=reference['sha256'], kind='page', index=0, media_type='image/png')
            refs, units = [], []
            for index in range(count):
                text = f'Printed question {index}. ' + 'saved evidence ' * 1300
                ref = await store.put_artifact(json.dumps({'elements': [{'text_info': {'content': text}}]}).encode(),
                                               source_sha256=reference['sha256'], kind='ocr-page', index=index, media_type='application/json')
                refs.append(ref.model_dump(mode='json'))
                units.append({'kind': 'page', 'index': index, 'artifact': image.model_dump(mode='json'), 'parsed': parsed(f'Printed question {index}'), 'visuals': []})
            state = {'document': reference, 'pageRefs': [image.model_dump(mode='json')] * count, 'ocrPageRefs': refs,
                     'visionResults': units, 'visualTotal': count}
            read = store.get_verified
            active = peak = 0
            evidence = []
            peaks = {'before': [], 'after': []}

            async def tracked(ref):
                nonlocal active, peak
                active += 1
                peak = max(peak, active)
                try:
                    if delay:
                        await asyncio.sleep(delay)
                    return await read(ref)
                finally:
                    active -= 1

            def capture(_questions, primary, contexts):
                evidence.append([primary, contexts])
                return []

            def stop(*_args, **_kwargs):
                raise PrefixComplete

            with pytest.MonkeyPatch.context() as patch:
                patch.setattr(store, 'get_verified', tracked)
                patch.setattr(document, 'get_object_store', lambda: store)
                patch.setattr(document, 'retain_source_answers', capture)
                patch.setattr(document, 'merge_chunk_results', stop)
                original = baseline_function(baseline, document, '_merge')

                async def run(function, label):
                    nonlocal peak
                    peak = 0
                    evidence.clear()
                    try:
                        await function(state)
                    except PrefixComplete:
                        pass
                    assert active == 0 and len(evidence) == count
                    peaks[label].append(peak)
                    return evidence.copy()

                def check(value):
                    assert len(value) == count

                report = await measure(lambda: run(original, 'before'), lambda: run(document._merge, 'after'), check)
            return {'pages': count, 'ocrPageBytes': refs[0]['sizeBytes'], 'addedReadDelayMs': delay * 1000,
                    'inputSha256': digest(state), 'mergePrefix': report,
                    'beforePeakReads': max(peaks['before']), 'afterPeakReads': max(peaks['after'])}
        finally:
            store._executor.shutdown(wait=True)


async def profile(baseline):
    return {'planning': [await planning(baseline, count) for count in (20, 1000)],
            'http': [await http_reads(baseline, count) for count in (20, 1000)],
            'ocr': [await ocr_reads(baseline, count, delay) for count, delay in ((30, 0), (100, 0), (30, .002))]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    baseline = subprocess.check_output(['git', 'rev-parse', args.baseline], cwd=ROOT, text=True).strip()
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv('AI_READ_ONLY', '1')
        patch.setenv('AI_SERVICE_TOKEN', 'synthetic-benchmark-only')
        patch.setenv('AI_STORAGE_CONCURRENCY', '4')
        source_hashes = {}
        for module in (document, task_api, webapp):
            assert module.__file__ is not None
            path = Path(module.__file__)
            source_hashes[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
        report = {'baseline': baseline, 'python': platform.python_version(), 'platform': platform.platform(),
                  'scope': 'Three serial before/after pairs, one warmup plus seven measured samples per variant/pair; GC enabled. '
                           'Planning clears source-frame caches and includes a 5ms heartbeat with a 1ms settling wait. '
                           'HTTP uses real ASGI routes with fake task/DB reads. OCR uses verified temporary local files, '
                           'captures source evidence and stops before tree merge; one workload adds controlled 2ms read waits. '
                           'OS caches are not flushed. No providers, production DB, browser, native UI, RSS or end-to-end import measurement.',
                  'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  'sourceSha256': source_hashes,
                  **asyncio.run(profile(baseline))}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    for row in report['planning']:
        print('planning', row['records'], {name: round(row['planning'][name]['medianMaxEventLoopLagMs'], 2) for name in ('before', 'after')})
    for row in report['http']:
        print('http', row['questions'], {name: round(row['detail'][name]['medianMs'], 2) for name in ('before', 'after')}, row['payload'])
    for row in report['ocr']:
        print('ocr', row['pages'], row['addedReadDelayMs'], {name: round(row['mergePrefix'][name]['medianMs'], 2) for name in ('before', 'after')})


if __name__ == '__main__':
    main()
