"""Paired, isolated CPU probes for the November 5 source-validation experiments."""

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
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[2]
MODULES = ('chunking', 'answer_evidence')


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def load(directory):
    import practiq_ai.graphs

    for name in MODULES:
        path = directory / f'{name}.py'
        module = ModuleType(f'practiq_ai.graphs.{name}')
        module.__file__ = str(path)
        module.__package__ = 'practiq_ai.graphs'
        sys.modules[module.__name__] = module
        setattr(practiq_ai.graphs, name, module)
        exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)  # noqa: S102 - trusted local source snapshots


def fixture(count, shape):
    from practiq_ai.contracts import ParsedQuestion

    questions = []
    records = []
    for i in range(1, count + 1):
        stem = f'Printed prompt {i}?'
        record = (f'{i}\t{i}\t\t\tShort answer\t{stem}\tAnswer {i}' if shape == 'table' else
                  f'{i}. Short answer: {stem}\nReference answer: Answer {i}\nSupplied explanation: Reason {i}')
        records.append(record)
        questions.append(ParsedQuestion(id=f'q{i}', stem=stem, answerMode='short_answer',
            answerPayload={'text': f'Answer {i}'}, sourceText=None if shape == 'no-quote' else record))
    header = 'id\troot_task\tparent_id\toption_owner\tquestion_type\tstem\treference_answer\n' if shape == 'table' else ''
    return header + '\n'.join(records), questions


def workload(case, count, shape, resources):
    from practiq_ai.contracts import QuestionSource
    from practiq_ai.graphs import answer_evidence as answers
    from practiq_ai.graphs import chunking

    text, questions = fixture(count, shape)
    options = {'source_type': 'csv' if shape == 'table' else 'text', 'tabular_rows_safe': shape == 'table'}
    spans, _, _ = chunking.split_chunk_plan(text, **options)
    if case == 'projection':
        from practiq_ai.config import load
        from practiq_ai.contracts import DocumentReference, document_source_key
        from practiq_ai.graphs import document
        from practiq_ai.storage import ObjectStore

        directory = resources.enter_context(TemporaryDirectory(prefix='practiq-validation-bench-'))
        runner = resources.enter_context(asyncio.Runner())
        store = ObjectStore(replace(load(), storage_dir=Path(directory)))
        resources.callback(store._executor.shutdown, wait=True)
        document.get_object_store = lambda: store
        payload = text.encode()
        sha = hashlib.sha256(payload).hexdigest()
        reference = DocumentReference(objectKey=document_source_key('text', sha), sha256=sha,
            sizeBytes=len(payload), mediaType='text/plain', sourceType='text', fileName='synthetic.txt')
        artifact = runner.run(store.put_artifact(payload, source_sha256=sha, kind='text', index=0, media_type='text/plain'))
        state = {'document': reference.model_dump(mode='json'), 'textRef': artifact.model_dump(mode='json'),
                 'chunkSpans': spans, 'chunkResults': []}
        for index, span in enumerate(spans):
            selected = [q.model_dump(mode='json') for q in questions if
                        span['start'] <= text.index(q.sourceText or '') < span['end']]
            state['chunkResults'].append({'index': index, 'parsed': {'questions': selected, 'groups': []}})
        before = digest(state)

        def project():
            value = runner.run(document.completed_result(cast(Any, state)))
            assert value['status'] == 'PARTIAL' and len(value['result']['questions']) == count
            assert value['processing']['quality']['reviewRequired']
            assert digest(state) == before
            return value
        return project
    if case == 'presence':
        return lambda: chunking.source_presence_plan(text, spans, **options)
    if case == 'cold-plan':
        def plan():
            chunking._typed_frames.cache_clear()
            chunking._table_frames.cache_clear()
            spans, header, counts = chunking.split_chunk_plan(text, **options)
            return spans, header, counts, chunking.source_presence_plan(text, spans, **options)
        return plan
    if case == 'answers':
        def retain():
            candidates = [q.model_copy(deep=True) for q in questions]
            changes = answers.retain_source_answers(candidates, text, [])
            return changes, [q.model_dump(mode='json') for q in candidates]
        return retain
    if case == 'records':
        return lambda: answers._records(text, group_items=shape == 'grouped')
    if case == 'answer-match':
        return lambda: [answers._answer_matches(q, f'Answer {i}') for i, q in enumerate(questions, 1)]
    if case in {'normalize', 'literal'}:
        raw = ('中\u3000文\tA\r\nB\u0085C\u001cD ' if shape == 'unicode' else 'Some supplied source text. \n') * count
        return (lambda: chunking._normalized_source(raw, 371)) if case == 'normalize' else lambda: answers._literal(raw)
    if case == 'scalar':
        return lambda: [answers._scalar_matches(str(i) + '.', str(i)) for i in range(count)]
    if case == 'evidence':
        sources = []
        offset = 0
        for i, q in enumerate(questions):
            record = fixture(1, shape)[0] if q.sourceText is None else q.sourceText
            left = text.index(record, offset)
            offset = left + len(record)
            unit = next(n for n, span in enumerate(spans) if span['start'] <= left and offset <= span['end'])
            sources.append(QuestionSource(questionIndex=i, stage='document_parse', unitIndex=unit))
            if shape == 'partial':
                q.sourceText = (q.sourceText or '').partition('\n')[0]
        return lambda: chunking.build_source_evidence(text, questions, sources, spans, **options)
    if case == 'duplicates':
        return lambda: chunking.find_duplicate_question_trees(questions, [], [])
    if case == 'trees':
        return lambda: chunking._whole_question_trees(questions)
    raise ValueError(case)


