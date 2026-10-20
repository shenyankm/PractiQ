"""Compare checkpoint-head SQL on disposable PostgreSQL; no model calls."""
import argparse
import ast
import asyncio
import hashlib
import json
import statistics
import subprocess
from pathlib import Path
from time import perf_counter
from typing import Any

from tests.db_support import cleanup, new_database

ROOT = Path(__file__).resolve().parents[2]
SOURCE = 'server/src/practiq_ai/database.py'


def query(source):
    database = next(node for node in ast.parse(source).body if isinstance(node, ast.ClassDef) and node.name == 'Database')
    method = next(node for node in database.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'checkpoint_heads')
    return next(ast.literal_eval(node.args[0]) for node in ast.walk(method)
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'execute')


async def measure(before, after):
    db = await new_database()
    report = []
    try:
        for history in [20, 1000]:
            async with db.connection() as conn:
                await conn.execute('TRUNCATE checkpoints')
                await conn.execute("INSERT INTO checkpoints(thread_id,checkpoint_id,checkpoint) "
                                   "SELECT 'thread-'||t,lpad(c::text,6,'0'),'{}'::jsonb "
                                   "FROM generate_series(1,20) t CROSS JOIN generate_series(1,%s) c", (history,))
                await conn.execute('VACUUM ANALYZE checkpoints')
            ids = [f'thread-{i}' for i in range(1, 21)] + ['missing']
            expected = {identifier: f'{history:06}' for identifier in ids[:-1]}
            assert await db.checkpoint_heads(ids) == expected
            row: dict[str, Any] = {'threads':20, 'historyPerThread':history, 'rows':20 * history}
            for pair in range(3):
                for name, sql in [('before', before), ('after', after)]:
                    samples = row.setdefault(name, {'samplesMs':[], 'sql':sql})['samplesMs']
                    for iteration in range(8):
                        started = perf_counter()
                        rows = await db.rows(sql, (ids,))
                        elapsed = (perf_counter() - started) * 1000
                        assert {r['thread_id']:r['checkpoint_id'] for r in rows} == expected
                        if iteration:
                            samples.append(elapsed)
            for name, sql in [('before', before), ('after', after)]:
                row[name]['medianMs'] = statistics.median(row[name]['samplesMs'])
                row[name]['plan'] = await db.rows('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, (ids,))
            row['outputSha256'] = hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest()
            row['reductionPercent'] = (1 - row['after']['medianMs'] / row['before']['medianMs']) * 100
            report.append(row)
        return report
    finally:
        await cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    baseline = subprocess.check_output(['git', 'rev-parse', args.baseline], cwd=ROOT, text=True).strip()
    before = query(subprocess.check_output(['git', 'show', f'{baseline}:{SOURCE}'], cwd=ROOT, text=True))
    after = query((ROOT / SOURCE).read_text())
    report = {'baseline':baseline, 'scope':'Disposable PostgreSQL metadata SQL, 20 requested threads, 3 alternating pairs of one warmup and seven timed samples. Includes local database round trips; excludes checkpoint payloads and task projection. No schema/index changes.',
              'probeSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'workloads':asyncio.run(measure(before, after))}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    for row in report['workloads']:
        print(row['historyPerThread'], row['before']['medianMs'], row['after']['medianMs'])


if __name__ == '__main__':
    main()
