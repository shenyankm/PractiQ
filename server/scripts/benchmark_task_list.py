"""Read-path probe using disposable SQLite and synthetic checkpoints; no model calls."""
import argparse
import asyncio
import copy
import json
import statistics
import time
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest


async def probe(question_count):
    with pytest.MonkeyPatch.context() as patch:
        for key, value in {
            'AI_SERVICE_TOKEN': 'test-token', 'LLM_PROVIDER': 'dashscope',
            'LLM_API_KEY': 'synthetic-key', 'LLM_MODEL': 'synthetic',
            'AI_DEPLOYMENT_WORKERS': '1', 'N_JOBS_PER_WORKER': '8',
            'AI_GRAPH_MAX_CONCURRENCY': '2', 'AI_PROVIDER_CONCURRENCY': '16',
            'AI_PROVIDER_RPM': '100000',
        }.items():
            patch.setenv(key, value)
        from practiq_ai import task_api
        from practiq_ai.database import utcnow
        from tests.db_support import cleanup, setup_api
        from tests.support import parsed
        try:
            service, reference, model = await setup_api(patch, [])
            base = parsed()['questions'][0]
            questions = []
            for i in range(question_count):
                q = copy.deepcopy(base)
                q.update(id=f'q-{i}', stem=f'Synthetic question {i} ' + 'x' * 200,
                         sourceText=f'Synthetic source {i} ' + 'y' * 500)
                questions.append(q)
            for _ in range(20):
                tid = str(uuid4())
                async with service.db.connection() as conn:
                    await conn.execute('INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) VALUES(?,?,?,?,?,?)',
                                       (tid, tid, 'document_parser', json.dumps(reference), 'return_partial', utcnow() + timedelta(days=1)))
                await service.graph.aupdate_state({'configurable': {'thread_id': tid}},
                    {'document': reference, 'status': 'SUCCEEDED', 'result': {'questions': questions, 'groups': [], 'visualElements': []},
                     'chunkResults': [{'index': 0, 'parsed': {'questions': questions, 'groups': []}, 'failureCode': None}]}, as_node='finish')
            times = []
            value = {}
            for _ in range(5):
                start = time.perf_counter()
                value = await task_api.list_tasks(limit=20)
                times.append((time.perf_counter() - start) * 1000)
                assert len(value['items']) == 20
                assert all(row['questionCount'] == question_count for row in value['items'])
            size = await (await service.db.connections[0].execute('SELECT sum(length(checkpoint)),count(*) FROM checkpoints')).fetchone()
            assert not model.calls
            return {'tasks': 20, 'questionsPerTask': question_count, 'samplesMs': times,
                    'medianMs': statistics.median(times), 'responseBytes': len(json.dumps(value).encode()),
                    'checkpointBytes': size[0], 'checkpointRows': size[1], 'realModelCalls': 0}
        finally:
            await cleanup()




def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    results = [asyncio.run(probe(n)) for n in (1, 1000)]
    report = {'method': 'Real disposable SQLite; 20 synthetic completed tasks, one chunk and result; five reads including cold first read; no model calls, IPC or WebView', 'results': results}
    args.output.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
