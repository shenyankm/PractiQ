"""Compare source-presence selection and cold chunk planning without external services."""

import argparse
import asyncio
import hashlib
import inspect
import json
import platform
import subprocess
from pathlib import Path

from benchmark_source_evidence import measure
from benchmark_web_server import ROOT, baseline_function, digest

from practiq_ai.graphs import chunking


async def profile_case(original, count, table):
    text = ('id\troot_task\tparent_id\toption_owner\tquestion_type\tstem\treference_answer\n'
            + '\n'.join(f'{i}\t{i}\t\t\tShort answer\tQ{i}\tA{i}' for i in range(1, count + 1))
            if table else '\n'.join(f'{i}. Short answer: Q{i}\nReference answer: A{i}\nSupplied explanation: Reason {i}'
                                   for i in range(1, count + 1)))
    options = {'source_type': 'csv' if table else 'text', 'tabular_rows_safe': table}
    spans, _, _ = chunking.split_chunk_plan(text, **options)
    expected_ids = [str(i) for i in range(1, count + 1)]

    def check(plan):
        assert [identifier for item in plan if item for identifier in item] == expected_ids
        assert all(hint['need_answer'] and hint['stem_sha256'] for item in plan if item for hint in item.values())

    async def presence(function):
        return function(text, spans, **options)

    async def cold_planning(function):
        chunking._typed_frames.cache_clear()
        chunking._table_frames.cache_clear()
        current, header, counts = chunking.split_chunk_plan(text, **options)
        return current, header, counts, function(text, current, **options)

    row = {'records': count, 'shape': 'legacy-table' if table else 'typed', 'sourceBytes': len(text.encode()),
           'chunks': len(spans), 'inputSha256': digest([text, spans, options])}
    row['warmPresence'] = await measure(lambda: presence(original), lambda: presence(chunking.source_presence_plan), check)
    row['coldPlanning'] = await measure(lambda: cold_planning(original), lambda: cold_planning(chunking.source_presence_plan),
                                       lambda value: check(value[3]))
    assert row['inputSha256'] == digest([text, spans, options])
    return row


async def profile(baseline):
    original = baseline_function(baseline, chunking, 'source_presence_plan')
    return [await profile_case(original, count, table) for count, table in [(20, False), (1000, False),
                                                                          (1000, True), (10000, False)]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    baseline = subprocess.check_output(['git', 'rev-parse', args.baseline], cwd=ROOT, text=True).strip()
    report = {'baseline': baseline, 'python': platform.python_version(), 'platform': platform.platform(),
              'scope': 'Serial local CPU, GC enabled; three sequential before/after pairs, always before then after, with one warmup and seven retained samples each. '
                       'Cold planning clears source-frame caches and includes split_chunk_plan plus source_presence_plan. '
                       'Setup, output checks and hashing excluded. 10000 records is input stress, not a supported output-size claim. '
                       'Legacy tables cover saved-source compatibility, not new CSV uploads. No model, DB, storage, worker or HTTP latency claim.',
              'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'functionSha256': hashlib.sha256(inspect.getsource(chunking.source_presence_plan).encode()).hexdigest(),
              'workloads': asyncio.run(profile(baseline))}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    for row in report['workloads']:
        print(row['records'], row['shape'], {key: {version: round(row[key][version]['medianMs'], 3)
                                                  for version in ('before', 'after')}
                                            for key in ('warmPresence', 'coldPlanning')})


if __name__ == '__main__':
    main()
