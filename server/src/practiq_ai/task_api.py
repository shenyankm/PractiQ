"""Document APIs over our PostgreSQL queue and open-source LangGraph."""

import asyncio
from base64 import b64decode, urlsafe_b64encode
from collections.abc import AsyncIterator
from datetime import datetime, timedelta
from json import dumps as json_encode
from json import loads as json_decode
from typing import Any, BinaryIO, Literal, LiteralString, cast
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from .config import load, require_model_config
from .contracts import (
    COMPOSITE_MODES,
    OFFICE_SOURCE_TYPES,
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
    DocumentTaskDetail,
    DocumentTaskHead,
    DocumentTaskList,
    DocumentTaskReparse,
    DocumentTaskReview,
    OfficeMode,
    RetryUnits,
    TaskAction,
    TaskState,
    scorable_count,
)
from .database import utcnow
from .errors import DocumentProcessingError
from .execution import (
    TTL_MINUTES,
    fingerprint,
    namespace,
    preflight,
    remaining_ttl,
    require_supported_task,
    signature,
    supported_task_sql,
)
from .graphs.document import (
    _bounded_map,
    _retry_update,
    load_unit_result,
    unit_failures,
)
from .storage import get_object_store, validate_source_size


def client():
    from .runtime import current
    if current is None or not current.accepting:
        raise DocumentProcessingError(503, 'Task service is unavailable', 'TASK_SERVICE_UNAVAILABLE')
    return current


def conflict(message: str, code: str = 'INVALID_CONTROL') -> DocumentProcessingError:
    return DocumentProcessingError(409, message, code)


def receipt(thread_id: str, request_id: str, run_id: str) -> dict[str, Any]:
    return {'threadId': thread_id, 'requestId': request_id, 'runId': run_id, 'accepted': True}


async def _admit(conn):
    require_model_config()
    if load().maintenance:
        raise DocumentProcessingError(503, 'Service is draining for maintenance', 'MAINTENANCE')
    count = await (await conn.execute(f"SELECT count(*) AS n FROM document_runs r JOIN document_tasks t ON t.thread_id=r.thread_id WHERE r.status IN ('pending','running') AND {supported_task_sql('t')}")).fetchone()
    if count['n'] >= load().max_busy_threads:
        raise DocumentProcessingError(503, 'Document queue is full; retry later', 'QUEUE_FULL')


async def _enqueue(conn, task, request_id, request_hash, *, graph_input=None, command=None, base=None, generation=0):
    await _admit(conn)
    run_id = str(uuid4())
    context = {'documentControl': {'requestId': request_id, 'fingerprint': request_hash,
                                  'generation': generation, 'expiresAt': task['expires_at'].isoformat()}}
    await conn.execute('INSERT INTO document_runs(run_id,thread_id,request_id,input,command,context,base_checkpoint) VALUES (%s,%s,%s,%s,%s,%s,%s)',
                       (run_id, task['thread_id'], request_id, json_encode(graph_input), json_encode(command), json_encode(context), base))
    return receipt(task['thread_id'], request_id, run_id)


async def _replay(conn, thread_id, request_id, request_hash):
    row = await (await conn.execute('SELECT r.*, t.expires_at, t.graph_id, t.document FROM document_receipts r JOIN document_tasks t USING(thread_id) WHERE r.thread_id=%s AND request_id=%s', (thread_id, request_id))).fetchone()
    if row:
        require_supported_task(row)
        remaining_ttl({'expiresAt': row['expires_at'].isoformat()})
        if row['fingerprint'] != request_hash:
            raise conflict('requestId was already used for different input', 'REQUEST_CONFLICT')
        return row['response']
    return None


async def _save_receipt(conn, thread_id, request_id, request_hash, response):
    await conn.execute('INSERT INTO document_receipts VALUES (%s,%s,%s,%s)', (thread_id, request_id, request_hash, json_encode(response)))


