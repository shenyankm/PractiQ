"""Import queue worker: python -m server.worker."""

import asyncio
import json
import logging
import signal
from contextlib import suppress
from typing import Any

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from . import agents, config, db as db_mod, imports_queue
from .ai_schemas import DocumentParseRequest, DocumentParseResult
from .auth import runtime as auth_runtime
from .extractors import DocumentProcessingError
from .services import groups as groups_svc
from .services import imports as imports_svc
from .services import questions as questions_svc
from .services import users as users_svc

logger = logging.getLogger('practiq.worker')
CHECKPOINT_SCHEMA_VERSION = 9


async def _load_import_job(pool: AsyncConnectionPool, job_id: int) -> dict | None:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT id, created_by, bank_id, file_name, source_type, status
            FROM question_import_jobs
            WHERE id = %s
            LIMIT 1
            """,
            (job_id,),
        )
        row = await cursor.fetchone()
    if row is None:
        return None
    return {
        'id': row[0], 'created_by': row[1], 'bank_id': row[2],
        'file_name': row[3], 'source_type': row[4], 'status': row[5],
    }


async def _build_parse_request(pool: AsyncConnectionPool, job: dict) -> DocumentParseRequest:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT storage_path, content_json
            FROM question_import_job_artifacts
            WHERE job_id = %s AND artifact_type = 'source_file'
            ORDER BY id DESC
            LIMIT 1
            """,
            (job['id'],),
        )
        rows = await cursor.fetchall()

    source_type = job['source_type'] or 'txt'
    file_name = job['file_name'] or ''
    file_base64 = ''
    mime_type = ''
    texts: list[str] = []
    for _, content_json in rows:
        if content_json is None:
            continue
        try:
            content = json.loads(content_json) if isinstance(content_json, str) else content_json
        except (TypeError, ValueError):
            continue
        text = content.get('text')
        if isinstance(text, str) and text.strip():
            texts.append(text.strip())
        if not file_base64:
            raw = content.get('fileBase64')
            if isinstance(raw, str) and raw:
                file_base64 = raw
        if not mime_type:
            mime = content.get('mimeType')
            if isinstance(mime, str):
                mime_type = mime
        if not file_name:
            name = content.get('originalName')
            if isinstance(name, str):
                file_name = name
    if source_type == 'text':
        source_type = 'txt'
    return DocumentParseRequest(
        importJobId=job['id'],
        bankId=job['bank_id'],
        sourceType=source_type,
        fileName=file_name or None,
        text='\n\n'.join(texts) or None,
        fileBase64=file_base64 or None,
        mimeType=mime_type or None,
    )


async def _record_import_event(
    pool: AsyncConnectionPool, job_id: int,
    stage: str, step_code: str, step_label: str, status: str,
    message: str | None, overall: int, step: int,
    claim_version: int | None = None,
) -> None:
    overall = min(max(overall, 0), 100)
    step = min(max(step, 0), 100)
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                """
                INSERT INTO question_import_job_events (job_id, stage, step_code, step_label, status, message, overall_progress_percent, step_progress_percent, payload_json)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, '{}')
                RETURNING id
                """,
                (job_id, stage, step_code, step_label, status, message, overall, step),
            )
            event_id = (await cursor.fetchone())[0]
            tag = await conn.execute(
                """
                UPDATE question_import_jobs
                SET stage = %s,
                    overall_progress_percent = %s,
                    step_progress_percent = %s,
                    last_event_id = %s,
                    last_event_at = NOW(),
                    updated_at = NOW()
                WHERE id = %s
                  AND (%s::bigint IS NULL OR (status = 'processing' AND claim_version = %s))
                """,
                (
                    stage, overall, step, event_id, job_id, claim_version,
                    claim_version,
                ),
            )
            if claim_version is not None and tag.rowcount == 0:
                raise imports_queue.ClaimLostError()


