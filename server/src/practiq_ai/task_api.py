"""Document APIs over our SQLite queue and open-source LangGraph."""

import asyncio
from datetime import timedelta
from json import dumps as json_encode
from typing import Any, cast
from uuid import NAMESPACE_URL, uuid4, uuid5

from .config import load
from .contracts import (
    ArtifactReference,
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
    RetryUnits,
)
from .database import utcnow
from .errors import DocumentProcessingError
from .execution import (
    TTL_MINUTES,
    fingerprint,
    namespace,
    remaining_ttl,
    validate_execution,
)
from .graphs.document import _retry_update, unit_failures
from .storage import get_object_store


def client():
    from .runtime import current
    if current is None or not current.accepting:
        raise DocumentProcessingError(503, 'Task service is unavailable', 'TASK_SERVICE_UNAVAILABLE')
    return current


def conflict(message: str, code: str = 'INVALID_CONTROL') -> DocumentProcessingError:
    return DocumentProcessingError(409, message, code)


def require_supported_task(task) -> None:
    if task['document'].get('sourceType') in {'doc', 'docx'} or task['graph_id'] == 'docx_parser':
        raise conflict('暂不支持 Word 文件，请转为 PDF 后重新导入', 'WORD_FORMAT_REMOVED')


def receipt(thread_id: str, request_id: str, run_id: str) -> dict[str, Any]:
    return {'threadId': thread_id, 'requestId': request_id, 'runId': run_id, 'accepted': True}


async def _admit(conn):
    if load().maintenance:
        raise DocumentProcessingError(503, 'Service is draining for maintenance', 'MAINTENANCE')
    count = await (await conn.execute("SELECT count(*) AS n FROM document_runs WHERE status IN ('pending','running')")).fetchone()
    if count['n'] >= load().max_busy_threads:
        raise DocumentProcessingError(503, 'Document queue is full; retry later', 'QUEUE_FULL')


async def _enqueue(conn, task, request_id, request_hash, *, graph_input=None, command=None, base=None, generation=0):
    await _admit(conn)
    run_id = str(uuid4())
    context = {'documentControl': {'requestId': request_id, 'fingerprint': request_hash,
                                  'generation': generation, 'expiresAt': task['expires_at'].isoformat()}}
    await conn.execute('INSERT INTO document_runs(run_id,thread_id,request_id,input,command,context,base_checkpoint) VALUES (?,?,?,?,?,?,?)',
                       (run_id, task['thread_id'], request_id, json_encode(graph_input), json_encode(command), json_encode(context), base))
    return receipt(task['thread_id'], request_id, run_id)


async def _replay(conn, thread_id, request_id, request_hash):
    row = await (await conn.execute('SELECT r.*, t.expires_at FROM document_receipts r JOIN document_tasks t USING(thread_id) WHERE r.thread_id=? AND request_id=?', (thread_id, request_id))).fetchone()
    if row:
        remaining_ttl({'expiresAt': row['expires_at'].isoformat()})
        if row['fingerprint'] != request_hash:
            raise conflict('requestId was already used for different input', 'REQUEST_CONFLICT')
        return row['response']
    return None


async def _save_receipt(conn, thread_id, request_id, request_hash, response):
    await conn.execute('INSERT INTO document_receipts VALUES (?,?,?,?)', (thread_id, request_id, request_hash, json_encode(response)))


async def create_task(request: DocumentTaskCreate) -> dict[str, Any]:
    service = client()
    request_id = str(request.requestId)
    thread_id = str(uuid5(NAMESPACE_URL, f'practiq/document/{request_id}'))
    request_hash = fingerprint(request.model_dump(mode='json'))
    async with service.db.transaction() as conn:
        previous = await _replay(conn, thread_id, request_id, request_hash)
        if previous:
            return previous
        if request.parentThreadId:
            parent = await (await conn.execute('SELECT thread_id FROM document_tasks WHERE thread_id=?', (str(request.parentThreadId),))).fetchone()
            if not parent:
                raise DocumentProcessingError(404, 'Parent task not found', 'TASK_NOT_FOUND')
        await _admit(conn)
        task = await (await conn.execute('INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,parent_thread_id,expires_at) VALUES (?,?,?,?,?,?,?) RETURNING *',
            (thread_id, request_hash, request.graphId, json_encode(request.document.model_dump(mode='json')), request.failurePolicy,
             str(request.parentThreadId) if request.parentThreadId else None, utcnow() + timedelta(minutes=TTL_MINUTES)))).fetchone()
        response = await _enqueue(conn, task, request_id, request_hash,
                                  graph_input=request.model_dump(mode='json', include={'document', 'failurePolicy'}))
        await _save_receipt(conn, thread_id, request_id, request_hash, response)
    service.wake.set()
    return response


