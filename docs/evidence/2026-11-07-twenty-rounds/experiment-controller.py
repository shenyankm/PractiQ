import difflib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path('/Users/sheny/Developer/code/PractiQ')
BASE = Path('/tmp/practiq-perf20-20261107')
SOURCE = ROOT / 'server/src/practiq_ai'
EVIDENCE = ROOT / 'docs/evidence/2026-11-07-twenty-rounds'
EVIDENCE.mkdir(parents=True, exist_ok=True)


def replace(text, before, after):
    assert before in text, before
    return text.replace(before, after)


def active(text):
    return replace(text, "    available = page_indices(state) if stage == 'vision_parse' else list(range(len(state.get('chunkRefs', []))))\n    selected = state.get('selectedUnits')", "    selected = state.get('selectedUnits')\n    if stage != 'vision_parse' and selected is not None:\n        bounds = range(len(state.get('chunkRefs', [])))\n        requested = {unit['index'] for unit in selected if unit['stage'] == stage}\n        return sorted({int(index) for index in requested if index in bounds})\n    available = page_indices(state) if stage == 'vision_parse' else list(range(len(state.get('chunkRefs', []))))")


def matching(text):
    text = replace(text, "    for question in target.questions:\n        if question.answerMode in COMPOSITE_MODES:\n            continue\n        if (number := printed_number(question)) is not None:\n            counts[number] = counts.get(number, 0) + 1", "    numbers = [None if question.answerMode in COMPOSITE_MODES else printed_number(question) for question in target.questions]\n    for number in numbers:\n        if number is not None:\n            counts[number] = counts.get(number, 0) + 1")
    text = replace(text, '    for index, question in enumerate(target.questions):', '    for index, (question, number) in enumerate(zip(target.questions, numbers, strict=True)):')
    return replace(text, '        number = printed_number(question)\n', '')


def formula_zero(text):
    block = '    for question in questions:\n        if question.stem and (position := source.find(question.stem)) >= 0 and source.find(question.stem, position + 1) < 0:\n            starts.append(position)\n'
    return replace(text, block, '    if 0 not in starts:\n' + ''.join('    ' + line + '\n' for line in block.rstrip().splitlines()))


def review_lazy(text):
    statement = "    stems = [re.sub(r'\\s+', '', question.stem or '') for question in questions]"
    text = replace(text, statement, '    stems = None')
    return replace(text, '        owners = anchors or [index for index, stem in enumerate(stems) if stem and stem in line]', "        if not anchors and stems is None:\n        " + statement + "\n        owners = anchors or [index for index, stem in enumerate(stems or []) if stem and stem in line]")


def boxes_division(text):
    return replace(text, '    xs, ys = [p["x"] / width for p in points], [p["y"] / height for p in points]\n    values = [min(xs), min(ys), max(xs), max(ys)]', '    xs, ys = [p["x"] for p in points], [p["y"] for p in points]\n    if width > 0 and height > 0:\n        values = [min(xs) / width, min(ys) / height, max(xs) / width, max(ys) / height]\n    else:\n        xs, ys = [x / width for x in xs], [y / height for y in ys]\n        values = [min(xs), min(ys), max(xs), max(ys)]')


def images_regex(text):
    text = replace(text, 'MAX_PAGE_BYTES = 8 * 1024 * 1024', 'MAX_PAGE_BYTES = 8 * 1024 * 1024\n_IMAGE_ID = re.compile(r"p-(\\d+)")\n_IMAGE_PAGE = re.compile(r"\\d+")')
    text = replace(text, 're.fullmatch(r"p-(\\d+)", attrs.get("id", ""))', '_IMAGE_ID.fullmatch(attrs.get("id", ""))')
    return replace(text, 're.fullmatch(r"\\d+", pages)', '_IMAGE_PAGE.fullmatch(pages)')


def correction_history(text):
    text = replace(text, '    found = revision is None\n', '    found = revision is None\n    pending: dict[int, ParsedQuestion] = {}\n')
    text = replace(text, '        result.questions[edit.questionIndex] = edit.question.model_copy(deep=True)', '        pending[edit.questionIndex] = edit.question')
    return replace(text, '    return result\n', '    for index, question in pending.items():\n        result.questions[index] = question.model_copy(deep=True)\n    return result\n')