async def create_task(request: DocumentTaskCreate) -> dict[str, Any]:
    service = client()
    request_id = str(request.requestId)
    thread_id = str(uuid5(NAMESPACE_URL, f'practiq/document/{request_id}'))
    request_hash = fingerprint(_create_payload(request))
    async with service.db.transaction() as conn:
        previous = await _replay(conn, thread_id, request_id, request_hash)
        if previous:
            return previous
        settings = load()
        if request.document.sourceType in OFFICE_SOURCE_TYPES and settings.office_executable is None:
            raise DocumentProcessingError(503, 'Office conversion is not configured in this deployment', 'OFFICE_NOT_CONFIGURED')
        validate_source_size(request.document.sizeBytes, request.document.sourceType, settings)
        if request.parentThreadId:
            parent = await (await conn.execute('SELECT * FROM document_tasks WHERE thread_id=%s', (str(request.parentThreadId),))).fetchone()
            if not parent:
                raise DocumentProcessingError(404, 'Parent task not found', 'TASK_NOT_FOUND')
            require_supported_task(parent)
        task = await (await conn.execute('INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,parent_thread_id,expires_at) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *',
            (thread_id, request_hash, request.graphId, json_encode(request.document.model_dump(mode='json')), request.failurePolicy,
             str(request.parentThreadId) if request.parentThreadId else None, utcnow() + timedelta(minutes=TTL_MINUTES)))).fetchone()
        response = await _enqueue(conn, task, request_id, request_hash,
                                  graph_input=request.model_dump(mode='json', include={'document', 'failurePolicy', 'officeMode'}))
        await _save_receipt(conn, thread_id, request_id, request_hash, response)
    service.wake.set()
    return response


def _create_payload(request: DocumentTaskCreate) -> dict[str, Any]:
    # Preserve historical non-Office request receipts when adding this option.
    return request.model_dump(mode='json', exclude={'officeMode'} if request.officeMode is None else set())


async def _office_mode(service, thread_id: str) -> OfficeMode | None:
    # The initial run input is already committed atomically with the task.
    # Reuse it instead of changing schema-1 databases or checkpoint identities.
    rows = await service.db.rows('SELECT input FROM document_runs WHERE thread_id=%s AND input IS NOT NULL '
                                 'ORDER BY created_at,run_id LIMIT 1', (thread_id,))
    return rows[0]['input'].get('officeMode') if rows else None


async def _read_task_record(service, thread_id):
    tasks = await service.db.rows('SELECT * FROM document_tasks WHERE thread_id=%s', (thread_id,))
    if not tasks:
        raise DocumentProcessingError(404, 'Document task not found', 'TASK_NOT_FOUND')
    task = tasks[0]
    require_supported_task(task)
    remaining_ttl({'expiresAt': task['expires_at'].isoformat()})
    return task


async def _read_task(service, thread_id):
    task = await _read_task_record(service, thread_id)
    snapshot = await service.snapshot(task)
    runs = await service.db.rows('SELECT * FROM document_runs WHERE thread_id=%s ORDER BY created_at DESC LIMIT 1', (thread_id,))
    return task, snapshot, runs[0] if runs else None


async def reparse_task(thread_id: str, request: DocumentTaskReparse) -> dict[str, Any]:
    service = client()
    tasks = await service.db.rows('SELECT * FROM document_tasks WHERE thread_id=%s', (thread_id,))
    if not tasks:
        raise DocumentProcessingError(404, 'Document task not found', 'TASK_NOT_FOUND')
    task = tasks[0]
    require_supported_task(task)
    create = DocumentTaskCreate(requestId=request.requestId, document=DocumentReference.model_validate(task['document']),
                                graphId=task['graph_id'], failurePolicy=task['failure_policy'], parentThreadId=UUID(thread_id),
                                officeMode=await _office_mode(service, thread_id))
    async with service.db.connection() as conn:
        previous = await _replay(conn, str(uuid5(NAMESPACE_URL, f'practiq/document/{request.requestId}')),
                                 str(request.requestId), fingerprint(_create_payload(create)))
    if previous:
        return previous
    remaining_ttl({'expiresAt': task['expires_at'].isoformat()})
    require_model_config()
    await get_object_store().get_verified(create.document)
    return await create_task(create)


def _interrupts(snapshot):
    return {item.id: item.value for item in snapshot.interrupts}


