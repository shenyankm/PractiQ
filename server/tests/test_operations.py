import asyncio
import uuid

import pytest
from langchain_core.messages import AIMessage

from server import envelope
from server.operations import OperationManager, record_model_call


class DummyModel:
    _llm_type = 'fake'
    model_name = 'fake-model'


async def test_operation_reports_known_and_unknown_usage() -> None:
    manager = OperationManager(timeout_seconds=1, max_concurrency=1)

    async def work():
        record_model_call(
            DummyModel(),
            'answer_generation',
            'succeeded',
            AIMessage(
                content='ok',
                usage_metadata={
                    'input_tokens': 7,
                    'output_tokens': 3,
                    'total_tokens': 10,
                },
            ),
        )
        record_model_call(DummyModel(), 'answer_generation', 'provider_error')
        return 'done'

    result, usage = await manager.run(str(uuid.uuid4()), work)
    assert result == 'done'
    assert usage['complete'] is False
    assert usage['calls'][0]['inputTokens'] == 7
    assert usage['calls'][1]['attempt'] == 2
    assert 'inputTokens' not in usage['calls'][1]


async def test_operation_timeout_returns_usage_meta() -> None:
    manager = OperationManager(timeout_seconds=0.01, max_concurrency=1)

    async def work():
        await asyncio.sleep(1)

    with pytest.raises(envelope.APIError) as exc_info:
        await manager.run(str(uuid.uuid4()), work)
    assert exc_info.value.code == 'AI_OPERATION_TIMEOUT'
    assert exc_info.value.meta['usage'] == {'calls': [], 'complete': True}


async def test_operation_can_be_cancelled_and_duplicate_ids_are_rejected() -> None:
    manager = OperationManager(timeout_seconds=1, max_concurrency=1)
    operation = str(uuid.uuid4())
    started = asyncio.Event()

    async def work():
        started.set()
        await asyncio.sleep(1)

    running = asyncio.create_task(manager.run(operation, work))
    await started.wait()
    with pytest.raises(envelope.APIError) as duplicate:
        await manager.run(operation, work)
    assert duplicate.value.code == 'AI_OPERATION_CONFLICT'

    await manager.cancel(operation)
    with pytest.raises(envelope.APIError) as cancelled:
        await running
    assert cancelled.value.code == 'AI_OPERATION_CANCELLED'


async def test_operation_state_and_execution_are_bounded_by_admission_limit() -> None:
    manager = OperationManager(timeout_seconds=1, max_concurrency=2)
    entered: asyncio.Queue[None] = asyncio.Queue()
    release = asyncio.Event()
    running_count = 0
    peak_count = 0

    async def work():
        nonlocal running_count, peak_count
        running_count += 1
        peak_count = max(peak_count, running_count)
        entered.put_nowait(None)
        await release.wait()
        running_count -= 1
        return 'done'

    tasks = [
        asyncio.create_task(manager.run(str(uuid.uuid4()), work))
        for _ in range(3)
    ]
    await entered.get()
    await entered.get()
    await asyncio.sleep(0.01)

    assert peak_count == 2
    assert len(manager._states) == 2

    release.set()
    assert [item[0] for item in await asyncio.gather(*tasks)] == [
        'done',
        'done',
        'done',
    ]


async def test_operation_deadline_includes_admission_queue_time() -> None:
    manager = OperationManager(timeout_seconds=0.1, max_concurrency=1)
    first_started = asyncio.Event()

    async def first_work():
        first_started.set()
        await asyncio.sleep(0.07)
        return 'first'

    async def queued_work():
        await asyncio.sleep(0.07)
        return 'queued'

    first = asyncio.create_task(manager.run(str(uuid.uuid4()), first_work))
    await first_started.wait()

    with pytest.raises(envelope.APIError) as queued:
        await manager.run(str(uuid.uuid4()), queued_work)
    assert queued.value.code == 'AI_OPERATION_TIMEOUT'
    assert queued.value.meta['usage'] == {'calls': [], 'complete': True}
    assert (await first)[0] == 'first'
