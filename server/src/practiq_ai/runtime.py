"""Single-process durable queue runner. SQLite is the source of truth."""

import asyncio
import os
from datetime import timedelta
from sqlite3 import Error as DatabaseError
from typing import Any

from langgraph.types import Command

from .config import load
from .database import Database, utcnow, watch_ownership
from .errors import DocumentProcessingError
from .execution import namespace, preflight, remaining_ttl, require_supported_task
from .graphs.document import build_document_graph

current: Service | None = None
GRAPH_FORMATS = {'document_parser': None, 'text_csv_parser': ('text', 'csv'),
                 'pdf_parser': ('pdf',)}


class Service:
    def __init__(self, db: Database):
        self.db = db
        self.graphs: dict[str, Any] = {}
        self.active: dict[str, asyncio.Task] = {}
        self.wake = asyncio.Event()
        self.accepting = False
        self.stopping = False
        self.loop: asyncio.Task | None = None
        self.guard_task: asyncio.Task | None = None
        self.lock = None
        self.fatal = os._exit

    async def start(self):
        await self.db.open()
        try:
            await self.db.check_schema()
            load()  # Validate deployment settings before taking ownership.
            self.lock = self.db.acquire()
            await self.db.ensure_indexes()
            self.graphs = {name: build_document_graph(self.db.checkpointer, store=self.db.store, name=name, source_types=types)
                           for name, types in GRAPH_FORMATS.items()}
            # A crash can separate the final checkpoint from the queue receipt.
            # Reconcile only this run's checkpoint, without executing graph nodes.
            for run in await self.db.rows("SELECT * FROM document_runs WHERE status IN ('pending','running','interrupted')"):
                task = (await self.db.rows('SELECT * FROM document_tasks WHERE thread_id=?', (run['thread_id'],)))[0]
                snapshot = await self.snapshot(task)
                if (saved_status := self.saved_run_status(snapshot, run)) is not None:
                    await self.finish(run['run_id'], saved_status)
            async with self.db.connection() as conn:
                if load().desktop_mode:
                    await conn.execute("UPDATE document_runs SET status='interrupted' WHERE status IN ('pending','running')")
                else:
                    await conn.execute("UPDATE document_runs SET status='pending' WHERE status='running'")
            self.accepting = True
            self.loop = asyncio.create_task(self.dispatch(), name='document-dispatch')
            self.guard_task = asyncio.create_task(self.watch_lock(), name='database-ownership')
        except BaseException:
            if self.lock:
                await self.lock.close()
            await self.db.close()
            raise

    async def watch_lock(self):
        def lost():
            self.accepting = False
            self.fatal(70)
        assert self.lock is not None
        await watch_ownership(self.lock, lost)

    async def ready(self):
        if not self.accepting or not self.loop or self.loop.done() or not self.guard_task or self.guard_task.done():
            return False
        try:
            async with asyncio.timeout(2):
                await self.db.rows('SELECT 1')
            return True
        except Exception:  # noqa: BLE001 - fail closed without logging credentials or payloads
            return False

    async def stop(self, timeout: float = 60):
        self.accepting = False
        self.stopping = True
        self.wake.set()
        if self.loop:
            await self.loop
        if self.active:
            _, pending = await asyncio.wait(list(self.active.values()), timeout=timeout)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        if self.guard_task:
            self.guard_task.cancel()
            await asyncio.gather(self.guard_task, return_exceptions=True)
        if self.lock:
            await self.lock.close()
        await self.db.close()

    async def snapshot(self, task):
        # Read retired checkpoints without restoring a Word parser.
        graph_id = 'document_parser' if task['graph_id'] == 'docx_parser' else task['graph_id']
        return await self.graphs[graph_id].aget_state({'configurable': {'thread_id': task['thread_id']}})

    @staticmethod
    def checkpoint_id(snapshot, run=None):
        return snapshot.config.get('configurable', {}).get('checkpoint_id') or (f"pending:{run['run_id']}" if run else None)

    @staticmethod
    def saved_run_status(snapshot, run):
        if (snapshot.metadata or {}).get('practiqRunId') != run['run_id']:
            return None
        if snapshot.interrupts:
            return 'waiting'
        if not snapshot.next and (snapshot.values or {}).get('status') in {'SUCCEEDED', 'PARTIAL'}:
            from .contracts import DocumentParseResult
            DocumentParseResult.model_validate(snapshot.values['result'])
            return 'success'
        return None

    async def dispatch(self):
        try:
            while not self.stopping:
                self.wake.clear()
                rows = await self.db.rows("SELECT * FROM document_runs WHERE status IN ('pending','running') ORDER BY created_at")
                for run in rows:
                    run_id = run['run_id']
                    if run['cancel_requested']:
                        if run_id in self.active:
                            self.active[run_id].cancel()
                        else:
                            await self.finish(run_id, 'interrupted')
                        continue
                    if run['pause_requested']:
                        await self.db.store.aput(namespace(run['thread_id'], 'pause'), run_id, {'requested': True}, index=False)
                    if run_id in self.active or run['status'] != 'pending' or len(self.active) >= load().jobs_per_worker:
                        continue
                    # Maintenance drains existing work but creates no new work through the API.
                    self.active[run_id] = asyncio.create_task(self.execute(run), name=f'document-{run_id}')
                    self.active[run_id].add_done_callback(self.execution_done)
                # Events are a fast path; cancellation can lose notification after commit.
                try:
                    await asyncio.wait_for(self.wake.wait(), timeout=1)
                except TimeoutError:
                    pass
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - fail closed without logging credentials or payloads
            self.accepting = False
            self.fatal(70)

    def execution_done(self, task):
        if not task.cancelled() and task.exception() is not None:
            self.accepting = False
            self.fatal(70)

    async def finish(self, run_id, status, error=None):
        async with self.db.connection() as conn:
            await conn.execute('UPDATE document_runs SET status=?,error_code=?,finished_at=now() WHERE run_id=?', (status, error, run_id))

    async def execute(self, run):
        run_id = run['run_id']
        try:
            task = (await self.db.rows('SELECT * FROM document_tasks WHERE thread_id=?', (run['thread_id'],)))[0]
            require_supported_task(task)
            remaining_ttl({'expiresAt': task['expires_at'].isoformat()})
            graph = self.graphs[task['graph_id']]
            snapshot = await self.snapshot(task)
            advanced = self.checkpoint_id(snapshot) != run['base_checkpoint'] and (snapshot.metadata or {}).get('practiqRunId') == run_id
            if advanced and (snapshot.interrupts or not snapshot.next):
                await self.finish(run_id, 'waiting' if snapshot.interrupts else 'success')
                return
            deadline = run['deadline'] or utcnow() + timedelta(seconds=load().run_timeout_seconds)
            async with self.db.connection() as conn:
                await conn.execute("UPDATE document_runs SET status='running',started_at=coalesce(started_at,now()),deadline=? WHERE run_id=?", (deadline, run_id))
            await self.db.store.aput(namespace(run['thread_id'], 'deadlines'), run_id, {'at': deadline.isoformat()}, index=False)
            remaining = (deadline - utcnow()).total_seconds()
            if remaining <= 0:
                raise DocumentProcessingError(504, 'Run execution deadline exceeded', 'RUN_DEADLINE_EXCEEDED')
            graph_input = None if advanced else Command(**run['command']) if run['command'] else run['input']
            async with asyncio.timeout(remaining):
                if snapshot.values and snapshot.values.get('execution'):
                    await preflight(snapshot.values)
                await graph.ainvoke(graph_input, {'configurable': {'thread_id': run['thread_id']},
                    'run_id': run_id, 'metadata': {'practiqRunId': run_id}}, context=run['context'], durability='sync')
            snapshot = await self.snapshot(task)
            await self.finish(run_id, 'waiting' if snapshot.interrupts else 'success')
        except asyncio.CancelledError:
            rows = await self.db.rows('SELECT cancel_requested FROM document_runs WHERE run_id=?', (run_id,))
            await self.finish(run_id, 'interrupted' if rows[0]['cancel_requested'] else 'pending')
        except DatabaseError:
            self.accepting = False
            self.fatal(70)
        except Exception as exc:  # noqa: BLE001 - task boundary stores only a sanitized error code
            code = exc.code if isinstance(exc, DocumentProcessingError) else 'RUN_DEADLINE_EXCEEDED' if isinstance(exc, TimeoutError) else 'TASK_EXECUTION_FAILED'
            await self.finish(run_id, 'error', code)
        finally:
            self.active.pop(run_id, None)
            self.wake.set()