async def _calls(service, thread_id):
    values = []
    while True:
        items = await service.db.store.asearch(namespace(thread_id, 'calls'), limit=100, offset=len(values), refresh_ttl=False)
        values.extend(item.value for item in items)
        if len(items) < 100:
            return values


def _task_state(snapshot, run) -> tuple[TaskState, list[TaskAction], list[dict[str, Any]]]:
    values = snapshot.values or {}
    interruptions = _interrupts(snapshot)
    failures = unit_failures(values)
    active = bool(run and run['status'] in {'pending', 'running'})
    state: TaskState
    actions: list[TaskAction] = []
    if active:
        assert run is not None
        state = 'PAUSING' if run['pause_requested'] else ('PENDING' if run['status'] == 'pending' else 'RUNNING')
        actions = ['interrupt'] if run['pause_requested'] or run['cancel_requested'] else ['pause', 'interrupt']
    elif run and run['status'] == 'interrupted' and run['cancel_requested']:
        state = 'CANCELLED'
        actions = ['resume'] if snapshot.next or not values else []
        if any(f['retryable'] for f in failures):
            actions.append('retry_failed')
    elif run and run['status'] == 'error':
        state = 'FAILED'
        actions = ['resume'] if snapshot.next and run['error_code'] not in {
            'DOCUMENT_PARSE_FAILED', 'NO_QUESTIONS_FOUND', 'DOCUMENT_SOURCE_TYPE_MISMATCH',
            'DOCUMENT_PREPARE_FAILED', 'MODEL_INPUT_TOO_LARGE', 'MODEL_BUDGET_EXCEEDED',
        } else []
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
    return state, actions, failures


async def get_task(thread_id: str) -> dict[str, Any]:
    service = client()
    task, snapshot, run = await _read_task(service, thread_id)
    values = snapshot.values or {}
    interruptions = _interrupts(snapshot)
    state, actions, failures = _task_state(snapshot, run)
    calls = await _calls(service, thread_id)
    usage = {item['callKey']: item for item in values.get('usage', [])}
    usage.update({item['callKey']: {k: item[k] for k in ('callKey', 'modelId', 'inputTokens', 'outputTokens', 'callKind')}
                  for item in calls if item['status'] == 'completed'})
    return DocumentTaskDetail.model_validate({
        'threadId': thread_id, 'runId': run['run_id'] if run else None,
        'parentThreadId': task['parent_thread_id'],
        'modelConfigured': not load().read_only,
        'resumeCompatible': not load().read_only and (not values.get('execution') or values['execution'].get('signature') == signature()),
        'fileName': task['document'].get('fileName') or '文档',
        'state': state, 'phase': values.get('phase', 'pending'),
        'checkpointId': service.checkpoint_id(snapshot, run),
        'updatedAt': snapshot.created_at or task['created_at'].isoformat(), 'expiresAt': task['expires_at'].isoformat(),
        'allowedActions': actions, 'failures': failures,
        'blocking': list(interruptions.values()) or ([run['error_code']] if run and run['error_code'] else []),
        'progress': {
            'visuals': _counts(len(values.get('pageRefs', [])), len(values.get('visionResults', [])), sum(f['stage'].startswith('vision_') for f in failures)),
            'chunks': _counts(len(values.get('chunkRefs', [])), sum(item.get('parsed') is not None for item in values.get('chunkResults', [])), sum(f['stage'] == 'document_parse' for f in failures)),
        },
        'status': values.get('status') or None, 'result': values.get('result') or None,
        'modelBudget': {'limit': values.get('execution', {}).get('signature', {}).get('settings', {}).get('task_max_model_calls', load().task_max_model_calls), 'reserved': values.get('reservedCalls', 0)},
        'processing': values.get('processing') or None, 'usage': list(usage.values()),
        'unknownUsageCalls': [item['callKey'] for item in calls if item['status'] != 'completed'],
    }).model_dump(mode='json')


