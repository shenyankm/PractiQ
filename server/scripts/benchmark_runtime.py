"""Small repeatable database/queue comparison using identical synthetic model work."""
import argparse
import asyncio
import json
import os
import statistics
import time
from pathlib import Path
from uuid import uuid4

import httpx
import pytest


async def run(count):
    samples=[]
    os.environ.update(AI_SERVICE_TOKEN='test-token',LLM_PROVIDER='dashscope',LLM_API_KEY='synthetic-key',LLM_MODEL='synthetic',AI_STORAGE_DIR='/tmp/practiq-benchmark-unused',AI_DEPLOYMENT_WORKERS='1',N_JOBS_PER_WORKER='8',AI_GRAPH_MAX_CONCURRENCY='2',AI_PROVIDER_RPM='100000',AI_PROVIDER_CONCURRENCY='16')
    from practiq_ai import task_api
    from practiq_ai.contracts import DocumentReference, DocumentTaskCreate
    from practiq_ai.webapp import app
    from tests.db_support import cleanup, setup_api
    from tests.support import parsed
    patch=pytest.MonkeyPatch()
    try:
        service, reference, model=await setup_api(patch,[(.1,parsed()) for _ in range(count)])
        done=asyncio.Event()
        async def health():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
                while not done.is_set():
                    start=time.perf_counter();response=await client.get('/ok');assert response.status_code==200
                    samples.append((time.perf_counter()-start)*1000)
                    await asyncio.sleep(.01)
        monitor=asyncio.create_task(health())
        start=time.perf_counter()
        try:
            requests=[DocumentTaskCreate(requestId=uuid4(),document=DocumentReference.model_validate(reference)) for _ in range(count)]
            created=await asyncio.gather(*(task_api.create_task(request) for request in requests))
            async with asyncio.timeout(120):
                while await service.db.rows("SELECT run_id FROM document_runs WHERE status IN ('pending','running')"):
                    await asyncio.sleep(.01)
            elapsed=time.perf_counter()-start
        finally:
            done.set();await monitor
        states=[await task_api.get_task(item['threadId']) for item in created]
        assert all(s['state']=='COMPLETED' and len(s['usage'])==1 for s in states)
        runs=await service.db.rows('SELECT created_at,started_at FROM document_runs')
        waits=[(r['started_at']-r['created_at']).total_seconds()*1000 for r in runs]
        return {'documents':count,'concurrency':8,'modelDelaySeconds':.1,'seconds':elapsed,'successfulDocumentsPerMinute':count*60/elapsed,'queueWaitMedianMs':statistics.median(waits),'okP95Ms':sorted(samples)[min(len(samples)-1,int(len(samples)*.95))],'modelCalls':len(model.calls),'allCompleted':True}
    finally:
        await cleanup();patch.undo()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);parser.add_argument('--documents',type=int,default=40);args=parser.parse_args()
    result=asyncio.run(run(args.documents));args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
