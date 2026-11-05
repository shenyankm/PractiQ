"""Paired OCR review/context probes; immutable synthetic evidence, no providers."""

import argparse
import hashlib
import json
import platform
import subprocess
from copy import deepcopy
from io import BytesIO
from pathlib import Path
from statistics import median
from time import perf_counter
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

from benchmark_web_server import baseline_function, digest

from practiq_ai import tencent_bundle, unit_results
from practiq_ai.config import load
from practiq_ai.contracts import ParsedQuestion
from practiq_ai.graphs import ocr_validation, source_context


def review(function, count, shape):
    questions = [ParsedQuestion(id=None if shape == 'no-id' else f'page:1:{i}',
        stem=f'Printed prompt {i}?', answerMode='short_answer', answerPayload={'text': str(i)})
        for i in range(1, count + 1)]
    if shape == 'duplicate-id':
        questions[-1].id = questions[0].id
    records = [f'{i}. Printed prompt {i}?' for i in range(1, count + 1)]
    if shape == 'repeated-source':
        records[-1] = records[0]
    if shape == 'formula':
        records[0] += r' $x^2+1$'
    if shape == 'prefix':
        records.insert(0, r'Given $a+b$')
    text = '\n'.join(records)
    initial = digest([q.model_dump() for q in questions])

    def run():
        # Include defensive copies; review intentionally mutates derived flags.
        candidates = deepcopy(questions)
        issues = function(text, candidates, [])
        return issues, [q.needsReview for q in candidates]

    return run, lambda: digest([q.model_dump() for q in questions]) == initial