async def get_task_head(thread_id: str) -> dict[str, Any]:
    service = client()
    task = await _read_task_record(service, thread_id)
    heads = await service.db.checkpoint_heads([thread_id])
    runs = await service.db.rows('SELECT * FROM document_runs WHERE thread_id=%s ORDER BY created_at DESC LIMIT 1', (thread_id,))
    run = runs[0] if runs else None
    summary = await _task_summary(service, task, run, heads.get(thread_id))
    execution = summary['head']['execution']
    return DocumentTaskHead.model_validate({
        'threadId': thread_id, 'runId': run['run_id'] if run else None,
        'state': summary['state'], 'checkpointId': summary['checkpointId'],
        'updatedAt': summary['head']['updatedAt'],
        'modelConfigured': not load().read_only,
        'resumeCompatible': not load().read_only and (not execution or execution['signature'] == signature()),
    }).model_dump(mode='json')


async def export_task(thread_id: str, checkpoint_id: str | None = None) -> BinaryIO:
    from .bank_export import export_task_bank
    service = client()
    task, snapshot, run = await _read_task(service, thread_id)
    current_checkpoint = service.checkpoint_id(snapshot, run)
    if checkpoint_id is not None and checkpoint_id != current_checkpoint:
        raise conflict('The reviewed checkpoint changed', 'STALE_CHECKPOINT')
    detail = DocumentTaskDetail.model_validate(await get_task(thread_id))
    if detail.checkpointId != current_checkpoint:
        raise conflict('The task changed during export', 'STALE_CHECKPOINT')
    payload = await export_task_bank(detail, get_object_store(), source=DocumentReference.model_validate(task['document']))
    try:
        _, latest, latest_run = await _read_task(service, thread_id)
        if service.checkpoint_id(latest, latest_run) != current_checkpoint or _task_state(latest, latest_run)[0] != 'COMPLETED':
            raise conflict('The task changed during export', 'STALE_CHECKPOINT')
    except BaseException:
        payload.close()
        raise
    return payload


async def control_task(thread_id: str, request: DocumentTaskControl) -> dict[str, Any]:
    service = client()
    request_id = str(request.requestId)
    request_hash = fingerprint(request.model_dump(mode='json'))
    # Expensive artifact checks happen outside the global admission transaction.
    # The checkpoint/run are re-read under the lock before enqueueing.
    if request.action not in {'pause', 'interrupt'}:
        task, snapshot, run = await _read_task(service, thread_id)
        # A concurrent admission commits its run and receipt together. Read the
        # receipt after the run so duplicates cannot see busy/stale before replay.
        async with service.db.connection() as conn:
            previous = await _replay(conn, thread_id, request_id, request_hash)
        if previous:
            return previous
        require_model_config()
        require_supported_task(task)
        if run and run['status'] in {'pending', 'running'}:
            raise conflict('Wait until the current run stops', 'TASK_BUSY')
        if service.checkpoint_id(snapshot, run) != request.checkpointId:
            raise conflict('Task changed since the checkpoint was read', 'STALE_CHECKPOINT')
        async with asyncio.timeout(load().run_timeout_seconds):
            if snapshot.values and snapshot.values.get('execution'):
                await preflight(snapshot.values)
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
                    await conn.execute('UPDATE document_runs SET pause_requested=true WHERE run_id=%s', (run['run_id'],))
                else:
                    await conn.execute('UPDATE document_runs SET cancel_requested=true WHERE run_id=%s', (run['run_id'],))
            response = receipt(thread_id, request_id, run['run_id'])
        else:
            if run and run['status'] in {'pending', 'running'}:
                raise conflict('Wait until the current run stops', 'TASK_BUSY')
            if service.checkpoint_id(snapshot, run) != request.checkpointId:
                raise conflict('Task changed since the checkpoint was read', 'STALE_CHECKPOINT')
            values = snapshot.values or {}
            interruptions = _interrupts(snapshot)
            reviews = [v for v in interruptions.values() if v.get('kind') == 'review']
            if request.action == 'resume' and 'resume' not in _task_state(snapshot, run)[1]:
                raise conflict('Task requires a review decision, a failed-unit retry, or a new document')
            if request.action == 'resume' and (reviews or values and not snapshot.next):
                raise conflict('Task requires a review decision or is already complete')
            if request.action == 'accept_partial' and (not reviews or not all(v.get('canAccept') for v in reviews)):
                raise conflict('There is no acceptable partial result')
            graph_input = None
            if not values:
                graph_input = {'document': task['document'], 'failurePolicy': task['failure_policy'],
                               'officeMode': await _office_mode(service, thread_id)}
            if request.action == 'retry_failed':
                retry = RetryUnits(requestId=request.requestId, units=request.units)
                _retry_update(cast(Any, values), retry)
                if not reviews:
                    if interruptions:
                        raise conflict('Resume the paused task before retrying failed units')
                    graph_input = {'document': values['document'], 'failurePolicy': values.get('failurePolicy', 'return_partial'),
                                   'officeMode': values.get('officeMode'), 'retry': retry.model_dump(mode='json')}
            command = {'resume': {key: request.model_dump(mode='json') for key in interruptions}} if interruptions else None
            admission = await service.db.store.aget(namespace(thread_id, 'control'), 'admission', refresh_ttl=False)
            response = await _enqueue(conn, task, request_id, request_hash, graph_input=graph_input, command=command,
                                      base=service.checkpoint_id(snapshot, run), generation=admission.value['generation'] if admission else 0)
        await _save_receipt(conn, thread_id, request_id, request_hash, response)
    service.wake.set()
    return response