async def _complete_import_job(
    pool: AsyncConnectionPool, job_id: int, claim_version: int,
    imported_questions: int, result: DocumentParseResult,
) -> None:
    raw_result = json.dumps(result.model_dump(), separators=(',', ':'))
    warnings = json.dumps(result.warnings, separators=(',', ':'))
    async with pool.connection() as conn:
        async with conn.transaction():
            tag = await conn.execute(
                """
                UPDATE question_import_jobs
                SET status = 'completed',
                    stage = 'completed',
                    total_questions = %s,
                    imported_questions = %s,
                    raw_result_json = %s,
                    warning_messages = %s,
                    quality_score = %s,
                    overall_progress_percent = 100,
                    step_progress_percent = 100,
                    completed_at = NOW(),
                    available_at = NULL,
                    last_error = NULL,
                    last_error_code = NULL
                WHERE id = %s AND status = 'processing' AND claim_version = %s
                """,
                (
                    len(result.questions), imported_questions, raw_result, warnings,
                    result.qualityScore, job_id, claim_version,
                ),
            )
            if tag.rowcount == 0:
                raise imports_queue.ClaimLostError()
            cursor = await conn.execute(
                """
                INSERT INTO question_import_job_events (
                    job_id, stage, step_code, step_label, status,
                    overall_progress_percent, step_progress_percent, payload_json
                )
                VALUES (%s, 'completed', 'complete', '导入完成', 'completed', 100, 100, '{}')
                RETURNING id
                """,
                (job_id,),
            )
            event_id = (await cursor.fetchone())[0]
            tag = await conn.execute(
                """
                UPDATE question_import_jobs
                SET last_event_id = %s, last_event_at = NOW(), updated_at = NOW()
                WHERE id = %s AND status = 'completed' AND claim_version = %s
                """,
                (event_id, job_id, claim_version),
            )
            if tag.rowcount == 0:
                raise imports_queue.ClaimLostError()