CASES = {
    'presence': [(20, 'typed'), (1000, 'typed'), (1000, 'table')],
    'cold-plan': [(20, 'typed'), (1000, 'typed'), (1000, 'table')],
    'answers': [(20, 'typed'), (1000, 'typed'), (1000, 'table'), (1000, 'no-quote')],
    'records': [(20, 'typed'), (1000, 'typed'), (1000, 'table'), (1000, 'grouped')],
    'answer-match': [(20, 'typed'), (1000, 'typed')],
    'normalize': [(20, 'ascii'), (1500, 'ascii'), (3000, 'unicode')],
    'literal': [(20, 'ascii'), (1500, 'ascii'), (3000, 'unicode')],
    'scalar': [(20, 'numeric'), (1000, 'numeric')],
    'evidence': [(20, 'typed'), (1000, 'typed'), (1000, 'partial'), (1000, 'table')],
    'duplicates': [(20, 'typed'), (1000, 'typed'), (1000, 'no-quote')],
    'trees': [(20, 'typed'), (1000, 'typed')],
    'projection': [(20, 'typed'), (1000, 'typed')],
}


def worker(directory, cases):
    os.environ['AI_READ_ONLY'] = '1'
    load(directory)
    result = []
    for case in cases:
        for count, shape in CASES[case]:
            with ExitStack() as resources:
                run = workload(case, count, shape, resources)
                expected = digest(run())
                samples = []
                for _ in range(7):
                    start = time.perf_counter()
                    value = run()
                    samples.append((time.perf_counter() - start) * 1000)
                    assert digest(value) == expected
                result.append({'case': case, 'count': count, 'shape': shape, 'samplesMs': samples, 'outputSha256': expected})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path)
    parser.add_argument('--after', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--cases', nargs='+', choices=CASES, required=True)
    parser.add_argument('--worker', type=Path)
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.worker, args.cases)))
        return
    if not args.before or not args.after or not args.output:
        parser.error('--before, --after and --output are required')
    pairs = []
    for pair in range(3):
        runs = {}
        for label in (('before', 'after') if pair % 2 == 0 else ('after', 'before')):
            directory = getattr(args, label)
            runs[label] = json.loads(subprocess.check_output(
                [sys.executable, __file__, '--worker', str(directory), '--cases', *args.cases], text=True))
        pairs.append(runs)
    rows = []
    for i, case in enumerate(pairs[0]['before']):
        assert len({pair[label][i]['outputSha256'] for pair in pairs for label in ('before', 'after')}) == 1
        row = {key: case[key] for key in ('case', 'count', 'shape', 'outputSha256')}
        for label in ('before', 'after'):
            samples = [sample for pair in pairs for sample in pair[label][i]['samplesMs']]
            row[label] = {'samplesMs': samples, 'medianMs': statistics.median(samples)}
        row['reductionPercent'] = 100 * (1 - row['after']['medianMs'] / row['before']['medianMs'])
        rows.append(row)
        print(row['case'], row['count'], row['shape'],
              *(round(row[label]['medianMs'], 4) for label in ('before', 'after')), round(row['reductionPercent'], 1))
    report = {'python': platform.python_version(), 'platform': platform.platform(),
        'method': 'Three alternating AB/BA pairs of isolated processes; one warmup, seven samples each; GC enabled. '
                  'Fixture setup and output hashes excluded, except projection includes an unchanged-input digest. '
                  'Answers include defensive copies and result serialization. Projection includes real verified temporary storage. '
                  'Warm frame caches except cold-plan. Synthetic local work only; no model, DB, network or end-to-end import claim.',
        'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'sourceSha256': {label: {name: hashlib.sha256((getattr(args, label) / f'{name}.py').read_bytes()).hexdigest()
                               for name in MODULES} for label in ('before', 'after')}, 'workloads': rows}
    args.output.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