def _counts(total: int, succeeded: int, failed: int) -> dict[str, int]:
    return {"total": total, "succeeded": succeeded, "failed": failed, "remaining": max(0, total - succeeded - failed)}


async def delete_task(thread_id: str) -> dict[str, bool]:
    service = client()
    async with service.db.transaction() as conn:
        active = await (await conn.execute("SELECT 1 FROM document_runs WHERE thread_id=%s AND status IN ('pending','running')", (thread_id,))).fetchone()
        if active:
            raise conflict('Stop the task before deleting it', 'TASK_BUSY')
        # Keep shared source artifacts and imported desktop banks intact.
        await conn.execute('DELETE FROM document_receipts WHERE thread_id=%s', (thread_id,))
        await conn.execute('DELETE FROM document_runs WHERE thread_id=%s', (thread_id,))
        await conn.execute('DELETE FROM document_tasks WHERE thread_id=%s', (thread_id,))
    service.task_summaries.pop(thread_id, None)
    await service.db.checkpointer.adelete_thread(thread_id)
    while items := await service.db.store.asearch(namespace(thread_id, '')[:2], limit=100, refresh_ttl=False):
        for item in items:
            await service.db.store.adelete(item.namespace, item.key)
    return {'deleted': True}


TaskFilter = Literal['active', 'paused', 'completed', 'cancelled', 'failed', 'review', 'interrupted', 'expired']
FILTER_STATES = {
    'active': {'PENDING', 'RUNNING', 'PAUSING'}, 'paused': {'PAUSED'},
    'completed': {'COMPLETED'}, 'cancelled': {'CANCELLED'}, 'failed': {'FAILED'},
    'review': {'WAITING_REVIEW'}, 'interrupted': {'INTERRUPTED'}, 'expired': {'EXPIRED'},
}
# Enqueue commits a pending run before graph writes; sync completion records success
# only after a quiescent checkpoint. Startup reconciliation never executes nodes.
# Keep no-run checkpoints eligible for recovery/inspection tools.
FILTER_RUN_SQL: dict[TaskFilter, LiteralString] = {
    'active': "(r.status IN ('pending','running') OR r.run_id IS NULL)",
    'completed': "(r.status IN ('success','waiting') OR r.run_id IS NULL)",
    'paused': "(r.status='waiting' OR (r.status='interrupted' AND NOT r.cancel_requested) OR r.run_id IS NULL)",
    'review': "(r.status='waiting' OR (r.status='interrupted' AND NOT r.cancel_requested) OR r.run_id IS NULL)",
    'cancelled': "r.status='interrupted' AND r.cancel_requested",
    'failed': "r.status='error'",
    'interrupted': "r.status='interrupted' AND NOT r.cancel_requested",
}


