"""Read-path probe using disposable PostgreSQL and synthetic checkpoints; no model calls."""
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
                    await conn.execute('INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) VALUES(%s,%s,%s,%s,%s,%s)',
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
            size = await (await service.db.connections[0].execute('SELECT coalesce(sum(pg_column_size(checkpoint)),0)+(SELECT coalesce(sum(octet_length(blob)),0) FROM checkpoint_blobs) AS bytes,count(*) FROM checkpoints')).fetchone()
            assert not model.calls
            return {'tasks': 20, 'questionsPerTask': question_count, 'samplesMs': times,
                    'medianMs': statistics.median(times), 'responseBytes': len(json.dumps(value).encode()),
                    'checkpointBytes': size['bytes'], 'checkpointRows': size['count'], 'realModelCalls': 0}
        finally:
            await cleanup()




async def filter_probe(history_count):
    """Compare the former recursive history scan with the production filtered path."""
    with pytest.MonkeyPatch.context() as patch:
        for key, value in {'AI_SERVICE_TOKEN': 'test-token', 'LLM_PROVIDER': 'dashscope',
                           'LLM_API_KEY': 'synthetic-key', 'LLM_MODEL': 'synthetic'}.items():
            patch.setenv(key, value)
        from practiq_ai import task_api
        from practiq_ai.database import utcnow
        from practiq_ai.execution import SUPPORTED_TASKS_SQL, supported_task_sql
        from tests.db_support import cleanup, setup_api
        from tests.support import parsed
        try:
            service, reference, model = await setup_api(patch, [])
            service.stopping = True
            service.wake.set()
            await service.loop
            source = str(uuid4())
            async with service.db.connection() as conn:
                await conn.execute('INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) VALUES (%s,%s,%s,%s,%s,%s)',
                                   (source, source, 'document_parser', json.dumps(reference), 'return_partial', utcnow() + timedelta(days=1)))
                await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context,status) VALUES (%s,%s,%s,'{}','success')", (source, source, source))
            await service.graph.aupdate_state({'configurable': {'thread_id': source}},
                                            {'status': 'SUCCEEDED', 'result': parsed()}, as_node='finish')
            async with service.db.connection() as conn:
                for _ in range(history_count - 1):
                    tid = str(uuid4())
                    await conn.execute('INSERT INTO document_tasks SELECT %s,request_hash,graph_id,document,failure_policy,parent_thread_id,created_at,expires_at FROM document_tasks WHERE thread_id=%s', (tid, source))
                    await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context,status) VALUES (%s,%s,%s,'{}','success')", (tid, tid, tid))
                    await service.db.connections[0].execute(
                        "INSERT INTO checkpoints SELECT %s,checkpoint_ns,checkpoint_id,parent_checkpoint_id,type,checkpoint,metadata FROM checkpoints WHERE thread_id=%s AND checkpoint_ns='' ORDER BY checkpoint_id DESC LIMIT 1", (tid, source))
                    await service.db.connections[0].execute(
                        "INSERT INTO checkpoint_blobs SELECT %s,checkpoint_ns,channel,version,type,blob FROM checkpoint_blobs WHERE thread_id=%s",
                        (tid, source))
                active = str(uuid4())
                await conn.execute('INSERT INTO document_tasks SELECT %s,request_hash,graph_id,document,failure_policy,parent_thread_id,created_at,expires_at FROM document_tasks WHERE thread_id=%s', (active, source))
                await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context,status) VALUES (%s,%s,%s,'{}','pending')", (active, active, active))
            snapshot_reads = []
            original = service.snapshot
            async def observed(task):
                snapshot_reads.append(task['thread_id'])
                return await original(task)
            patch.setattr(service, 'snapshot', observed)

            async def former_filter(state_filter):
                items = []
                source_offset = 0
                while len(items) <= 20:
                    page = await task_api.list_tasks(100, source_offset)
                    for item in page['items']:
                        if item['state'] in task_api.FILTER_STATES[state_filter]:
                            items.append(item)
                            if len(items) > 20:
                                break
                    if not page['hasMore']:
                        break
                    source_offset += 100
                return {'items': items[:20], 'hasMore': len(items) > 20}

            results = []
            for state_filter in ('active', 'paused', 'completed'):
                baseline = None
                for mode in ('formerRecursiveFilter', 'productionCandidateFilter'):
                    service.task_summaries.clear()
                    samples = []
                    for _ in range(3):
                        snapshot_reads.clear()
                        before = time.perf_counter()
                        page = await (former_filter(state_filter) if mode == 'formerRecursiveFilter'
                                      else task_api.list_tasks(state_filter=state_filter))
                        samples.append({'durationMs': round((time.perf_counter() - before) * 1000, 3),
                                        'snapshotReads': len(snapshot_reads)})
                        expected = 1 if state_filter == 'active' else (0 if state_filter == 'paused' else min(20, history_count))
                        assert len(page['items']) == expected
                        assert page['hasMore'] == (state_filter == 'completed' and history_count > 20)
                        page = {key: page[key] for key in ('items', 'hasMore')}
                        if baseline is None:
                            baseline = page
                        assert page == baseline
                    results.append({'filter': state_filter, 'mode': mode, 'samples': samples})
            assert not model.calls
            queries = {
                'activeBefore': f"SELECT * FROM document_runs WHERE thread_id IN ({SUPPORTED_TASKS_SQL}) AND status IN ('pending','running') ORDER BY created_at",
                'activeAfter': f"SELECT r.* FROM document_runs r JOIN document_tasks t ON t.thread_id=r.thread_id WHERE r.status IN ('pending','running') AND {supported_task_sql('t')} ORDER BY r.created_at",
                'firstPageBefore': f'SELECT * FROM document_tasks WHERE thread_id IN ({SUPPORTED_TASKS_SQL}) ORDER BY created_at DESC,thread_id DESC LIMIT 21 OFFSET 0',
                'firstPageAfter': f"SELECT t.* FROM document_tasks t WHERE {supported_task_sql('t')} ORDER BY t.created_at DESC,t.thread_id DESC LIMIT 21 OFFSET 0",
            }
            query_results = {}
            for name, sql in queries.items():
                times = []
                for _ in range(11):
                    before = time.perf_counter()
                    await service.db.rows(sql)
                    times.append((time.perf_counter() - before) * 1000)
                query_results[name] = {'sql': sql, 'medianMs': statistics.median(times),
                                       'plan': await service.db.rows('EXPLAIN (FORMAT JSON) ' + sql)}
            return {'completedHistory': history_count, 'activeTasks': 1, 'lruLimit': 256,
                    'results': results, 'queries': query_results, 'realModelCalls': 0}
        finally:
            await cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--history-tasks', type=int, default=600)
    args = parser.parse_args()
    if args.history_tasks < 1:
        parser.error('--history-tasks must be positive')
    results = [asyncio.run(probe(n)) for n in (1, 1000)]
    report = {'method': 'Real disposable PostgreSQL; 20 synthetic completed tasks, one chunk and result; five reads including cold first read; former filter baseline uses the current unfiltered backend to isolate filter behavior; no model calls, IPC or WebView',
              'results': results, 'filteredHistory': asyncio.run(filter_probe(args.history_tasks))}
    args.output.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
