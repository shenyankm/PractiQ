"""Compare extraction IPC protocols in fresh processes, without models or user files."""
import argparse
import asyncio
import base64
import json
import os
import resource
import statistics
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory

from practiq_ai.extractors import ExtractedDocument, isolated


async def worker(mode, mib):
    os.environ.update(AI_SERVICE_TOKEN='benchmark', LLM_PROVIDER='dashscope', LLM_API_KEY='synthetic', LLM_MODEL='synthetic')
    source = ExtractedDocument(text='synthetic', page_images=[b'x' * (1024 * 1024) for _ in range(mib)])
    elapsed, stalls = [], []
    running = False

    async def monitor():
        while running:
            started = time.perf_counter()
            await asyncio.sleep(.005)
            stalls.append(max(0, (time.perf_counter() - started - .005) * 1000))

    with TemporaryDirectory(prefix='practiq-ipc-bench-') as directory:
        root = Path(directory)
        if mode == 'before':
            # Exact former transport: raw bytes encoded into a single JSON document.
            payload = {'document': {'text': source.text, 'warnings': [], 'truncated': False, 'page_images': source.page_images}}
            (root / 'result').write_text(json.dumps(payload, default=lambda value: {'base64': base64.b64encode(value).decode('ascii')}), encoding='utf-8')
        else:
            isolated._write_result(root, source)
        size = sum(p.stat().st_size for p in root.iterdir())
        for _ in range(3):
            running = True
            task = asyncio.create_task(monitor())
            await asyncio.sleep(0)
            started = time.perf_counter()
            if mode == 'before':
                result = json.loads((root / 'result').read_bytes(), object_hook=lambda value: base64.b64decode(value['base64'], validate=True) if set(value) == {'base64'} else value)
                restored = ExtractedDocument(**result['document'])
                del result
            else:
                restored = await isolated._thread_io(isolated._read_result, root)
            elapsed.append((time.perf_counter() - started) * 1000)
            await asyncio.sleep(.01)
            running = False
            await task
            assert restored == source
            del restored
    return {'mode': mode, 'imageMiB': mib, 'transportBytes': size, 'medianReadMs': statistics.median(elapsed),
            'maxEventLoopLagMs': max(stalls), 'peakRssMiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024 if sys.platform == 'darwin' else 1024), 'outputsEqual': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    parser.add_argument('--worker', choices=['before', 'after'])
    parser.add_argument('--mib', type=int, default=50)
    args = parser.parse_args()
    if not 1 <= args.mib <= 50:
        parser.error('--mib must be between 1 and 50')
    if args.worker:
        print(json.dumps(asyncio.run(worker(args.worker, args.mib))))
    else:
        if not args.output:
            parser.error('--output is required')
        report = {mode: json.loads(subprocess.check_output([sys.executable, __file__, '--worker', mode, '--mib', str(args.mib)], text=True)) for mode in ('before', 'after')}
        args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(report))