async def list_tasks(limit: int = 20, offset: int = 0, sha256: str | None = None, state_filter: TaskFilter | None = None,
                     office_mode: OfficeMode | None = None, cursor: str | None = None) -> dict[str, Any]:
    service = client()
    after = None
    scope = [sha256, state_filter, office_mode]
    if cursor:
        try:
            if offset or len(cursor) > 2048:
                raise ValueError('Cursor cannot be combined with offset')
            created, thread, bound_scope = json_decode(b64decode(cursor.encode('ascii'), altchars=b'-_', validate=True))
            if not isinstance(created, str) or not isinstance(thread, str):
                raise TypeError('Invalid cursor position')
            timestamp = datetime.fromisoformat(created)
            if timestamp.tzinfo is None or bound_scope != scope:
                raise ValueError('Invalid cursor scope')
            after = (timestamp, str(UUID(thread)))
        except (ValueError, TypeError, UnicodeError) as exc:
            raise DocumentProcessingError(400, 'Invalid task page cursor', 'INVALID_CURSOR') from exc
    source_filter = " AND (t.document->>'sha256')=%s" if sha256 else ''
    params: tuple[Any, ...] = (sha256,) if sha256 else ()
    join: LiteralString = ''
    where = supported_task_sql('t') + source_filter
    if office_mode is not None:
        where += (" AND (t.document->>'sourceType') IN ('doc','docx','xls','xlsx')"
                  " AND (SELECT (initial.input->>'officeMode') FROM document_runs initial"
                  " WHERE initial.thread_id=t.thread_id AND initial.input IS NOT NULL"
                  " ORDER BY initial.created_at,initial.run_id LIMIT 1)=%s")
        params += (office_mode,)
    if state_filter is not None:
        where += ' AND t.expires_at<=%s' if state_filter == 'expired' else ' AND t.expires_at>%s'
        params += (utcnow(),)
        if state_filter != 'expired':
            join = (' LEFT JOIN document_runs r ON r.run_id='
                    '(SELECT run_id FROM document_runs WHERE thread_id=t.thread_id ORDER BY created_at DESC LIMIT 1)')
            # Queue lifecycle narrows candidates; the checkpoint remains authoritative.
            where += ' AND (' + FILTER_RUN_SQL[state_filter] + ')'
    def page_query(position):
        if position:
            return (f'SELECT t.* FROM document_tasks t{join} WHERE {where} AND (t.created_at,t.thread_id)<(%s,%s) '
                    'ORDER BY t.created_at DESC,t.thread_id DESC LIMIT %s OFFSET %s'), (*params, *position)
        return (f'SELECT t.* FROM document_tasks t{join} WHERE {where} ORDER BY t.created_at DESC,t.thread_id DESC LIMIT %s OFFSET %s'), params

    def result(items, more):
        next_cursor = urlsafe_b64encode(json_encode([items[-1]['createdAt'], items[-1]['threadId'], scope]).encode()).decode() if more else None
        return DocumentTaskList.model_validate({'items': items, 'hasMore': more, 'nextCursor': next_cursor}).model_dump(mode='json')

    if state_filter is None:
        query, arguments = page_query(after)
        rows = await service.db.rows(query, (*arguments, limit + 1, offset))
        items = [item async for item in _task_summaries(service, rows[:limit])]
        return result(items, len(rows) > limit)
    items = []
    matched = 0
    while len(items) <= limit:
        query, arguments = page_query(after)
        rows = await service.db.rows(query, (*arguments, 100, 0))
        # ponytail: ambiguous paused/review candidates still scan; persist head-keyed summaries if they dominate.
        async for item in _task_summaries(service, rows):
            if item['state'] in FILTER_STATES[state_filter]:
                if matched >= offset:
                    items.append(item)
                matched += 1
                if len(items) > limit:
                    break
        if len(rows) < 100 or len(items) > limit:
            break
        after = (rows[-1]['created_at'], rows[-1]['thread_id'])
    return result(items[:limit], len(items) > limit)


