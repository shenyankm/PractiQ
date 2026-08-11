"""Import queue worker: python -m server.worker.

Mirrors backend/cmd/practiq-worker/{main,process}.go. AI parse runs in-process.
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal

from psycopg_pool import AsyncConnectionPool

from . import agents, config, db as db_mod, imports_queue
from .ai_schemas import DocumentParseRequest, DocumentParseResult
from .auth import runtime as auth_runtime
from .services import groups as groups_svc
from .services import imports as imports_svc
from .services import questions as questions_svc

logger = logging.getLogger('practiq.worker')


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
) -> None:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            INSERT INTO question_import_job_events (job_id, stage, step_code, step_label, status, message, overall_progress_percent, step_progress_percent, payload_json)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, '{}')
            RETURNING id
            """,
            (job_id, stage, step_code, step_label, status, message, overall, step),
        )
        event_id = (await cursor.fetchone())[0]
        await conn.execute(
            'UPDATE question_import_jobs SET last_event_id = %s, last_event_at = NOW() WHERE id = %s',
            (event_id, job_id),
        )


async def _complete_import_job(
    pool: AsyncConnectionPool, job_id: int, claim_version: int,
    imported_questions: int, result: DocumentParseResult,
) -> None:
    raw_result = json.dumps(result.model_dump(), separators=(',', ':'))
    warnings = json.dumps(result.warnings, separators=(',', ':'))
    async with pool.connection() as conn:
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


def _non_empty(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    return value


async def process_queued_job(
    pool: AsyncConnectionPool, claimed: imports_queue.ClaimedJob
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
    await _record_import_event(pool, job['id'], 'processing', 'parse', '处理中', 'processing', None, 10, 10)
    request = await _build_parse_request(pool, job)
    result = await agents.parse_document(request)

    created_count = 0
    persistence_started = False
    if claimed.persist_questions and job['bank_id'] is not None:
        if result.questions:
            await imports_queue.begin_persistence(pool, job['id'], claimed.claim_version)
            persistence_started = True
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
                    output_metadata={'sourceText': parsed.sourceText, 'needsReview': parsed.needsReview},
                ),
            )
            question_ids.append(question['id'])
            created_count += 1
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
    await _record_import_event(pool, job['id'], 'completed', 'complete', '导入完成', 'completed', None, 100, 100)
    return persistence_started


def _should_requeue(attempt: int, persistence_started: bool) -> bool:
    return not persistence_started and attempt < imports_queue.MAX_ATTEMPTS


async def _record_failure(pool: AsyncConnectionPool, job: imports_queue.ClaimedJob, code: str, cause: Exception) -> None:
    try:
        await imports_svc.record_import_job_failure(pool, job.id, job.claim_version, code, cause)
    except imports_svc._NoRowsError:
        pass


async def run_worker(pool: AsyncConnectionPool, stop: asyncio.Event) -> None:
    while not stop.is_set():
        job = await imports_queue.claim_next_job(pool)
        if job is None:
            try:
                await asyncio.wait_for(stop.wait(), timeout=imports_queue.POLL_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                pass
            continue

        if job.persistence_started:
            await _record_failure(
                pool, job, imports_svc.IMPORT_PERSISTENCE_INTERRUPTED_CODE,
                RuntimeError('worker claim expired after persistence started'),
            )
            continue
        if job.attempts_exhausted:
            await _record_failure(
                pool, job, imports_svc.IMPORT_ATTEMPTS_EXHAUSTED_CODE,
                RuntimeError('import retry limit reached'),
            )
            continue

        persistence_started = False
        try:
            persistence_started = await process_queued_job(pool, job)
        except imports_queue.ClaimLostError:
            continue
        except Exception as err:
            if stop.is_set():
                # Shutdown mid-job: release or record failure, mirroring the Go cleanup path.
                try:
                    if persistence_started:
                        await _record_failure(pool, job, imports_svc.IMPORT_PERSISTENCE_INTERRUPTED_CODE, err)
                    else:
                        await imports_queue.release_job(pool, job.id, job.claim_version)
                except imports_queue.ClaimLostError:
                    pass
                raise
            if _should_requeue(job.attempt, persistence_started):
                try:
                    await imports_queue.requeue_job(
                        pool, job.id, job.claim_version, imports_queue.retry_backoff_seconds(job.attempt)
                    )
                except imports_queue.ClaimLostError:
                    pass
                continue
            error_code = (
                imports_svc.IMPORT_PERSISTENCE_INTERRUPTED_CODE
                if persistence_started
                else imports_svc.IMPORT_ATTEMPTS_EXHAUSTED_CODE
            )
            await _record_failure(pool, job, error_code, err)
            continue


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    config.load_env()
    pool = db_mod.open_pool()

    async def _run() -> None:
        await pool.open()
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        try:
            await run_worker(pool, stop)
        finally:
            await db_mod.close_pool()

    asyncio.run(_run())


if __name__ == '__main__':
    main()
