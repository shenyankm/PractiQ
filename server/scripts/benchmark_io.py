"""Compare verified local I/O with a Git baseline; no providers or user data."""

import argparse
import asyncio
import hashlib
import json
import os
import platform
import stat
import subprocess
import tracemalloc
from dataclasses import replace
from pathlib import Path
from statistics import median
from tempfile import TemporaryDirectory
from time import perf_counter, process_time
from types import SimpleNamespace
from typing import Any, cast

import pytest
from benchmark_web_server import ROOT, baseline_function

from practiq_ai import database, storage, task_api, webapp
from practiq_ai.config import load
from tests.db_support import cleanup, new_database
from tests.support import make_image, parsed, upload


def summaries(rows):
    return {label: {'samples': samples, 'medianMs': median(row['ms'] for row in samples)} for label, samples in rows.items()}


async def artifacts(baseline):
    rows = {label: [] for label in ('before', 'after')}
    original = baseline_function(baseline, storage, 'ObjectStore')
    for pair in range(3):
        for label in (('before', 'after') if pair % 2 == 0 else ('after', 'before')):
            with TemporaryDirectory(prefix='practiq-io-artifacts-') as directory:
                store = (original if label == 'before' else storage.ObjectStore)(replace(load(), storage_dir=Path(directory)))
                counts = {'file': 0, 'directory': 0}
                sync = os.fsync
                def observed(fd, counts=counts, sync=sync):
                    counts['directory' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file'] += 1
                    sync(fd)
                try:
                    with pytest.MonkeyPatch.context() as patch:
                        patch.setattr(os, 'fsync', observed)
                        started = perf_counter()
                        references = [await store.put_artifact(b'synthetic artifact', source_sha256='a' * 64,
                            kind='unit-result', index=index, media_type='application/json') for index in range(100)]
                        elapsed = (perf_counter() - started) * 1000
                    assert all([await store.get_verified(ref) == b'synthetic artifact' for ref in references])
                    rows[label].append({'ms': elapsed, 'fsync': counts})
                finally:
                    store._executor.shutdown()
    return {'artifacts': 100, **summaries(rows)}


async def authorization(baseline):
    with TemporaryDirectory(prefix='practiq-io-auth-') as directory:
        store = storage.ObjectStore(replace(load(), storage_dir=Path(directory)))
        try:
            images, units = [], []
            for index in range(100):
                image = await store.put_artifact(make_image(), source_sha256='a' * 64, kind='visual', index=index, media_type='image/png')
                payload = json.dumps({'parsed': parsed(), 'visuals': [{'kind': 'image', 'description': 'Synthetic figure', 'imageRef': image.model_dump()}]}).encode()
                result = await store.put_artifact(payload, source_sha256='a' * 64, kind='unit-result', index=index, media_type='application/json')
                images.append(image.model_dump())
                units.append({'index': index, 'parsed': {'questionCount': 1}, 'resultRef': result.model_dump(), 'publicRefs': [image.model_dump()]})
            snapshot = SimpleNamespace(values={'visionResults': units})
            rows = {label: [] for label in ('before', 'after')}
            reads = 0
            read = task_api.load_unit_result
            async def counted(*args):
                nonlocal reads
                reads += 1
                return await read(*args)
            with pytest.MonkeyPatch.context() as patch:
                patch.setattr(task_api, 'get_object_store', lambda: store)
                patch.setattr(task_api, 'load_unit_result', counted)
                original = baseline_function(baseline, task_api, 'artifact_is_public')
                for pair in range(3):
                    for label in (('before', 'after') if pair % 2 == 0 else ('after', 'before')):
                        reads = 0
                        function = original if label == 'before' else task_api.artifact_is_public
                        started = perf_counter()
                        allowed = [await function(cast(Any, snapshot), 'a' * 64, image) for image in images]
                        elapsed = (perf_counter() - started) * 1000
                        assert all(allowed)
                        rows[label].append({'ms': elapsed, 'unitFileReads': reads})
            return {'units': 100, 'distinctImageAuthorizations': 100, **summaries(rows)}
        finally:
            store._executor.shutdown()


async def uploads(baseline):
    original = baseline_function(baseline, webapp, 'upload_content')
    original_store = baseline_function(baseline, storage, 'ObjectStore')
    chunk = b'synthetic source\n' * 4096
    count = 256
    metadata = upload(chunk * count)
    async def chunks():
        for _ in range(count):
            yield chunk
    rows = {label: [] for label in ('before', 'after')}
    for pair in range(4):
        for label in (('before', 'after') if pair % 2 == 0 else ('after', 'before')):
            with TemporaryDirectory(prefix='practiq-io-upload-') as directory:
                store = (original_store if label == 'before' else storage.ObjectStore)(replace(load(), storage_dir=Path(directory)))
                await store.require_available()
                try:
                    with pytest.MonkeyPatch.context() as patch:
                        patch.setattr(webapp, 'get_object_store', lambda store=store: store)
                        original.__globals__['get_object_store'] = lambda store=store: store
                        if pair == 3:
                            tracemalloc.start()
                        started = perf_counter()
                        reference = await (original if label == 'before' else webapp.upload_content)(cast(Any, SimpleNamespace(stream=chunks)), metadata)
                        elapsed = (perf_counter() - started) * 1000
                        if pair == 3:
                            peak = tracemalloc.get_traced_memory()[1]
                            tracemalloc.stop()
                            rows[label].append({'ms': elapsed, 'instrumentedPeakPythonBytes': peak})
                        else:
                            rows[label].append({'ms': elapsed})
                    assert reference.sha256 == metadata.sha256 and await store.get_verified(reference) == chunk * count
                finally:
                    store._executor.shutdown()
    return {'sourceBytes': metadata.sizeBytes, 'chunkBytes': len(chunk),
            **{label: {'samples': samples[:3], 'medianMs': median(row['ms'] for row in samples[:3]),
                       'instrumentedPeakPythonBytes': samples[3]['instrumentedPeakPythonBytes']} for label, samples in rows.items()}}


async def verified_reads(baseline):
    original = baseline_function(baseline, storage, 'ObjectStore')
    original.get_verified.__globals__['verify_payload'] = baseline_function(baseline, storage, 'verify_payload')
    results = []
    for size, count, concurrency in ((4096, 100, 1), (4096, 100, 8),
                                     (128 * 1024, 40, 1), (128 * 1024, 40, 8),
                                     (load().source_max_bytes, 4, 1), (load().source_max_bytes, 4, 4)):
        payload = (b'synthetic source\n' * (size // 17 + 1))[:size]
        rows = {label: [] for label in ('before', 'after')}
        for pair in range(3):
            for label in (('before', 'after') if pair % 2 == 0 else ('after', 'before')):
                with TemporaryDirectory(prefix='practiq-io-reads-') as directory:
                    store = (original if label == 'before' else storage.ObjectStore)(replace(load(), storage_dir=Path(directory)))
                    try:
                        reference = await store.put_document(payload, upload(payload))
                        gate = asyncio.Semaphore(concurrency)
                        async def read(gate=gate, store=store, reference=reference):
                            async with gate:
                                return await store.get_verified(reference)
                        for iteration in range(8):
                            cpu = process_time()
                            started = perf_counter()
                            values = await asyncio.gather(*(read() for _ in range(count)))
                            elapsed = (perf_counter() - started) * 1000
                            cpu_ms = (process_time() - cpu) * 1000
                            assert len(values) == count and all(value == payload for value in values)
                            del values
                            rows[label].append({'pair': pair, 'firstBatch': iteration == 0,
                                                'ms': elapsed, 'cpuMs': cpu_ms})
                        calls = 0
                        default_calls = 0
                        call = store._call
                        to_thread = asyncio.to_thread
                        async def observed(*args, call=call):
                            nonlocal calls
                            calls += 1
                            return await call(*args)
                        async def offload(*args, to_thread=to_thread, **kwargs):
                            nonlocal default_calls
                            default_calls += 1
                            return await to_thread(*args, **kwargs)
                        with pytest.MonkeyPatch.context() as patch:
                            patch.setattr(store, '_call', observed)
                            patch.setattr(asyncio, 'to_thread', offload)
                            tracemalloc.start()
                            values = await asyncio.gather(*(read() for _ in range(count)))
                            peak = tracemalloc.get_traced_memory()[1]
                            tracemalloc.stop()
                            assert all(value == payload for value in values)
                            rows[label][-1].update(instrumentedPeakPythonBytes=peak, storageJobs=calls,
                                                   defaultThreadJobs=default_calls)
                    finally:
                        store._executor.shutdown()
        report = {'sourceBytes': size, 'readsPerBatch': count, 'clientConcurrency': concurrency,
                  'storageConcurrency': load().storage_concurrency, 'outputSha256': hashlib.sha256(payload).hexdigest()}
        for label, samples in rows.items():
            warm = [row for row in samples if not row['firstBatch']]
            timings = sorted(row['ms'] for row in warm)
            report[label] = {'samples': samples, 'warmMedianMs': median(timings),
                             'warmP95Ms': timings[int((len(timings) - 1) * .95)],
                             'medianCpuMs': median(row['cpuMs'] for row in warm)}
        results.append(report)
    return results


async def connections(baseline):
    db = await new_database()
    original = baseline_function(baseline, database, 'Database')(db.uri)
    await original.open()
    rows = {label: [] for label in ('before', 'after')}
    try:
        async with db.connection() as conn:
            await conn.execute('CREATE TABLE io_probe(value integer)')
            await conn.execute('INSERT INTO io_probe VALUES(0)')
        for pair in range(3):
            for label in (('before', 'after') if pair % 2 == 0 else ('after', 'before')):
                await db.rows('UPDATE io_probe SET value=0 RETURNING value')
                backends = set()
                selected = original if label == 'before' else db
                started = perf_counter()
                for index in range(30):
                    async with selected.connection() as conn:
                        backends.add(conn.info.backend_pid)
                        row = await (await conn.execute('UPDATE io_probe SET value=value+1 RETURNING value')).fetchone()
                        assert row is not None and row['value'] == index + 1
                rows[label].append({'ms': (perf_counter() - started) * 1000, 'backendCount': len(backends)})
        return {'durableAutocommitWrites': 30, **summaries(rows)}
    finally:
        await original.close()
        await cleanup()


async def profile(baseline):
    return {'artifacts': await artifacts(baseline), 'authorization': await authorization(baseline),
            'uploads': await uploads(baseline), 'verifiedReads': await verified_reads(baseline),
            'postgres': await connections(baseline)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    baseline = subprocess.check_output(['git', 'rev-parse', args.baseline], cwd=ROOT, text=True).strip()
    with pytest.MonkeyPatch.context() as patch:

        patch.setenv('AI_READ_ONLY', '1')
        source_hashes = {}
        for module in (storage, task_api, webapp, database):
            assert module.__file__ is not None
            path = Path(module.__file__)
            source_hashes[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
        report = {'baseline': baseline, 'python': platform.python_version(), 'platform': platform.platform(),
                  'scope': 'Three alternating before/after pairs on temporary local files and disposable PostgreSQL. '
                           'Artifact samples include real fsync with call-count instrumentation; authorization measures only the membership check using real verified unit files. '
                           'Upload calls the route with generated chunks, preserves read-back verification and includes one separate tracemalloc run. '
                           'Verified reads: three alternating pairs per workload, one first batch and seven warm batches per process/store; '
                           'first batches follow fixture publication and are not cold OS-cache reads. Equality assertions are outside timing. '
                           'Warm p95 is nearest-rank over 21 batches; traced allocation/work counts are separate instrumented batches. '
                           'No OS cache flush, warmup exclusion, user data, providers, TCP upload, UI, whole-process RSS or power-loss measurement.',
                  'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  'sourceSha256': source_hashes, **asyncio.run(profile(baseline))}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    for name in ('artifacts', 'authorization', 'uploads', 'postgres'):
        print(name, {label: round(report[name][label]['medianMs'], 3) for label in ('before', 'after')})


if __name__ == '__main__':
    main()
