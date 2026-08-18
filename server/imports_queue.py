
from dataclasses import dataclass

from psycopg_pool import AsyncConnectionPool

MAX_ATTEMPTS = 3
POLL_INTERVAL_SECONDS = 0.5
CLAIM_TIMEOUT_SECONDS = 30 * 60
HEARTBEAT_INTERVAL_SECONDS = 60


class ClaimLostError(Exception):
    pass


CLAIM_NEXT_JOB_SQL = """
    WITH next_job AS (
        SELECT
            id,
            status = 'processing' AND stage = 'persisting' AS persistence_started,
            retry_count >= %s AS attempts_exhausted
        FROM question_import_jobs
        WHERE (
            status = 'queued'
            AND available_at IS NOT NULL
            AND available_at <= NOW()
        ) OR (
            status = 'processing'
            AND updated_at <= NOW() - (%s * INTERVAL '1 millisecond')
        )
        ORDER BY COALESCE(available_at, updated_at), id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    UPDATE question_import_jobs AS job
    SET status = 'processing',
        stage = CASE WHEN next_job.persistence_started THEN 'persisting' ELSE 'processing' END,
        available_at = NULL,
        claim_version = job.claim_version + 1,
        retry_count = CASE
            WHEN next_job.persistence_started OR next_job.attempts_exhausted THEN job.retry_count
            ELSE job.retry_count + 1
        END,
        completed_at = NULL
    FROM next_job
    WHERE job.id = next_job.id
    RETURNING
        job.id,
        job.persist_questions,
        job.retry_count,
        job.claim_version,
        next_job.persistence_started,
        next_job.attempts_exhausted
"""

BEGIN_PERSISTENCE_SQL = """
    UPDATE question_import_jobs
    SET stage = 'persisting'
    WHERE id = %s
      AND status = 'processing'
      AND stage = 'processing'
      AND claim_version = %s
"""

REQUEUE_JOB_SQL = """
    UPDATE question_import_jobs
    SET status = 'queued',
        stage = 'queued',
        available_at = NOW() + (%s * INTERVAL '1 millisecond'),
        completed_at = NULL
    WHERE id = %s
      AND status = 'processing'
      AND stage = 'processing'
      AND claim_version = %s
"""

RELEASE_JOB_SQL = """
    UPDATE question_import_jobs
    SET status = 'queued',
        stage = 'queued',
        available_at = NOW(),
        retry_count = GREATEST(retry_count - 1, 0),
        completed_at = NULL
    WHERE id = %s
      AND status = 'processing'
      AND stage = 'processing'
      AND claim_version = %s
"""

HEARTBEAT_JOB_SQL = """
    UPDATE question_import_jobs
    SET updated_at = NOW()
    WHERE id = %s
      AND status = 'processing'
      AND claim_version = %s
"""


@dataclass
class ClaimedJob:
    id: int
    persist_questions: bool
    attempt: int
    claim_version: int
    persistence_started: bool
    attempts_exhausted: bool


async def claim_next_job(pool: AsyncConnectionPool) -> ClaimedJob | None:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            CLAIM_NEXT_JOB_SQL, (MAX_ATTEMPTS, CLAIM_TIMEOUT_SECONDS * 1000)
        )
        row = await cursor.fetchone()
    if row is None:
        return None
    return ClaimedJob(
        id=row[0],
        persist_questions=row[1],
        attempt=row[2],
        claim_version=row[3],
        persistence_started=row[4],
        attempts_exhausted=row[5],
    )


async def _exec_claim_mutation(pool: AsyncConnectionPool, query: str, *args) -> None:
    async with pool.connection() as conn:
        result = await conn.execute(query, args)
        if result.rowcount == 0:
            raise ClaimLostError()


async def begin_persistence(pool: AsyncConnectionPool, job_id: int, claim_version: int) -> None:
    await _exec_claim_mutation(pool, BEGIN_PERSISTENCE_SQL, job_id, claim_version)


async def requeue_job(pool: AsyncConnectionPool, job_id: int, claim_version: int, delay_seconds: float) -> None:
    await _exec_claim_mutation(pool, REQUEUE_JOB_SQL, int(delay_seconds * 1000), job_id, claim_version)


async def release_job(pool: AsyncConnectionPool, job_id: int, claim_version: int) -> None:
    await _exec_claim_mutation(pool, RELEASE_JOB_SQL, job_id, claim_version)


async def heartbeat_job(pool: AsyncConnectionPool, job_id: int, claim_version: int) -> None:
    await _exec_claim_mutation(pool, HEARTBEAT_JOB_SQL, job_id, claim_version)


def retry_backoff_seconds(attempt: int) -> int:
    if attempt < 1:
        attempt = 1
    return 1 << (attempt - 1)
