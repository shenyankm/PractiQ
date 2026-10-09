"""Measure the existing Office payload-check boundary; no worker, database or model."""
import asyncio
import hashlib
import json
import platform
import statistics
import subprocess
import sys
import time
from pathlib import Path

root = Path.cwd()
sys.path.insert(0, str(root/'server/src'))
from practiq_ai import office_service
from practiq_ai.config import Config
from practiq_ai.contracts import DocumentReference
from practiq_ai.errors import DocumentProcessingError

output = Path(sys.argv[1])
assert not output.exists()
config = Config(provider='openai', api_key='synthetic-unused', model_id='unused', storage_dir=output.parent,
    source_max_bytes=25*1024*1024, vision_max_bytes=50*1024*1024, max_document_pages=100,
    max_vision_page_pixels=25000000, max_total_input_chars=2000000, graph_max_concurrency=2,
    storage_concurrency=4, storage_timeout_seconds=30, model_timeout_seconds=180, model_max_tokens=16384)
payload = b'x'*(25*1024*1024)
digest = hashlib.sha256(payload).hexdigest()
ref = DocumentReference(objectKey=f'practiq-agent/sources/{digest}/source.docx', sha256=digest,
    sizeBytes=len(payload), mediaType='application/octet-stream', sourceType='docx', fileName='synthetic.docx')
async def stop_after_checksum(*args, **kwargs):
    raise DocumentProcessingError(422, 'Probe stops before engine/file/worker access', 'CHECKSUM_PROBE_DONE')
office_service._thread_io = stop_after_checksum
async def sample():
    gaps = []
    done = False
    async def heartbeat():
        last = time.perf_counter()
        while not done:
            await asyncio.sleep(.001)
            now = time.perf_counter()
            gaps.append((now-last)*1000)
            last = now
    task = asyncio.create_task(heartbeat())
    await asyncio.sleep(.005)
    started = time.perf_counter()
    try:
        await office_service.convert_office(ref, payload, mode='pdf', config=config, timeout=30)
    except DocumentProcessingError as error:
        assert error.code == 'CHECKSUM_PROBE_DONE', error.code
    else: raise AssertionError('Office probe did not stop at the intended boundary')
    elapsed = (time.perf_counter()-started)*1000
    await asyncio.sleep(.005)
    done = True
    await task
    return {'elapsedMs': elapsed, 'maxHeartbeatGapMs': max(gaps), 'heartbeatSamplesMs': gaps}
async def main():
    await sample()
    rows = [dict(repeat=i+1, **await sample()) for i in range(3)]
    report = {'sourceSha': subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
      'environment': {'os': platform.platform(), 'python': platform.python_version()},
      'inputBytes':len(payload), 'inputSha256':digest,
      'inputs':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['server/src/practiq_ai/office_service.py','server/src/practiq_ai/storage.py','server/uv.lock']},
      'method':'Warm immutable 25MiB buffer, one warmup, three repetitions; 1ms event-loop heartbeat. Stop at the existing engine boundary after source checks. No Office engine, worker, disk throughput, task queue or model is benchmarked.',
      'samples':rows, 'summary':{k:{'median':statistics.median(s[k] for s in rows),'min':min(s[k] for s in rows),'max':max(s[k] for s in rows)} for k in ['elapsedMs','maxHeartbeatGapMs']}}
    output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report['summary']),flush=True)
asyncio.run(main())
