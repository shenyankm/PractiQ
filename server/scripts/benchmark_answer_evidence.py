"""Compare answer-source validation in alternating, isolated Python processes."""

import argparse
import hashlib
import json
import platform
import subprocess
import sys
from pathlib import Path
from statistics import median
from time import perf_counter

from benchmark_web_server import ROOT, baseline_function, digest

from practiq_ai.contracts import ParsedQuestion
from practiq_ai.graphs import answer_evidence

CASES = [(20, 'local'), (1000, 'local'), (1000, 'key'), (1000, 'saved-table'),
         (1000, 'ambiguous'), (1000, 'no-fields'), (1000, 'records-only'),
         (20, 'composite'), (1000, 'composite')]


def fixture(count, shape):
    if shape == 'composite':
        evaluations = ROOT / 'server/evals'
        case = next(case for case in json.loads((evaluations / 'cases.json').read_text())['cases'] if case['id'] == 'text-composites')
        composites = [ParsedQuestion.model_validate(question) for question in case['expectedQuestions'][2:7]]
        questions, primary, contexts = fixture(count - len(composites), 'no-fields')
        return questions + composites, primary + '\n' + (evaluations / case['path']).read_text(), contexts
    questions, records, keys = [], [], []
    for index in range(count):
        number = index + 1
        stem = 'Repeated prompt?' if shape == 'ambiguous' else f'Printed prompt {index}?'
        answer = f'Supplied answer {index}'
        questions.append(ParsedQuestion(id=f'q{index}', stem=stem, answerMode='short_answer',
                                        answerPayload=None if shape == 'no-fields' else {'text': answer}))
        if shape == 'saved-table':
            records.append(f'{number}\t{stem}\t{answer}')
        else:
            records.append(f'{number}. Short answer: {stem}' + ('' if shape == 'key' else f'\nAnswer: {answer}'))
        keys.append(f'{number}. {answer}')
    primary = '\n'.join(records)
    if shape == 'saved-table':
        primary = 'id\tstem\tanswer\n' + primary
    return questions, primary, ['Answers:\n' + '\n'.join(keys)] if shape == 'key' else []


def worker(ref):
    function = (answer_evidence.retain_source_answers if ref == 'current' else
                baseline_function(ref, answer_evidence, 'retain_source_answers'))
    if ref != 'current':
        function.__globals__['_composite_fields'] = baseline_function(ref, answer_evidence, '_composite_fields')
    records = answer_evidence._records if ref == 'current' else baseline_function(ref, answer_evidence, '_records')
    results = []
    for count, shape in CASES:
        questions, primary, contexts = fixture(count, shape)
        samples, output_hash = [], None
        input_hash = digest([[q.model_dump(mode='json') for q in questions], primary, contexts])
        for iteration in range(6):
            candidates = [question.model_copy(deep=True) for question in questions]
            started = perf_counter()
            changes = records(primary) if shape == 'records-only' else function(candidates, primary, contexts)
            elapsed = (perf_counter() - started) * 1000
            if shape == 'records-only':
                assert len(changes) == count
            elif shape == 'composite':
                assert changes == []
                assert [q.model_dump(mode='json') for q in candidates] == [q.model_dump(mode='json') for q in questions]
            actual = digest([changes, [question.model_dump(mode='json') for question in candidates]])
            assert output_hash is None or output_hash == actual
            output_hash = actual
            if iteration:
                samples.append(elapsed)
        assert input_hash == digest([[q.model_dump(mode='json') for q in questions], primary, contexts])
        results.append({'questions': count, 'shape': shape, 'inputSha256': input_hash,
                        'outputSha256': output_hash, 'samplesMs': samples})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--worker', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.worker)))
        return
    if not args.baseline or not args.output:
        parser.error('--baseline and --output are required')
    baseline = subprocess.check_output(['git', 'rev-parse', args.baseline], cwd=ROOT, text=True).strip()
    pairs = []
    for pair in range(3):
        runs = {}
        for label in (('before', 'after') if pair % 2 == 0 else ('after', 'before')):
            ref = baseline if label == 'before' else 'current'
            runs[label] = json.loads(subprocess.check_output([sys.executable, __file__, '--worker', ref], text=True))
        pairs.append(runs)
    workloads = []
    for index, (count, shape) in enumerate(CASES):
        row = {'questions': count, 'shape': shape}
        for field in ('inputSha256', 'outputSha256'):
            hashes = {pair[label][index][field] for pair in pairs for label in ('before', 'after')}
            assert len(hashes) == 1, (shape, field)
            row[field] = hashes.pop()
        for label in ('before', 'after'):
            samples = [sample for pair in pairs for sample in pair[label][index]['samplesMs']]
            row[label] = {'samplesMs': samples, 'medianMs': median(samples)}
        workloads.append(row)
        print(count, shape, {label: round(row[label]['medianMs'], 3) for label in ('before', 'after')})
    source = Path(answer_evidence.__file__)
    report = {'baseline': baseline, 'python': platform.python_version(), 'platform': platform.platform(),
              'scope': 'Three alternating pairs of isolated processes. One warmup and five samples per case/process. '
                       'Fixture creation, copies and hashes excluded; GC enabled. Pure local answer-source validation; '
                       'with an unchanged records-only parser control; no storage, database, HTTP, OCR, model or end-to-end latency claim.',
              'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
              'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'workloads': workloads}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