async def _read_task(service, thread_id):
    tasks = await service.db.rows('SELECT * FROM document_tasks WHERE thread_id=?', (thread_id,))
    if not tasks:
        raise DocumentProcessingError(404, 'Document task not found', 'TASK_NOT_FOUND')
    task = tasks[0]
    remaining_ttl({'expiresAt': task['expires_at'].isoformat()})
    snapshot = await service.snapshot(task)
    runs = await service.db.rows('SELECT * FROM document_runs WHERE thread_id=? ORDER BY created_at DESC LIMIT 1', (thread_id,))
    return task, snapshot, runs[0] if runs else None


def _interrupts(snapshot):
    return {item.id: item.value for item in snapshot.interrupts}


async def _calls(service, thread_id):
    values = []
    while True:
        items = await service.db.store.asearch(namespace(thread_id, 'calls'), limit=100, offset=len(values), refresh_ttl=False)
        values.extend(item.value for item in items)
        if len(items) < 100:
            return values


async def get_task(thread_id: str) -> dict[str, Any]:
    service = client()
    task, snapshot, run = await _read_task(service, thread_id)
    values = snapshot.values or {}
    interruptions = _interrupts(snapshot)
    failures = unit_failures(values)
    active = bool(run and run['status'] in {'pending', 'running'})
    actions = []
    if active:
        assert run is not None
        state = 'PAUSING' if run['pause_requested'] else ('PENDING' if run['status'] == 'pending' else 'RUNNING')
        actions = ['interrupt'] if run['pause_requested'] or run['cancel_requested'] else ['pause', 'interrupt']
    elif run and run['status'] == 'error':
        state = 'FAILED'
        actions = ['resume'] if snapshot.next else []
        if any(f['retryable'] for f in failures):
            actions.append('retry_failed')
    elif interruptions:
        reviews = [value for value in interruptions.values() if value.get('kind') == 'review']
        state = 'WAITING_REVIEW' if reviews else 'PAUSED'
        actions = (['retry_failed'] if any(f['retryable'] for f in failures) else []) if reviews else ['resume']
        if reviews and all(value.get('canAccept') for value in reviews):
            actions.append('accept_partial')
    elif run and run['status'] == 'interrupted':
        state = 'INTERRUPTED'
        actions = ['resume'] if snapshot.next or not values else []
        if any(f['retryable'] for f in failures):
            actions.append('retry_failed')
    elif values.get('status') in {'SUCCEEDED', 'PARTIAL'}:
        state = 'COMPLETED'
        actions = ['retry_failed'] if any(f['retryable'] for f in failures) else []
    else:
        state = 'PENDING'
    retired = task['document'].get('sourceType') in {'doc', 'docx'} or task['graph_id'] == 'docx_parser'
    if retired:
        actions = []
        if state != 'COMPLETED':
            state = 'FAILED'
    calls = await _calls(service, thread_id)
    usage = {item['callKey']: item for item in values.get('usage', [])}
    usage.update({item['callKey']: {k: item[k] for k in ('callKey', 'modelId', 'inputTokens', 'outputTokens', 'callKind')}
                  for item in calls if item['status'] == 'completed'})
    return {
        'threadId': thread_id, 'runId': run['run_id'] if run else None,
        'state': state, 'phase': values.get('phase', 'pending'),
        'checkpointId': service.checkpoint_id(snapshot, run),
        'updatedAt': snapshot.created_at or task['created_at'].isoformat(), 'expiresAt': task['expires_at'].isoformat(),
        'allowedActions': actions, 'failures': failures,
        'blocking': ['暂不支持 Word 文件，请转为 PDF 后重新导入'] if retired else list(interruptions.values()) or ([run['error_code']] if run and run['error_code'] else []),
        'progress': {
            'visuals': _counts(len(values.get('pageRefs', [])) + len(values.get('embeddedRefs', [])), len(values.get('visionResults', [])), sum(f['stage'].startswith('vision_') for f in failures)),
            'chunks': _counts(len(values.get('chunkRefs', [])), sum(item.get('parsed') is not None for item in values.get('chunkResults', [])), sum(f['stage'] == 'document_parse' for f in failures)),
        },
        'status': values.get('status') or None, 'result': values.get('result') or None,
        'modelBudget': {'limit': values.get('execution', {}).get('signature', {}).get('settings', {}).get('task_max_model_calls', load().task_max_model_calls), 'reserved': values.get('reservedCalls', 0)},
        'processing': values.get('processing') or None, 'usage': list(usage.values()),
        'unknownUsageCalls': [item['callKey'] for item in calls if item['status'] != 'completed'],
    }