ROUNDS = [
    ('source_selection.py', 'pages', 'Index requested pages once instead of repeated linear membership', lambda t: replace(t, '    if not set(requested) <= {index + 1 for index in sources}:', '    requested = set(requested)\n    if not requested <= {index + 1 for index in sources}:')),
    ('source_selection.py', 'active', 'Select sparse chunk indexes without materializing every chunk', active),
    ('answer_matching.py', 'matching', 'Reuse target printed-number extraction in both matching passes', matching),
    ('answer_matching.py', 'associate', 'Normalize a supplied boolean label once', lambda t: replace(t, "            if text.strip().lower() in labels:\n                payload = {'value': labels[text.strip().lower()]}", "            label = text.strip().lower()\n            if label in labels:\n                payload = {'value': labels[label]}")),
    ('answer_matching.py', 'associate-choice', 'Compile the repeated choice and ordering answer splitter', lambda t: replace(replace(t, '\n\ndef printed_number', "\n\n_ANSWER_VALUES = re.compile(r'[,，、;；\\s]+')\n\ndef printed_number"), "re.split(r'[,，、;；\\s]+', text.strip())", '_ANSWER_VALUES.split(text.strip())')),
    ('tencent_bundle.py', 'ocr-text', 'Return directly for nontext OCR scalars instead of joining empty generators', lambda t: replace(t, '    values = value.values() if isinstance(value, dict) else value if isinstance(value, list) else []', '    if not isinstance(value, (dict, list)):\n        return ""\n    values = value.values() if isinstance(value, dict) else value')),
    ('json_repair.py', 'objects', 'Construct unique JSON dictionaries in C while retaining duplicate rejection', lambda t: replace(t, '    result: dict[str, Any] = {}\n    for key, value in pairs:\n        if key in result:\n            raise ValueError("Duplicate JSON field; return each field exactly once")\n        result[key] = value', '    result = dict(pairs)\n    if len(result) != len(pairs):\n        raise ValueError("Duplicate JSON field; return each field exactly once")')),
    ('unit_results.py', 'rendered-strings', 'Traverse dictionary values without allocating an intermediate list', lambda t: replace(t, '    if isinstance(value, dict):\n        value = list(value.values())\n    return [text for item in value for text in _rendered_strings(item)] if isinstance(value, list) else []', '    if not isinstance(value, (dict, list)):\n        return []\n    values = value.values() if isinstance(value, dict) else value\n    return [text for item in values for text in _rendered_strings(item)]')),
    ('unit_results.py', 'formulas', 'Skip math token scanning when no opening delimiter can occur', lambda t: replace(t, '    normalize = lambda text:', "    if '$' not in source and r'\\(' not in source and r'\\[' not in source:\n        return []\n    normalize = lambda text:")),
    ('graphs/ocr_validation.py', 'formula-source', 'Avoid stem substring scans when a printed anchor already starts at zero', formula_zero),
    ('graphs/ocr_validation.py', 'formula-source', 'Stop printed-anchor discovery after the earliest matching anchor', lambda t: replace(t, '    starts = [match.start() for match in NUMBER.finditer(source) if match[1] in numbers]', '    first = next((match.start() for match in NUMBER.finditer(source) if match[1] in numbers), None)\n    starts = [] if first is None else [first]')),
    ('graphs/ocr_validation.py', 'review', 'Avoid serializing absent option passage and item material', lambda t: replace(t, 'evidence_text(question.model_dump(include={\'options\', \'passage\', \'items\'})) for question in questions', "(evidence_text(question.model_dump(include={'options', 'passage', 'items'})) if question.options or question.passage or question.items else '') for question in questions")),
    ('graphs/ocr_validation.py', 'review', 'Normalize stems lazily only when printed-ID matching has no anchor', review_lazy),
    ('tencent_bundle.py', 'boxes', 'Divide only bounding extrema while preserving nonpositive dimension behavior', boxes_division),
    ('tencent_bundle.py', 'boxes', 'Avoid constructing a numeric-type set for every coordinate', lambda t: replace(t, 'type(p[axis]) not in {int, float}', 'type(p[axis]) not in (int, float)')),
    ('tencent_bundle.py', 'images', 'Compile repeated image association identifier expressions', images_regex),
    ('graphs/source_context.py', 'context', 'Deduplicate candidate context pages before selection', lambda t: replace(t, '        for other in [*adjacent, *sorted(linked)]:\n            if other in selected:\n                continue', '        for other in dict.fromkeys([*adjacent, *sorted(linked)]):')),
    ('graphs/source_context.py', 'context', 'Enumerate linked pages in source order instead of sorting the set', lambda t: replace(t, '*sorted(linked)', '*(other for other in range(len(pages)) if other in linked)')),
    ('json_repair.py', 'repair', 'Bind the output append operation once during punctuation repair', lambda t: replace(replace(t, '    output: list[str] = []', '    output: list[str] = []\n    append = output.append'), 'output.append(char)', 'append(char)')),
    ('corrections.py', 'corrections', 'Copy only the last applicable edit for each question in correction history', correction_history),
]


