"""Measure ambiguity checks against a local Git baseline without model calls."""
import argparse
import hashlib
import json
import platform
import subprocess
from pathlib import Path
from statistics import median
from time import perf_counter

from benchmark_web_server import ROOT, baseline_function, digest

from practiq_ai.graphs import chunking


def profile(baseline, shape):
    # Exactly two prefix matches force an unnecessary full suffix scan in the baseline.
    raw = {'unique': 'AB' + 'x' * 39998, 'ambiguous': 'ABAB' + 'x' * 39996,
           'absent': 'x' * 40000, 'repeated': 'AB' * 20000}[shape]
    source = chunking._normalized_source(raw, 40000)
    expected = {'unique': [(40000, 40002)], 'ambiguous': [(40000, 40002), (40002, 40004)],
                'absent': [], 'repeated': [(40000, 40002), (40002, 40004)]}[shape]
    functions = {'before': baseline_function(baseline, chunking, '_source_locations'), 'after': chunking._source_locations}
    row = {'shape': shape, 'characters': len(raw), 'callsPerSample': 1000,
           'inputSha256': digest(source), 'outputSha256': digest(expected)}
    for name in functions:
        row[name] = {'samplesMs': []}
    for pair in range(3):
        for name in (['before', 'after'] if pair % 2 == 0 else ['after', 'before']):
            function = functions[name]
            for iteration in range(8):
                started = perf_counter()
                values = [function(source, 'A B') for _ in range(1000)]
                elapsed = (perf_counter() - started) * 1000
                assert all(value == expected for value in values)
                if iteration:
                    row[name]['samplesMs'].append(elapsed)
    for name in functions:
        row[name]['medianMs'] = median(row[name]['samplesMs'])
    assert row['inputSha256'] == digest(source)
    row['reductionPercent'] = (1 - row['after']['medianMs'] / row['before']['medianMs']) * 100
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    baseline = subprocess.check_output(['git', 'rev-parse', args.baseline], cwd=ROOT, text=True).strip()
    report = {'baseline': baseline, 'python': platform.python_version(), 'platform': platform.platform(),
              'scope': 'Synthetic local source quote lookup, three alternating pairs, one warmup plus seven samples each; normalization, setup, checks and hashes excluded. No parsing, DB, models or end-to-end latency claim.',
              'sourceSha256': hashlib.sha256(Path(chunking.__file__).read_bytes()).hexdigest(),
              'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'workloads': [profile(baseline, shape) for shape in ['unique', 'ambiguous', 'absent', 'repeated']]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    for row in report['workloads']:
        print(row['shape'], row['before']['medianMs'], row['after']['medianMs'], row['reductionPercent'])


if __name__ == '__main__':
    main()
