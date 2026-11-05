"""Repeated verified reads in fresh processes; resource snapshots, not soak guarantees."""

import asyncio
import gc
import hashlib
import json
import os
import resource
import subprocess
import sys
import tempfile
import threading
from dataclasses import replace
from pathlib import Path
from time import process_time

root = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(root / path) for path in ('server/src', 'server', 'server/scripts')]
os.environ['AI_READ_ONLY'] = '1'
from benchmark_web_server import baseline_function
from practiq_ai import storage
from practiq_ai.config import load
from tests.support import upload


async def run(variant):
    store_type = storage.ObjectStore
    if variant == 'before':
        store_type = baseline_function('5973846c', storage, 'ObjectStore')
        store_type.get_verified.__globals__['verify_payload'] = baseline_function('5973846c', storage, 'verify_payload')
    payload = b's' * (128 * 1024)
    samples = []
    with tempfile.TemporaryDirectory(prefix='practiq-repeated-storage-') as directory:
        store = store_type(replace(load(), storage_dir=Path(directory), storage_concurrency=4))
        try:
            reference = await store.put_document(payload, upload(payload))

            def snapshot(cycle):
                gc.collect()
                rss = int(subprocess.check_output(['ps', '-o', 'rss=', '-p', str(os.getpid())], text=True).strip()) * 1024
                threads = [thread.name for thread in threading.enumerate()]
                files = [path for path in store.root.rglob('*') if path.is_file()]
                assert files == [store.root / reference.objectKey]
                assert sum(name.startswith('practiq-storage') for name in threads) <= 4
                samples.append({'cycle': cycle, 'rssBytes': rss, 'fdCount': len(list(Path('/dev/fd').iterdir())),
                                'threads': threads, 'storageBytes': sum(path.stat().st_size for path in files)})

            snapshot(0)
            cpu = process_time()
            for cycle in range(1, 13):
                for _ in range(250):
                    values = await asyncio.gather(*(store.get_verified(reference) for _ in range(10)))
                    assert all(value == payload for value in values)
                    del values
                snapshot(cycle)
            cpu_seconds = process_time() - cpu
            await asyncio.sleep(1)
            snapshot('idle')
            assert len({row['fdCount'] for row in samples}) == 1
            assert all(row['storageBytes'] == len(payload) for row in samples)
            assert await store.get_verified(reference) == payload
        finally:
            store._executor.shutdown()
    return {'variant': variant, 'baseline': '5973846c', 'reads': 30000, 'sourceBytes': len(payload),
            'inputSha256': hashlib.sha256(payload).hexdigest(), 'clientConcurrency': 10,
            'storageConcurrency': 4, 'cpuSecondsIncludingAssertionsAndSnapshots': cpu_seconds,
            'processMaxRssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024),
            'scope': 'Same 30000 verified reads, twelve cycles plus idle. Warm OS cache, sampled RSS/fds/threads. '
                     'No latency comparison, user data, providers, host crash, power loss or long-duration leak guarantee.',
            'samples': samples}


assert sys.argv[1] in {'before', 'after'}
output = Path(__file__).with_name(f'repeated-storage-{sys.argv[1]}.json')
output.write_text(json.dumps(asyncio.run(run(sys.argv[1])), indent=2) + '\n')