def _non_empty(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    return value


async def process_queued_job(
    pool: AsyncConnectionPool,
    claimed: imports_queue.ClaimedJob,
    encryption_secret: str,
    graph=None,
    checkpointer: AsyncPostgresSaver | None = None,
) -> bool:
    """Returns persistence_started (for requeue/failure decisions)."""
    job = await _load_import_job(pool, claimed.id)
    if job is None or job['status'] != 'processing':
        return False
    user = await auth_runtime.current_user_by_id(pool, job['created_by'])
    if user is None:
        raise RuntimeError(f"import worker user {job['created_by']} not found")
    if not user.is_active:
        raise RuntimeError(f"import worker user {job['created_by']} is inactive")
    llm_config = await users_svc.require_llm_config(
        pool, user, encryption_secret, 'AI document imports'
    )
    text_model, vision_model = agents.build_models(llm_config)
    request = await _build_parse_request(pool, job)
    if graph is None:
        await _record_import_event(
            pool, job['id'], 'processing', 'parse', '处理中', 'processing',
            None, 10, 10, claimed.claim_version,
        )
        result = await agents.parse_document(text_model, vision_model, request)
    else:
        result = await _run_parse_graph(
            pool, claimed, graph, text_model, vision_model, request
        )
    await _delete_checkpoint(checkpointer, job['id'], strict=True)

    created_count = 0
    persistence_started = False
    if claimed.persist_questions and job['bank_id'] is not None:
        if result.questions:
            await imports_queue.begin_persistence(pool, job['id'], claimed.claim_version)
            persistence_started = True
            claimed.persistence_started = True
            await _record_import_event(
                pool, job['id'], 'persisting', 'persist', '保存题目', 'processing',
                None, 90, 0, claimed.claim_version,
            )
        question_ids: list[int] = []
        for parsed in result.questions:
            options = [
                questions_svc.QuestionOptionInput(
                    label=option.label, content=option.content, is_correct=bool(option.isCorrect)
                )
                for option in parsed.options
            ]
            choice_variant = None
            if parsed.answerMode == 'choice':
                correct_count = sum(1 for option in parsed.options if option.isCorrect)
                choice_variant = 'multiple' if correct_count > 1 else 'single'
            try:
                question = await questions_svc.persist_imported_question(
                    pool, user, job['bank_id'],
                    questions_svc.PersistImportedQuestionInput(
                        job_id=job['id'],
                        claim_version=claimed.claim_version,
                        question=questions_svc.CreateQuestionInput(
                            question_type_id=parsed.questionTypeId,
                            answer_mode=parsed.answerMode,
                            stem=parsed.stem,
                            analysis=_non_empty(parsed.analysis),
                            choice_variant=choice_variant,
                            status='draft',
                            options=options,
                            answer_payload=parsed.answerPayload or {},
                        ),
                        content_blocks=[
                            questions_svc.QuestionContentBlockInput(
                                part_type=block.partType,
                                role=_non_empty(block.role),
                                sequence=index + 1,
                                text_value=_non_empty(block.textValue),
                                markdown_value=_non_empty(block.markdownValue),
                                latex_value=_non_empty(block.latexValue),
                                json_value=block.jsonValue,
                            )
                            for index, block in enumerate(parsed.contentBlocks)
                        ],
                        confidence=parsed.confidence,
                        output_metadata={
                            'sourceText': parsed.sourceText,
                            'needsReview': parsed.needsReview,
                        },
                    ),
                )
            except questions_svc.ClaimLostError as exc:
                raise imports_queue.ClaimLostError() from exc
            question_ids.append(question['id'])
            created_count += 1
            await _record_import_event(
                pool, job['id'], 'persisting', 'persist', '保存题目', 'processing',
                None,
                90 + int(9 * created_count / len(result.questions)),
                int(100 * created_count / len(result.questions)),
                claimed.claim_version,
            )
        for parsed in result.groups:
            group = await groups_svc.create_group(
                pool, user, job['bank_id'],
                groups_svc.CreateGroupInput(
                    title=parsed.title,
                    instructions=parsed.instructions,
                    status='draft',
                    source_job_id=job['id'],
                ),
            )
            for index in parsed.questionIndexes:
                await groups_svc.add_question_to_group(pool, user, group['id'], question_ids[index], None)

    await _complete_import_job(pool, job['id'], claimed.claim_version, created_count, result)
    return persistence_started


async def _run_parse_graph(
    pool: AsyncConnectionPool,
    claimed: imports_queue.ClaimedJob,
    graph,
    text_model,
    vision_model,
    request: DocumentParseRequest,
) -> DocumentParseResult:
    run_config = agents.graph_config(
        {'configurable': {'thread_id': f'import:{claimed.id}'}}
    )
    snapshot = await graph.aget_state(run_config)
    graph_input = None if snapshot.values else agents.parse_graph_input(request)
    context = agents.AgentContext(text_model, vision_model)
    result: dict[str, Any] | None = None
    vision_done = chunk_done = 0
    vision_total = chunk_total = 0

    async for update in graph.astream(
        graph_input,
        run_config,
        context=context,
        stream_mode='updates',
        durability='sync',
    ):
        if node := update.get('extract'):
            vision_total = len(node.get('page_images', [])) + len(
                node.get('embedded_images', [])
            )
            await _record_import_event(
                pool, claimed.id, 'processing', 'extract', '提取文档', 'processing',
                None, 15, 100, claimed.claim_version,
            )
        if update.get('vision') is not None:
            vision_done += 1
            await _record_import_event(
                pool, claimed.id, 'processing', 'vision', '识别图片', 'processing',
                None,
                15 + int(20 * vision_done / max(vision_total, vision_done)),
                int(100 * vision_done / max(vision_total, vision_done)),
                claimed.claim_version,
            )
        if node := update.get('assemble_split'):
            chunk_total = len(node.get('chunks', []))
            await _record_import_event(
                pool, claimed.id, 'processing', 'split', '切分文档', 'processing',
                None, 40, 100, claimed.claim_version,
            )
        if update.get('chunk') is not None:
            chunk_done += 1
            await _record_import_event(
                pool, claimed.id, 'processing', 'chunk', '解析分片', 'processing',
                None,
                40 + int(40 * chunk_done / max(chunk_total, chunk_done)),
                int(100 * chunk_done / max(chunk_total, chunk_done)),
                claimed.claim_version,
            )
        if node := update.get('merge_finalize'):
            result = node.get('result')
            await _record_import_event(
                pool, claimed.id, 'processing', 'merge', '合并结果', 'processing',
                None, 85, 100, claimed.claim_version,
            )

    if result is None:
        snapshot = await graph.aget_state(run_config)
        result = snapshot.values.get('result')
    if result is None:
        raise DocumentProcessingError(502, 'AI agent request failed')
    return DocumentParseResult.model_validate(result)


async def _delete_checkpoint(
    checkpointer: AsyncPostgresSaver | None, job_id: int, *, strict: bool = False
) -> None:
    if checkpointer is None:
        return
    try:
        await checkpointer.adelete_thread(f'import:{job_id}')
    except Exception:
        if strict:
            raise
        logger.exception('failed to delete import checkpoint', extra={'job_id': job_id})


async def _delete_checkpoint_after_claim_loss(
    pool: AsyncConnectionPool,
    checkpointer: AsyncPostgresSaver | None,
    job: imports_queue.ClaimedJob,
) -> None:
    try:
        async with pool.connection() as conn:
            cursor = await conn.execute(
                'SELECT status, claim_version FROM question_import_jobs WHERE id = %s',
                (job.id,),
            )
            row = await cursor.fetchone()
    except Exception:
        logger.exception(
            'failed to inspect import claim before checkpoint cleanup',
            extra={'job_id': job.id},
        )
        return
    if row is None or row[0] != 'processing' or row[1] == job.claim_version:
        await _delete_checkpoint(checkpointer, job.id)


def _should_requeue(attempt: int, persistence_started: bool) -> bool:
    return not persistence_started and attempt < imports_queue.MAX_ATTEMPTS


async def _record_failure(pool: AsyncConnectionPool, job: imports_queue.ClaimedJob, code: str, cause: Exception) -> None:
    try:
        await imports_svc.record_import_job_failure(pool, job.id, job.claim_version, code, cause)
    except imports_svc._NoRowsError:
        pass


async def _process_with_heartbeat(
    pool: AsyncConnectionPool,
    job: imports_queue.ClaimedJob,
    encryption_secret: str,
    graph=None,
    checkpointer: AsyncPostgresSaver | None = None,
) -> bool:
    task = asyncio.create_task(
        process_queued_job(pool, job, encryption_secret, graph, checkpointer)
    )
    try:
        while True:
            done, _ = await asyncio.wait(
                {task}, timeout=imports_queue.HEARTBEAT_INTERVAL_SECONDS
            )
            if task in done:
                return await task
            try:
                await imports_queue.heartbeat_job(pool, job.id, job.claim_version)
            except imports_queue.ClaimLostError:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
                raise
    finally:
        if not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


async def _acquire_job_lock(conn, job_id: int) -> None:
    await conn.execute('SELECT pg_advisory_lock(%s)', (job_id,))
    await conn.commit()


async def _release_job_lock(conn, job_id: int) -> None:
    try:
        await conn.execute('SELECT pg_advisory_unlock(%s)', (job_id,))
        await conn.commit()
    except Exception:
        logger.exception('failed to release import advisory lock', extra={'job_id': job_id})
        await conn.close()


async def _check_checkpoint_schema(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        cursor = await conn.execute('SELECT MAX(v) FROM checkpoint_migrations')
        row = await cursor.fetchone()
    if row is None or row['max'] != CHECKPOINT_SCHEMA_VERSION:
        raise RuntimeError(
            'LangGraph checkpoint schema is missing or incompatible; apply the database schema first'
        )


async def _handle_claimed_job(
    pool: AsyncConnectionPool,
    stop: asyncio.Event,
    job: imports_queue.ClaimedJob,
    encryption_secret: str,
    graph=None,
    checkpointer: AsyncPostgresSaver | None = None,
) -> None:
    if job.persistence_started:
        try:
            await _record_failure(
                pool, job, imports_svc.IMPORT_PERSISTENCE_INTERRUPTED_CODE,
                RuntimeError('worker claim expired after persistence started'),
            )
        finally:
            await _delete_checkpoint(checkpointer, job.id)
        return
    if job.attempts_exhausted:
        try:
            await _record_failure(
                pool, job, imports_svc.IMPORT_ATTEMPTS_EXHAUSTED_CODE,
                RuntimeError('import retry limit reached'),
            )
        finally:
            await _delete_checkpoint(checkpointer, job.id)
        return

    persistence_started = False
    try:
        persistence_started = await _process_with_heartbeat(
            pool, job, encryption_secret, graph, checkpointer
        )
    except imports_queue.ClaimLostError:
        await _delete_checkpoint_after_claim_loss(pool, checkpointer, job)
        return
    except Exception as err:
        persistence_started = persistence_started or job.persistence_started
        if stop.is_set():
            try:
                if persistence_started:
                    await _record_failure(
                        pool, job, imports_svc.IMPORT_PERSISTENCE_INTERRUPTED_CODE, err
                    )
                else:
                    await imports_queue.release_job(pool, job.id, job.claim_version)
            except imports_queue.ClaimLostError:
                pass
            await _delete_checkpoint_after_claim_loss(pool, checkpointer, job)
            raise
        if _should_requeue(job.attempt, persistence_started):
            try:
                await imports_queue.requeue_job(
                    pool, job.id, job.claim_version,
                    imports_queue.retry_backoff_seconds(job.attempt),
                )
            except imports_queue.ClaimLostError:
                await _delete_checkpoint_after_claim_loss(pool, checkpointer, job)
            return
        error_code = (
            imports_svc.IMPORT_PERSISTENCE_INTERRUPTED_CODE
            if persistence_started
            else imports_svc.IMPORT_ATTEMPTS_EXHAUSTED_CODE
        )
        try:
            await _record_failure(pool, job, error_code, err)
        finally:
            await _delete_checkpoint(checkpointer, job.id)


async def run_worker(
    pool: AsyncConnectionPool,
    stop: asyncio.Event,
    encryption_secret: str,
    graph=None,
    checkpointer: AsyncPostgresSaver | None = None,
    lock_pool: AsyncConnectionPool | None = None,
) -> None:
    while not stop.is_set():
        job = await imports_queue.claim_next_job(pool)
        if job is None:
            try:
                await asyncio.wait_for(stop.wait(), timeout=imports_queue.POLL_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                pass
            continue
        async with (lock_pool or pool).connection() as lock_conn:
            await _acquire_job_lock(lock_conn, job.id)
            try:
                await _handle_claimed_job(
                    pool, stop, job, encryption_secret, graph, checkpointer
                )
            finally:
                await _release_job_lock(lock_conn, job.id)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    cfg = config.load()
    pool = db_mod.open_pool()

    async def _run() -> None:
        await pool.open()
        db_cfg = config.load_db_config()
        checkpoint_pool = AsyncConnectionPool(
            conninfo=db_cfg.database_url,
            min_size=1,
            max_size=2,
            timeout=db_cfg.connect_timeout_seconds,
            kwargs={
                'autocommit': True,
                'prepare_threshold': 0,
                'row_factory': dict_row,
                'connect_timeout': db_cfg.connect_timeout_seconds,
            },
            open=False,
        )
        try:
            await checkpoint_pool.open()
            await _check_checkpoint_schema(checkpoint_pool)
            saver = AsyncPostgresSaver(
                checkpoint_pool,
                serde=JsonPlusSerializer(allowed_msgpack_modules=None),
            )
            graph = agents.build_parse_graph(saver)
            stop = asyncio.Event()
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, stop.set)
            await run_worker(
                pool,
                stop,
                cfg.llm_key_encryption_secret,
                graph,
                saver,
                checkpoint_pool,
            )
        finally:
            await checkpoint_pool.close()
            await db_mod.close_pool()

    asyncio.run(_run())


if __name__ == '__main__':
    main()