async def control_task(thread_id: str, request: DocumentTaskControl) -> dict[str, Any]:
    service = client()
    request_id = str(request.requestId)
    request_hash = fingerprint(request.model_dump(mode='json'))
    # Expensive artifact checks happen outside the global admission transaction.
    # The checkpoint/run are re-read under the lock before enqueueing.
    if request.action not in {'pause', 'interrupt'}:
        async with service.db.connection() as conn:
            previous = await _replay(conn, thread_id, request_id, request_hash)
        if previous:
            return previous
        task, snapshot, run = await _read_task(service, thread_id)
        require_supported_task(task)
        if run and run['status'] in {'pending', 'running'}:
            raise conflict('Wait until the current run stops', 'TASK_BUSY')
        if service.checkpoint_id(snapshot, run) != request.checkpointId:
            raise conflict('Task changed since the checkpoint was read', 'STALE_CHECKPOINT')
        async with asyncio.timeout(load().run_timeout_seconds):
            if snapshot.values and snapshot.values.get('execution'):
                await _preflight(snapshot.values)
            else:
                await get_object_store().get_verified(DocumentReference.model_validate(task['document']))
    async with service.db.transaction() as conn:
        previous = await _replay(conn, thread_id, request_id, request_hash)
        if previous:
            return previous
        task, snapshot, run = await _read_task(service, thread_id)
        if request.action in {'pause', 'interrupt'}:
            if not run or run['run_id'] != str(request.runId):
                raise conflict('The target run is no longer current', 'STALE_RUN')
            if run['status'] in {'pending', 'running'}:
                if request.action == 'pause':
                    await conn.execute('UPDATE document_runs SET pause_requested=true WHERE run_id=?', (run['run_id'],))
                else:
                    await conn.execute('UPDATE document_runs SET cancel_requested=true WHERE run_id=?', (run['run_id'],))
            response = receipt(thread_id, request_id, run['run_id'])
        else:
            if run and run['status'] in {'pending', 'running'}:
                raise conflict('Wait until the current run stops', 'TASK_BUSY')
            if service.checkpoint_id(snapshot, run) != request.checkpointId:
                raise conflict('Task changed since the checkpoint was read', 'STALE_CHECKPOINT')
            values = snapshot.values or {}
            interruptions = _interrupts(snapshot)
            reviews = [v for v in interruptions.values() if v.get('kind') == 'review']
            if request.action == 'resume' and (reviews or values and not snapshot.next):
                raise conflict('Task requires a review decision or is already complete')
            if request.action == 'accept_partial' and (not reviews or not all(v.get('canAccept') for v in reviews)):
                raise conflict('There is no acceptable partial result')
            graph_input = None
            if not values:
                graph_input = {'document': task['document'], 'failurePolicy': task['failure_policy']}
            if request.action == 'retry_failed':
                retry = RetryUnits(requestId=request.requestId, units=request.units)
                _retry_update(cast(Any, values), retry)
                if not reviews:
                    if interruptions:
                        raise conflict('Resume the paused task before retrying failed units')
                    graph_input = {'document': values['document'], 'failurePolicy': values.get('failurePolicy', 'return_partial'), 'retry': retry.model_dump(mode='json')}
            command = {'resume': {key: request.model_dump(mode='json') for key in interruptions}} if interruptions else None
            admission = await service.db.store.aget(namespace(thread_id, 'control'), 'admission', refresh_ttl=False)
            response = await _enqueue(conn, task, request_id, request_hash, graph_input=graph_input, command=command,
                                      base=service.checkpoint_id(snapshot, run), generation=admission.value['generation'] if admission else 0)
        await _save_receipt(conn, thread_id, request_id, request_hash, response)
    service.wake.set()
    return response


def _counts(total: int, succeeded: int, failed: int) -> dict[str, int]:
    return {"total": total, "succeeded": succeeded, "failed": failed, "remaining": max(0, total - succeeded - failed)}


async def _preflight(values: dict[str, Any]) -> None:
    await asyncio.to_thread(validate_execution, values.get("execution"))
    store = await asyncio.to_thread(get_object_store)
    # Check the source and pending inputs, including outputs needed by assemble/merge.
    await store.get_verified(DocumentReference.model_validate(values["document"]))
    references = [item for key in ("pageRefs", "embeddedRefs", "chunkRefs") for item in values.get(key, [])]
    if values.get("textRef"):
        references.append(values["textRef"])
    seen: set[str] = set()
    for reference in references:
        if reference["objectKey"] not in seen:
            seen.add(reference["objectKey"])
            await store.get_verified(ArtifactReference.model_validate(reference))


async def list_tasks(limit: int = 20, offset: int = 0) -> dict[str, Any]:
    service = client()
    rows = await service.db.rows('SELECT thread_id,document,created_at,expires_at FROM document_tasks ORDER BY created_at DESC,thread_id DESC LIMIT ? OFFSET ?', (limit + 1, offset))
    return {'items': [{'threadId': row['thread_id'], 'fileName': row['document'].get('fileName', '文档'),
                       'createdAt': row['created_at'].isoformat(), 'expiresAt': row['expires_at'].isoformat()}
                      for row in rows[:limit]], 'hasMore': len(rows) > limit}
