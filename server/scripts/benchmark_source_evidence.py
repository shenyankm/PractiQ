"""Compare source evidence and passive completed-result projection on disposable inputs."""

import argparse
import asyncio
import hashlib
import inspect
import json
import platform
import subprocess
from pathlib import Path
from statistics import median
from tempfile import TemporaryDirectory
from time import perf_counter
from typing import Any

import pytest
from benchmark_web_server import ROOT, baseline_function, digest

from practiq_ai.config import load
from practiq_ai.contracts import (
    DocumentParseResult,
    DocumentReference,
    ParsedQuestion,
    QuestionSource,
    document_source_key,
)
from practiq_ai.graphs import chunking, document
from practiq_ai.storage import ObjectStore


def fixture(count, shape):
    questions, sources, units, parts = [], [], [], []
    spans: list[chunking.ChunkSpan] = []
    offset = 0
    for unit_index in range(4 if shape == 'multi-unit' else 1):
        indexes = range(count * unit_index // 4, count * (unit_index + 1) // 4) if shape == 'multi-unit' else range(count)
        records = []
        csv = shape == 'csv'
        for physical, index in enumerate(indexes, 1):
            record = (f'{physical}\t{physical}\t\t\tShort answer\tPrompt {index}\tAnswer {index}' if csv else
                      f'{physical}. Short answer: Prompt {index}\nReference answer: Answer {index}')
            records.append(record)
            questions.append(ParsedQuestion(id=f'q{index}', stem=f'Prompt {index}', answerMode='short_answer',
                                            answerPayload={'text': f'Answer {index}'}, sourceText=None if shape == 'no-quote' else record))
        header = 'id\troot_task\tparent_id\toption_owner\tquestion_type\tstem\tanswer\n' if csv else ''
        text = header + ('\n' if csv else '\n\n').join(records)
        local, _, _ = chunking.split_chunk_plan(text, source_type='csv' if csv else 'text', tabular_rows_safe=csv)
        for index, record in zip(indexes, records, strict=True):
            left = text.index(record)
            chunk = next(i for i, span in enumerate(local) if span['start'] <= left and left + len(record) <= span['end'])
            sources.append(QuestionSource(questionIndex=index, stage='document_parse', unitIndex=len(spans) + chunk))
        spans.extend({'start': span['start'] + offset, 'end': span['end'] + offset,
                      'overlapStart': span['overlapStart'] + offset, 'overlapEnd': span['overlapEnd'] + offset} for span in local)
        units.append({'start': offset, 'end': offset + len(text), 'sourceType': 'csv' if csv else 'text',
                      'sourceIndex': unit_index, 'tabularRowsSafe': csv})
        parts.append(text)
        offset += len(text) + 2
    DocumentParseResult(schemaVersion=3, missingFields=[], questions=questions, groups=[],
                        visualElements=[], warnings=[], confidenceScore=100)
    return '\n\n'.join(parts), questions, sources, spans, units


async def measure(before, after, check):
    report: dict[str, Any] = {name: {'samplesMs': []} for name in ('before', 'after')}
    expected = None
    for pair in range(3):
        for name, function in [('before', before), ('after', after)]:
            for iteration in range(8):
                started = perf_counter()
                value = await function()
                elapsed = (perf_counter() - started) * 1000
                check(value)
                output = digest(value)
                if expected is None:
                    expected = output
                assert output == expected, (name, pair, iteration)
                if iteration:
                    report[name]['samplesMs'].append(elapsed)
    for item in report.values():
        item.update(medianMs=median(item['samplesMs']), outputSha256=expected)
    report['reductionPercent'] = (1 - report['after']['medianMs'] / report['before']['medianMs']) * 100
    return report


async def profile_case(original, optimized, count, shape):
    text, questions, sources, spans, units = fixture(count, shape)
    input_hash = digest([text, [q.model_dump(mode='json') for q in questions], [s.model_dump() for s in sources], spans, units])

    def check(value):
        assert len(value) == count
        if shape == 'no-quote':
            assert all(proof is None for proof in value.values())
        else:
            assert all(value.values())

    async def run(function):
        return function(text, questions, sources, spans, text_units=units)

    row = {'questions': count, 'shape': shape, 'sourceBytes': len(text.encode()), 'chunks': len(spans), 'inputSha256': input_hash}
    row['sourceEvidence'] = await measure(lambda: run(original), lambda: run(optimized), check)
    assert input_hash == digest([text, [q.model_dump(mode='json') for q in questions], [s.model_dump() for s in sources], spans, units])
    if shape == 'typed':
        with TemporaryDirectory() as directory, pytest.MonkeyPatch.context() as patch:
            patch.setenv('AI_READ_ONLY', '1')
            patch.setenv('AI_SERVICE_TOKEN', 'synthetic-benchmark-only')
            patch.setenv('AI_STORAGE_DIR', directory)
            store = ObjectStore(load())
            try:
                payload = text.encode()
                source_hash = hashlib.sha256(payload).hexdigest()
                reference = await store.put_artifact(payload, source_sha256=source_hash, kind='text', index=0, media_type='text/plain')
                source = DocumentReference(objectKey=document_source_key('text', source_hash), sha256=source_hash,
                                           sizeBytes=len(payload), mediaType='text/plain', sourceType='text', fileName='synthetic.txt')
                state: document.DocumentState = {'document': source.model_dump(mode='json'), 'textRef': reference.model_dump(mode='json'),
                                                 'textUnits': units, 'chunkSpans': spans, 'chunkResults': []}
                for index in range(len(spans)):
                    selected = [questions[s.questionIndex].model_dump(mode='json') for s in sources if s.unitIndex == index]
                    state['chunkResults'].append({'index': index, 'parsed': {'questions': selected, 'groups': []}})
                state_hash = digest(state)
                patch.setattr(document, 'get_object_store', lambda: store)

                async def project(function):
                    with pytest.MonkeyPatch.context() as selected:
                        selected.setattr(document, 'build_source_evidence', function)
                        return await document.completed_result(state)

                def check_projection(value):
                    assert value['status'] == 'PARTIAL' and len(value['result']['questions']) == count
                    assert 'questions' in value['result']['missingFields'] and value['processing']['quality']['reviewRequired']

                row['completedProjection'] = await measure(lambda: project(original), lambda: project(optimized), check_projection)
                assert digest(state) == state_hash
            finally:
                store._executor.shutdown(wait=True)
    return row


async def profile(baseline):
    original = baseline_function(baseline, chunking, 'build_source_evidence')
    return [await profile_case(original, chunking.build_source_evidence, count, shape)
            for count, shape in [(20, 'typed'), (1000, 'typed'), (20, 'csv'), (1000, 'csv'),
                                 (1000, 'multi-unit'), (1000, 'no-quote')]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    baseline = subprocess.check_output(['git', 'rev-parse', args.baseline], cwd=ROOT, text=True).strip()
    report = {'baseline': baseline, 'python': platform.python_version(), 'platform': platform.platform(),
              'scope': 'Serial local CPU and passive completed-result projection with verified disposable local storage. Three alternating pairs, each with one warmup and seven samples. Setup, checks and output hashing excluded; GC enabled. No DB, HTTP, worker/checkpoint, Office, extraction or model latency claim.',
              'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'functionSha256': hashlib.sha256(inspect.getsource(chunking.build_source_evidence).encode()).hexdigest(),
              'sourceSha256': {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                               for path in (Path(chunking.__file__), Path(document.__file__))},
              'workloads': asyncio.run(profile(baseline))}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    for row in report['workloads']:
        print(row['questions'], row['shape'], {key: {version: round(row[key][version]['medianMs'], 3) for version in ('before', 'after')}
                                              for key in ('sourceEvidence', 'completedProjection') if key in row})


if __name__ == '__main__':
    main()