def snapshot(path):
    shutil.copytree(SOURCE, path / 'practiq_ai', ignore=shutil.ignore_patterns('__pycache__'))


ledger = []
for number, (module, case, hypothesis, transform) in enumerate(ROUNDS, 1):
    path = SOURCE / module
    original = path.read_text()
    before, after = BASE / f'before-{number:02}', BASE / f'after-{number:02}'
    snapshot(before)
    candidate = transform(original)
    assert candidate != original, number
    compile(candidate, str(path), 'exec')
    path.write_text(candidate)
    patch = ''.join(difflib.unified_diff(original.splitlines(True), candidate.splitlines(True), fromfile='a/server/src/practiq_ai/' + module, tofile='b/server/src/practiq_ai/' + module))
    (EVIDENCE / f'round-{number:02}.patch').write_text(patch)
    snapshot(after)
    report_path = EVIDENCE / f'round-{number:02}.json'
    env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'AI_READ_ONLY': '1'}
    result = subprocess.run([sys.executable, str(ROOT / 'server/scripts/benchmark_twenty_rounds.py'), '--before', str(before), '--after', str(after), '--case', case, '--output', str(report_path)], cwd=ROOT, env=env, text=True, capture_output=True)
    (BASE / f'round-{number:02}.log').write_text(result.stdout + result.stderr)
    if result.returncode:
        path.write_text(original)
        print(number, 'PROBE FAILED', result.stderr[-1500:], flush=True)
        raise SystemExit(result.returncode)
    report = json.loads(report_path.read_text())
    target = report['workloads'][0]
    paired = sum(a < b for a, b in zip(target['after']['processMediansMs'], target['before']['processMediansMs'], strict=True))
    regressions = [row for row in report['workloads'][1:] if row['after']['medianMs'] > row['before']['medianMs'] * 1.1 and row['after']['medianMs'] - row['before']['medianMs'] > .02]
    keep = report['boundaryEquivalent'] and target['reductionPercent'] >= 8 and paired >= 2 and not regressions
    reason = 'measured benefit with equivalent boundaries' if keep else 'behavior boundary changed' if not report['boundaryEquivalent'] else 'control regression' if regressions else 'benefit below 8 percent or inconsistent process pairs'
    if not keep:
        path.write_text(original)
    row = {'round': number, 'module': module, 'case': case, 'hypothesis': hypothesis, 'decision': 'retained' if keep else 'reverted', 'reason': reason, 'beforeMs': target['before']['medianMs'], 'afterMs': target['after']['medianMs'], 'reductionPercent': target['reductionPercent'], 'fasterPairs': paired, 'boundaryEquivalent': report['boundaryEquivalent']}
    ledger.append(row)
    (EVIDENCE / 'ledger.json').write_text(json.dumps(ledger, indent=2) + '\n')
    print(number, row['decision'], round(row['beforeMs'],4), round(row['afterMs'],4), round(row['reductionPercent'],1), reason, flush=True)
print('COMPLETE', len(ledger), 'experiments;', sum(row['decision']=='retained' for row in ledger), 'retained', flush=True)
