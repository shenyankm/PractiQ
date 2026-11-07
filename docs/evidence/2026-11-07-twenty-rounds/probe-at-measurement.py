"""Isolated, paired CPU experiments on synthetic import/review inputs; no providers."""

import argparse
import cProfile
import hashlib
import json
import os
import platform
import statistics
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path
from uuid import UUID
from zipfile import ZIP_DEFLATED, ZipFile


def canonical(value):
    from pydantic import BaseModel

    if isinstance(value, BaseModel):
        return canonical(value.model_dump(mode='json'))
    if isinstance(value, dict):
        return [[repr(key), canonical(item)] for key, item in value.items()]
    if isinstance(value, (list, tuple)):
        return [canonical(item) for item in value]
    return value


def digest(value):
    return hashlib.sha256(json.dumps(canonical(value), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def workload(case, small=False, control=False):
    from practiq_ai import answer_matching, corrections, json_repair, source_selection, tencent_bundle, unit_results
    from practiq_ai.contracts import DocumentCorrections, DocumentParseResult, DocumentQuestionCorrection, ParsedQuestion
    from practiq_ai.graphs import ocr_validation, source_context

    count = 20 if small else 1000
    questions = [ParsedQuestion(id=f'page:1:{i}', stem=f'Printed prompt {i}?', sourceText=f'{i}. Printed prompt {i}?',
                               answerMode='short_answer', answerPayload={'text': str(i)}) for i in range(1, count + 1)]
    text = '\n'.join(q.sourceText or '' for q in questions)
    if case == 'pages':
        size = 20 if small else 2000
        state = {'pageRefs': [None] * size, 'inputParts': [{'sourcePage': i // 2} for i in range(size)],
                 'pages': list(range(1, size // 2 + 1, 2))}
        return lambda: source_selection.page_indices(state), 10 if small else 1
    if case == 'active':
        state = {'chunkRefs': [None] * (20 if small else 5000),
                 'selectedUnits': [{'index': i, 'stage': 'document_parse'} for i in (1, 4, 8, 17)]}
        return lambda: source_selection.active_indices(state, 'document_parse'), 50
    if case == 'matching':
        def result(qs):
            return DocumentParseResult(schemaVersion=3, questions=qs, groups=[], visualElements=[], warnings=[], confidenceScore=80)
        target, supplied = result(questions), result([q.model_copy(update={'id': 'answer:' + str(i)}) for i, q in enumerate(questions)])
        return lambda: answer_matching.match_answers(target, supplied), 1
    if case in {'associate', 'associate-choice'}:
        target = questions[0].model_copy(update={'answerMode': 'true_false', 'answerPayload': {'value': False}})
        supplied = questions[0].model_copy(update={'answerPayload': {'text': ' 正确 '}})
        if case == 'associate-choice':
            target = questions[0].model_copy(update={'answerMode': 'choice'})
            supplied = questions[0].model_copy(update={'answerPayload': {'text': 'A B'}})
        return lambda: answer_matching.associated_question(target, supplied), 100 if small else 10
    if case == 'objects':
        pairs = [(f'field{i}', str(i)) for i in range(count)]
        return lambda: json_repair.unique_json_object(pairs), 30
    if case in {'ocr-text', 'rendered-strings'}:
        value = [{'text_info': {'content': str(i), 'confidence': 0.99}, 'unused': [None, 42, False]} for i in range(count)]
        function = tencent_bundle.evidence_text if case == 'ocr-text' else unit_results._rendered_strings
        return lambda: function(value), 3
    if case == 'formulas':
        source = ('Text without mathematical notation. ' * (20 if small else 3000))
        if control:
            source = ('Given $x^2$ and \\(a+b\\). ' * (20 if small else 500))
        return lambda: unit_results.missing_formulas(source, source), 3
    if case == 'formula-source':
        source = ('Given an introductory statement.\n' if control else '') + text
        return lambda: ocr_validation._formula_source(source, questions), 2
    if case == 'review':
        if control:
            for question in questions:
                question.options = []
                question.passage = []
            text = 'Given $z^2$.\n' + text
        return lambda: (ocr_validation.question_issues(text, questions, []), [q.needsReview for q in questions]), 1
    if case == 'boxes':
        boxes = [{'polygon': {key: {'x': x, 'y': y} for key, x, y in (
            ('left_top', 10, 10), ('right_top', 80, 10), ('left_bottom', 10, 90), ('right_bottom', 80, 90))}} for _ in range(count)]
        return lambda: [tencent_bundle._bbox(box, 100, 100) for box in boxes], 3
    if case == 'images':
        count = 20 if small else 500
        names = {f'images/{i}.png' for i in range(count)}
        xml = '<root>' + ''.join(f'<image id="p-{i}" page-numbers="1" src="images/{i}.png"/>' for i in range(count)) + '</root>'
        buffer = BytesIO()
        with ZipFile(buffer, 'w', ZIP_DEFLATED) as archive:
            archive.writestr('page_xml_full.xml', xml)
        reader = ZipFile(BytesIO(buffer.getvalue()))
        return lambda: tencent_bundle._image_members(reader, names), 3
    if case == 'context':
        count = 20 if small else 150
        pages = [{'elements': [{'text_info': {'content': f'{i + 1}. Printed prompt?' + (f' See pages 1-{count}.' if not control else '')}}]} for i in range(count)]
        if not control:
            pages[count // 2] = {'failed': True}
        return lambda: source_context.source_context(pages), 2
    if case == 'repair':
        raw = json.dumps({f'field{i}': f'value {i}, with a \\" quote' for i in range(count)})
        return lambda: json_repair.repair_json(raw), 2
    if case == 'corrections':
        question = questions[0].model_copy(update={'options': questions[0].options * 10})
        result = DocumentParseResult(schemaVersion=3, questions=[question], groups=[], visualElements=[], warnings=[], confidenceScore=80)
        edits = [DocumentQuestionCorrection(requestId=UUID(int=i + 1), questionIndex=0,
                 question=question.model_copy(update={'stem': str(i)}), savedAt='2026-11-07T00:00:00Z') for i in range(10 if small else 500)]
        changes = DocumentCorrections(checkpointId='synthetic', edits=edits)
        return lambda: corrections.corrected_result(result, changes), 2
    raise ValueError(case)


CASES = ('pages', 'active', 'matching', 'associate', 'associate-choice', 'objects', 'ocr-text',
         'rendered-strings', 'formulas', 'formula-source', 'review', 'boxes', 'images', 'context', 'repair', 'corrections')


def boundaries(case):
    from copy import deepcopy

    from practiq_ai import answer_matching, corrections, json_repair, source_selection, tencent_bundle, unit_results
    from practiq_ai.contracts import DocumentCorrections, DocumentParseResult, DocumentQuestionCorrection, ParsedQuestion
    from practiq_ai.graphs import ocr_validation, source_context

    def outcome(run):
        try:
            return {'value': canonical(run())}
        except (ValueError, TypeError, KeyError, ZeroDivisionError, RecursionError) as error:
            return {'error': type(error).__name__, 'message': str(error)}
        except Exception as error:
            if not hasattr(error, 'code'):
                raise
            return {'error': type(error).__name__, 'code': error.code, 'message': str(error)}

    q = ParsedQuestion(id='page:1:1', stem='Printed prompt?', sourceText='1. Printed prompt?', answerMode='short_answer')
    if case in {'pages', 'active'}:
        states = [
            {'pageRefs': [None] * 3, 'pages': [1, 1, 3]},
            {'pageRefs': [None] * 2, 'inputParts': [{'sourcePage': 0}, {'sourcePage': 0}], 'pages': [1]},
            {'pageRefs': [None], 'pages': [2]}, {'pageRefs': [], 'pages': [99]},
            {'chunkRefs': [None] * 4, 'selectedUnits': [{'stage': 'document_parse', 'index': i} for i in (3, 1, 1, -1, 4)]},
            {'chunkRefs': [None] * 4, 'selectedUnits': []}, {'chunkRefs': [None] * 4},
        ]
        return [outcome(lambda state=state: source_selection.page_indices(state) if case == 'pages' else source_selection.active_indices(state, 'document_parse')) for state in states]
    if case in {'associate', 'associate-choice'}:
        target = q.model_copy(update={'contentBlocks': []})
        outputs = []
        for value in ('正确', ' false ', '0', 'A, B', 'A\u3000B', '1 2', '1=2;2=1'):
            supplied = q.model_copy(update={'answerPayload': {'text': value}})
            for mode in ('true_false', 'choice', 'short_answer', 'ordering', 'matching'):
                outputs.append(outcome(lambda mode=mode: answer_matching.associated_question(target.model_copy(update={'answerMode': mode}), supplied)))
        return outputs
    if case == 'objects':
        return [outcome(lambda pairs=pairs: json_repair.unique_json_object(pairs)) for pairs in
                ([], [('a', 1), ('b', 2)], [('a', 1), ('a', 1)], [('a', 1), ('b', 2), ('a', 3)])]
    if case in {'ocr-text', 'rendered-strings'}:
        function = tencent_bundle.evidence_text if case == 'ocr-text' else unit_results._rendered_strings
        return [function(value) for value in (None, 0, False, (), '', 'a\nb', {'a': ['', 'x', {'b': 'y'}], 'c': [3, 'z']})]
    if case == 'formulas':
        return [unit_results.missing_formulas(source, rendered) for source, rendered in (
            ('text only', ''), ('$x$', ''), ('$ $', ''), ('$$x+1$$ \\(a+b\\)', 'x+1'),
            ('unclosed $x', ''), ('\\$x$', ''), ('\\[a \\geq b\\]', 'a\\ge b'), ('\\)stray closing', ''),
        )]
    if case in {'formula-source', 'review'}:
        function = ocr_validation._formula_source if case == 'formula-source' else lambda text, questions: (ocr_validation.question_issues(text, questions, []), [item.needsReview for item in questions])
        rows = [outcome(lambda text=text: function(text, [q.model_copy(deep=True)])) for text in (
            '', '1. Printed prompt?', 'Given Printed prompt?\n1. Printed prompt?',
            'Given $z$\n1. Printed prompt? $x$\nAnswer key\n1. $y$', '1. Printed prompt?\n1. Printed prompt?',
        )]
        if case == 'review':
            invalid = q.model_copy(update={'stem': 42})
            rows.append(outcome(lambda: function('1. Printed prompt?', [invalid])))
        return rows
    if case == 'boxes':
        original = {'polygon': {key: {'x': x, 'y': y} for key, x, y in (
            ('left_top', 10, 10), ('right_top', 80, 10), ('left_bottom', 10, 90), ('right_bottom', 80, 90))}}
        rows = []
        for bad in (True, float('nan'), float('inf'), -1, 101, '10'):
            value = deepcopy(original)
            value['polygon']['left_top']['x'] = bad
            rows.append(outcome(lambda value=value: tencent_bundle._bbox(value, 100, 100)))
        for width in (0, -100):
            rows.append(outcome(lambda width=width: tencent_bundle._bbox(original, width, 100)))
        negative = deepcopy(original)
        for point in negative['polygon'].values():
            point['x'] *= -1
        rows.append(outcome(lambda: tencent_bundle._bbox(negative, -100, 100)))
        return rows
    if case == 'context':
        pages = [{'elements': [{'text_info': {'content': '1. Printed prompt? See pages 1-4.'}}]},
                 {'failed': True}, {'elements': [{'text_info': {'content': 'Answer key\n1. A'}}]}]
        return [source_context.source_context(pages, page_references=flag) for flag in (True, False)]
    if case == 'repair':
        return [outcome(lambda raw=raw: json_repair.repair_json(raw)) for raw in (
            '{"a": [1, 2, ] }', '{"a":1}}', '{"a":"quoted \\" text"}', '{"a":1,"a":2}',
            '{"a":', '{"a":"cut', '[,]', '{"a":1]', '```json\n{"a":1}\n```',
        )]
    if case == 'corrections':
        result = DocumentParseResult(schemaVersion=3, questions=[q], groups=[], visualElements=[], warnings=[], confidenceScore=80)
        ids = [UUID(int=i + 1) for i in range(3)]
        changes = DocumentCorrections(checkpointId='synthetic', edits=[DocumentQuestionCorrection(requestId=value,
            questionIndex=0 if i < 2 else 8, question=q.model_copy(update={'stem': str(i)}), savedAt='2026-11-07T00:00:00Z') for i, value in enumerate(ids)])
        initial = digest(result)
        rows = [outcome(lambda revision=revision: corrections.corrected_result(result, changes, revision)) for revision in (ids[0], ids[1], None)]
        rows.append(initial == digest(result))
        return rows
    return []


def worker(snapshot, case, profile=None):
    os.environ['AI_READ_ONLY'] = '1'
    sys.path.insert(0, str(snapshot))
    rows = []
    shapes = [(False, False), (True, False)]
    if case in {'formulas', 'formula-source', 'review', 'context'}:
        shapes.append((False, True))
    for small, control in shapes:
        run, calls = workload(case, small, control)
        expected = digest(run())
        if profile and not small and not control:
            profiler = cProfile.Profile()
            profiler.runcall(run)
            profiler.dump_stats(profile)
        samples = []
        for _ in range(7):
            start = time.perf_counter()
            for _ in range(calls):
                value = run()
            elapsed = (time.perf_counter() - start) * 1000 / calls
            assert digest(value) == expected, (case, small, control, 'unstable output')
            samples.append(elapsed)
        rows.append({'small': small, 'control': control, 'callsPerSample': calls, 'samplesMs': samples, 'outputSha256': expected})
    return {'workloads': rows, 'boundaries': boundaries(case)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path)
    parser.add_argument('--after', type=Path)
    parser.add_argument('--case', choices=CASES, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--worker', type=Path)
    parser.add_argument('--profile', type=Path)
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.worker, args.case, args.profile)))
        return
    if not args.before or not args.after or not args.output:
        parser.error('--before, --after and --output are required')
    pairs = []
    for pair in range(3):
        runs = {}
        for label in (('before', 'after') if pair % 2 == 0 else ('after', 'before')):
            runs[label] = json.loads(subprocess.check_output([sys.executable, __file__, '--worker', str(getattr(args, label)), '--case', args.case], text=True))
        pairs.append(runs)
    rows = []
    for index, first in enumerate(pairs[0]['before']['workloads']):
        hashes = {pair[label]['workloads'][index]['outputSha256'] for pair in pairs for label in ('before', 'after')}
        assert len(hashes) == 1, (args.case, first, 'baseline/candidate output differs')
        row = {key: first[key] for key in ('small', 'control', 'outputSha256')}
        for label in ('before', 'after'):
            samples = [sample for pair in pairs for sample in pair[label]['workloads'][index]['samplesMs']]
            row[label] = {'samplesMs': samples, 'medianMs': statistics.median(samples),
                          'processMediansMs': [statistics.median(pair[label]['workloads'][index]['samplesMs']) for pair in pairs]}
        row['reductionPercent'] = 100 * (1 - row['after']['medianMs'] / row['before']['medianMs'])
        rows.append(row)
    report = {'case': args.case, 'python': platform.python_version(), 'platform': platform.platform(),
              'method': 'Three alternating AB/BA pairs in fresh processes; one warmup, seven samples per process; GC enabled; fixture setup and output hashes outside timers. Synthetic CPU only, no providers or live databases.',
              'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'sourceSha256': {label: {str(p.relative_to(getattr(args, label))): hashlib.sha256(p.read_bytes()).hexdigest()
                                      for p in sorted(getattr(args, label).rglob('*.py'))} for label in ('before', 'after')}, 'workloads': rows,
              'boundaries': {label: pairs[0][label]['boundaries'] for label in ('before', 'after')},
              'boundaryEquivalent': all(pair['before']['boundaries'] == pair['after']['boundaries'] for pair in pairs)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    for row in rows:
        print(args.case, 'small' if row['small'] else 'control' if row['control'] else 'large',
              round(row['before']['medianMs'], 4), round(row['after']['medianMs'], 4), round(row['reductionPercent'], 1), flush=True)


if __name__ == '__main__':
    main()