def context(function, count, shape):
    pages: list[dict[str, Any]] = [{'elements': [{'text_info': {'content': f'{i + 1}. Printed prompt?'}}]} for i in range(count)]
    if shape in {'answers', 'ambiguous'}:
        for i in range(count // 2, count):
            pages[i]['elements'][0]['text_info']['content'] = f'Answer key\n{i - count // 2 + 1}. A'
        if shape == 'ambiguous':
            pages[1] = deepcopy(pages[0])
    elif shape in {'failed', 'range'}:
        for page in pages:
            page['elements'][0]['text_info']['content'] += f' See pages 1-{count}.'
        if shape == 'failed':
            for i in range(1, count, 3):
                pages[i] = {'failed': True}
    initial = digest(pages)
    return lambda: function(pages), lambda: digest(pages) == initial


def bundle(function, count):
    buffer = BytesIO()
    with ZipFile(buffer, 'w', ZIP_DEFLATED) as archive:
        archive.writestr('result_xml_full.xml', '<root>' + ''.join(
            f'<image id="p-{i}" page-numbers="{i % count}" src="images/{i}.png"/>' for i in range(1500)) + '</root>')
        for i in range(1500):
            archive.writestr(f'images/{i}.png', b'not-read-by-decode')
        for i in range(count):
            archive.writestr(f'result_ocr_page{i}.json', json.dumps({'table_name': str(i), 'fields': [], 'rows': []}))
    payload = buffer.getvalue()
    settings = load()
    return lambda: function(payload, settings, page_count=count), lambda: True


def workload(kind, shape, count, functions):
    if kind == 'review':
        return review(functions[kind], count, shape)
    if kind == 'context':
        return context(functions[kind], count, shape)
    if kind == 'bundle':
        return bundle(functions[kind], count)
    if kind == 'formula-source':
        questions = [ParsedQuestion(id=f'page:1:{i}', stem=f'Printed prompt {i}?') for i in range(count)]
        return lambda: functions[kind]('', questions), lambda: True
    if kind == 'math':
        source = {'absent': 'Printed source without math', 'unclosed': r'Given $x+1',
                  'empty': 'Given $ $', 'present': r'Given $x+1$ and \(y-2\)'}[shape]
        rendered = 'Printed display ' * count
        return lambda: functions[kind](source, rendered), lambda: True
    if kind == 'crop':
        polygon = {key: {'x': x, 'y': y} for key, x, y in [
            ('left_top', 20, 20), ('right_top', 80, 20), ('left_bottom', 20, 80), ('right_bottom', 80, 80)]}
        figure = {'polygon': polygon, 'figure_info': {'content': 'Long description without standalone labels'}}
        elements = [figure, *[{'text_info': {'content': 'Unrelated source text'}, 'polygon': polygon} for _ in range(count - 1)]]
        if shape == 'crossing':
            figure['figure_info']['content'] = '3'
            elements[1] = {'text_info': {'content': '3'}, 'polygon': {key: {'x': x, 'y': y} for key, x, y in [
                ('left_top', 30, 75), ('right_top', 40, 75), ('left_bottom', 30, 82), ('right_bottom', 40, 82)]}}
        saved = deepcopy(elements)
        return lambda: functions[kind](figure, elements, 100, 100), lambda: elements == saved
    raise ValueError(kind)


ROUNDS = [
    ('review', 'typed', 1000, 'Index printed IDs instead of scanning every question'),
    ('review', 'no-id', 300, 'Preserve substring fallback for missing IDs; no speculative text index'),
    ('review', 'duplicate-id', 300, 'Preserve multiple owners of a printed ID; no unique-ID shortcut'),
    ('review', 'repeated-source', 300, 'Keep repeated source records ambiguous; no deduplication shortcut'),
    ('math', 'absent', 10000, 'Defer rendered normalization when source has no math'),
    ('math', 'unclosed', 10000, 'Avoid normalization for unclosed formulas; preserve token scanner'),
    ('math', 'empty', 10000, 'Avoid normalization for empty formulas'),
    ('math', 'present', 10000, 'Math-heavy control: retain literal formula checks; no global cache'),
    ('formula-source', 'empty', 1000, 'Return immediately for absent secondary formula evidence'),
    ('context', 'answers', 300, 'Index answer pages by printed number'),
    ('context', 'ambiguous', 300, 'Keep repeated question numbers from linking distant answers'),
    ('context', 'failed', 300, 'Use prefix counts for inclusive failed-page barriers'),
    ('context', 'range', 300, 'Stop selection after a full plan encounters another linked page'),
    ('context', 'local', 300, 'Local-only control: measure index overhead; retain context policy'),
    ('crop', 'absent', 1000, 'Stop label repair when the figure contains no eligible labels'),
    ('crop', 'crossing', 1000, 'Keep nearby-content collision guard; no spatial index'),
    ('crop', 'absent', 1001, 'Keep dense-page guard; no unbounded label repair'),
    ('bundle', 'images', 100, 'Group validated native-table image associations once by page'),
    ('review', 'formula', 300, 'Combined formula-loss control: retain review findings'),
    ('review', 'prefix', 300, 'Combined prefix-formula control: retain per-question review flags'),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--rounds', type=int, nargs='+', choices=range(1, 21), default=list(range(1, 21)))
    args = parser.parse_args()
    args.baseline = subprocess.check_output(['git', 'rev-parse', args.baseline], text=True).strip()
    targets = {'review': (ocr_validation, 'question_issues'), 'context': (source_context, 'source_context'),
               'math': (unit_results, 'missing_formulas'), 'crop': (tencent_bundle, '_label_crop_bbox'),
               'bundle': (tencent_bundle, 'decode_bundle'), 'formula-source': (ocr_validation, '_formula_source')}
    before = {key: baseline_function(args.baseline, module, name) for key, (module, name) in targets.items()}
    before['review'].__globals__.update(missing_formulas=before['math'], _formula_source=before['formula-source'])
    before['bundle'].__globals__['_label_crop_bbox'] = before['crop']
    after = {key: getattr(module, name) for key, (module, name) in targets.items()}
    paths = {Path(module.__file__) for module, _ in targets.values() if module.__file__ is not None}
    rows = []
    for number in args.rounds:
        kind, shape, count, hypothesis = ROUNDS[number - 1]
        variants = {label: workload(kind, shape, count, functions) for label, functions in [('before', before), ('after', after)]}
        expected = digest(variants['before'][0]())
        samples = {'before': [], 'after': []}
        for pair in range(3):
            for label in (['before', 'after'] if pair % 2 == 0 else ['after', 'before']):
                run, unchanged = variants[label]
                for iteration in range(8):
                    started = perf_counter()
                    value = run()
                    elapsed = (perf_counter() - started) * 1000
                    assert digest(value) == expected, (number, label)
                    assert unchanged(), (number, label, 'mutated input')
                    if iteration:
                        samples[label].append(elapsed)
        row = {'round': number, 'kind': kind, 'shape': shape, 'size': count, 'hypothesis': hypothesis,
               'outputSha256': expected, **{label: {'samplesMs': values, 'medianMs': median(values)} for label, values in samples.items()}}
        row['reductionPercent'] = 100 * (1 - row['after']['medianMs'] / row['before']['medianMs'])
        rows.append(row)
        print(number, shape, *(round(row[label]['medianMs'], 4) for label in samples), round(row['reductionPercent'], 1), flush=True)
    report = {'baseline': args.baseline, 'python': platform.python_version(), 'platform': platform.platform(),
              'scope': '20 targeted optimization/control experiments, not 20 production edits. Three alternating AB/BA pairs; one warmup and seven retained samples per variant per pair; GC enabled, warm process. Fixture setup, output hashes and assertions excluded. Review includes defensive question copies. Baseline functions use baseline math/formula/crop helpers. Full output hashes and input immutability must match. Synthetic local CPU/ZIP only; no provider, database, HTTP or end-to-end speedup claim.',
              'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'sources': {str(path.relative_to(Path(__file__).resolve().parents[2])): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(paths)}, 'rounds': rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