async def _task_summaries(service, rows) -> AsyncIterator[dict[str, Any]]:
    latest_runs = await service.db.rows(
        'SELECT * FROM document_runs WHERE run_id IN '
        '(SELECT (SELECT run_id FROM document_runs r WHERE r.thread_id=t.thread_id ORDER BY created_at DESC LIMIT 1) '
        'FROM document_tasks t WHERE t.thread_id = ANY(%s))',
        ([row['thread_id'] for row in rows],),
    )
    runs_by_thread = {run['thread_id']: run for run in latest_runs}
    heads = await service.db.checkpoint_heads([row['thread_id'] for row in rows])
    for row in rows:
        expired = row['expires_at'] <= utcnow()
        summary = await _task_summary(service, row, runs_by_thread.get(row['thread_id']), heads.get(row['thread_id']))
        yield {'threadId': row['thread_id'], 'fileName': row['document'].get('fileName') or '文档',
               'createdAt': row['created_at'].isoformat(), 'expiresAt': row['expires_at'].isoformat(),
               **{key: value for key, value in summary.items() if key != 'head'},
               'state': 'EXPIRED' if expired else summary['state']}


async def _task_summary(service, task, run, checkpoint_id):
    thread_id = task['thread_id']
    key = (checkpoint_id, run['run_id'] if run else None, run['status'] if run else None)
    cached = service.task_summaries.get(thread_id)
    if cached and cached[0] == key:
        service.task_summaries.move_to_end(thread_id)
        return cached[1]
    snapshot = await service.snapshot(task)
    values = snapshot.values or {}
    questions = values.get('result', {}).get('questions', [])
    summary = {'state': _task_state(snapshot, run)[0], 'status': values.get('status') or None,
               'checkpointId': service.checkpoint_id(snapshot, run), 'questionCount': scorable_count(questions),
               'reviewCount': sum(bool(q.get('needsReview')) and q.get('answerMode') not in COMPOSITE_MODES for q in questions),
               'head': {'updatedAt': snapshot.created_at or task['created_at'].isoformat(),
                        'execution': {'signature': values['execution'].get('signature')} if values.get('execution') else None}}
    # Only completed, quiescent checkpoints are safe from same-checkpoint pending writes.
    if summary['state'] == 'COMPLETED' and not snapshot.next and not snapshot.interrupts:
        key = (summary['checkpointId'], key[1], key[2])
        service.task_summaries[thread_id] = (key, summary)
        service.task_summaries.move_to_end(thread_id)
        while len(service.task_summaries) > 256:
            service.task_summaries.popitem(last=False)
    return summary


async def review_task(thread_id: str) -> dict[str, Any]:
    """Read saved candidates only; never run merge, crop, or model nodes."""
    service = client()
    _task, snapshot, run = await _read_task(service, thread_id)
    values = snapshot.values or {}
    state, _, failures = _task_state(snapshot, run)
    units = []
    if values.get('result', {}).get('questions'):
        result = values['result']
        units.append({'stage': 'result', 'index': 0, 'questions': result['questions'],
                      'groups': result.get('groups', []), 'visualElements': result.get('visualElements', [])})
        for refs, stage in (('pageRefs', 'vision_parse'), ('chunkRefs', 'document_parse')):
            units.extend({'stage': stage, 'index': index, 'questions': [], 'groups': [], 'sourceRef': reference}
                         for index, reference in enumerate(values.get(refs, [])))
    else:
        for key, stage, refs in (('visionResults', 'vision_parse', 'pageRefs'), ('chunkResults', 'document_parse', 'chunkRefs')):
            candidates = [item for item in sorted(values.get(key, []), key=lambda item: item['index']) if item.get('parsed')]
            loaded = await _bounded_map(candidates, lambda item: load_unit_result(item, _task['document']['sha256']))
            for item in loaded:
                references = values.get(refs, [])
                units.append({'stage': stage, 'index': item['index'], 'questions': item['parsed'].get('questions', []),
                              'groups': item['parsed'].get('groups', []), 'visualElements': item.get('visuals', []),
                              'sourceRef': references[item['index']] if item['index'] < len(references) else None})
    processing = values.get('processing', {})
    return DocumentTaskReview.model_validate({
        'threadId': thread_id, 'checkpointId': service.checkpoint_id(snapshot, run),
        'state': state, 'phase': values.get('phase', 'pending'), 'units': units,
        'failures': failures, 'quality': processing.get('quality', {}),
        'questionSources': processing.get('questionSources', []),
    }).model_dump(mode='json')
