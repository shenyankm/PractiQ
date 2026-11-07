"""Compare passive saved-result projection with verified local storage, without providers."""

import argparse
import asyncio
import hashlib
import json
import os
import platform
import statistics
import subprocess
import sys
import time
import tracemalloc
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, cast

from benchmark_twenty_rounds import digest


def worker(snapshot):
    os.environ['AI_READ_ONLY'] = '1'
    sys.path.insert(0, str(snapshot))
    from practiq_ai.config import load
    from practiq_ai.contracts import (
        DocumentReference,
        ParsedQuestion,
        document_source_key,
    )
    from practiq_ai.graphs import chunking, document
    from practiq_ai.source_selection import active_indices
    from practiq_ai.storage import ObjectStore

    rows = []
    for count in (20, 1000):
        with ExitStack() as resources:
            directory = resources.enter_context(TemporaryDirectory(prefix='practiq-perf20-projection-'))
            runner = resources.enter_context(asyncio.Runner())
            os.environ['AI_STORAGE_DIR'] = directory
            store = ObjectStore(load())
            resources.callback(store._executor.shutdown, wait=True)
            document.get_object_store = lambda store=store: store
            records = [f'{i}. Short answer: Printed prompt {i}?\nReference answer: Answer {i}' for i in range(1, count + 1)]
            text = '\n'.join(records)
            payload = text.encode()
            sha = hashlib.sha256(payload).hexdigest()
            reference = DocumentReference(objectKey=document_source_key('text', sha), sha256=sha,
                sizeBytes=len(payload), mediaType='text/plain', sourceType='text', fileName='synthetic.txt')
            artifact = runner.run(store.put_artifact(payload, source_sha256=sha, kind='text', index=0, media_type='text/plain'))
            spans, _, _ = chunking.split_chunk_plan(text)
            state: dict[str, Any] = {'document': reference.model_dump(mode='json'), 'textRef': artifact.model_dump(mode='json'),
                     'chunkSpans': spans, 'chunkResults': []}
            offset = 0
            by_unit: dict[int, list[Any]] = {}
            for index, record in enumerate(records, 1):
                position = text.index(record, offset)
                offset = position + len(record)
                unit = next(number for number, span in enumerate(spans) if span['start'] <= position and offset <= span['end'])
                question = ParsedQuestion(id=f'q{index}', stem=f'Printed prompt {index}?', sourceText=record,
                    answerMode='short_answer', answerPayload={'text': f'Answer {index}'})
                by_unit.setdefault(unit, []).append(question.model_dump(mode='json'))
            state['chunkResults'] = [{'index': index, 'parsed': {'questions': questions, 'groups': []}} for index, questions in by_unit.items()]
            initial = digest(state)

            def run(runner=runner, state=state):
                return runner.run(document.completed_result(cast(Any, state)))

            expected = run()
            assert expected['status'] == 'PARTIAL' and len(expected['result']['questions']) == count
            fingerprint = digest(expected)
            samples = []
            for _ in range(7):
                start = time.perf_counter()
                value = run()
                samples.append((time.perf_counter() - start) * 1000)
                assert digest(value) == fingerprint and digest(state) == initial
            rows.append({'questions': count, 'samplesMs': samples, 'outputSha256': fingerprint})
    state = {'chunkRefs': [None] * 5000, 'selectedUnits': [{'stage': 'document_parse', 'index': index} for index in (1, 4, 8, 17)]}
    tracemalloc.start()
    assert active_indices(state, 'document_parse') == [1, 4, 8, 17]
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return {'workloads': rows, 'sparseSelectionPeakPythonBytes': peak}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path)
    parser.add_argument('--after', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--worker', type=Path)
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.worker)))
        return
    if not args.before or not args.after or not args.output:
        parser.error('--before, --after and --output are required')
    pairs = []
    for index in range(3):
        runs = {}
        for label in (('before', 'after') if index % 2 == 0 else ('after', 'before')):
            runs[label] = json.loads(subprocess.check_output([sys.executable, __file__, '--worker', str(getattr(args, label))], text=True))
        pairs.append(runs)
    rows = []
    for index, first in enumerate(pairs[0]['before']['workloads']):
        assert len({pair[label]['workloads'][index]['outputSha256'] for pair in pairs for label in ('before', 'after')}) == 1
        row = {key: first[key] for key in ('questions', 'outputSha256')}
        for label in ('before', 'after'):
            samples = [sample for pair in pairs for sample in pair[label]['workloads'][index]['samplesMs']]
            row[label] = {'samplesMs': samples, 'medianMs': statistics.median(samples)}
        row['reductionPercent'] = 100 * (1 - row['after']['medianMs'] / row['before']['medianMs'])
        rows.append(row)
    report = {'python': platform.python_version(), 'platform': platform.platform(),
        'method': 'Three alternating fresh-process AB/BA pairs, one warmup, seven samples each; real checksummed temporary local artifacts and passive completed_result. Input/output hashes outside timers. No DB, providers, HTTP, native UI or end-to-end parsing claim.',
        'workloads': rows, 'sparseSelectionPeakPythonBytes': {label: [pair[label]['sparseSelectionPeakPythonBytes'] for pair in pairs] for label in ('before', 'after')},
        'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    for row in rows:
        print(row['questions'], round(row['before']['medianMs'], 3), round(row['after']['medianMs'], 3), round(row['reductionPercent'], 1))


if __name__ == '__main__':
    main()
