"""Estimated-cost admission is durable, atomic and never refunds uncertainty."""

import asyncio
from datetime import UTC, datetime

import pytest

from practiq_ai import cost_budget
from practiq_ai.config import load
from practiq_ai.errors import DocumentProcessingError
from tests.db_support import new_database


def configure(monkeypatch, *, task="1", daily="2"):
    for key, value in {
        "AI_COST_CURRENCY": "CNY", "AI_TASK_COST_LIMIT": task, "AI_DAILY_COST_LIMIT": daily,
        "AI_COST_INPUT_PER_MILLION": "2", "AI_COST_OUTPUT_PER_MILLION": "8",
        "AI_COST_TENCENT_PER_PAGE": "0.1",
    }.items():
        monkeypatch.setenv(key, value)


@pytest.mark.parametrize("name,value", [
    ("AI_TASK_COST_LIMIT", "NaN"), ("AI_DAILY_COST_LIMIT", "-1"),
    ("AI_COST_INPUT_PER_MILLION", "0.0000001"), ("AI_COST_CURRENCY", "invalid"),
])
def test_invalid_prices_fail_before_work(monkeypatch, name, value):
    configure(monkeypatch)
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match="AI_.*COST"):
        load()


async def test_disabled_cost_budget_needs_no_database():
    assert await cost_budget.reserve("task:a", "call", 10, "model") is None


def test_estimates_round_up_and_include_output(monkeypatch):
    configure(monkeypatch)
    settings = load()
    assert cost_budget.model_estimate(1, settings) == 131_074
    assert cost_budget.page_estimate(3, settings) == 300_000


@pytest.mark.usefixtures("disposable_databases")
async def test_parallel_daily_admission_and_replay_survive_reopen(monkeypatch):
    db = await new_database()
    configure(monkeypatch, task="1", daily="1")
    monkeypatch.setattr(cost_budget, "database", lambda runtime: db)
    results = await asyncio.gather(*[
        cost_budget.reserve(f"task:{index}", str(index), 600_000, "model")
        for index in range(2)
    ], return_exceptions=True)
    assert sum(isinstance(result, DocumentProcessingError) for result in results) == 1
    winner = next(index for index, result in enumerate(results) if isinstance(result, dict))
    await db.close()
    await db.open()
    assert await cost_budget.reserve(f"task:{winner}", str(winner), 600_000, "model") == results[winner]
    with pytest.raises(DocumentProcessingError) as error:
        await cost_budget.reserve("task:other", "third", 500_000, "tencent")
    assert error.value.code == "COST_BUDGET_EXCEEDED"


@pytest.mark.usefixtures("disposable_databases")
async def test_task_limit_currency_and_failed_transaction_keep_reservations(monkeypatch):
    db = await new_database()
    configure(monkeypatch)
    monkeypatch.setattr(cost_budget, "database", lambda runtime: db)
    await cost_budget.reserve("task:a", "first", 700_000, "model")
    with pytest.raises(DocumentProcessingError, match="budget"):
        await cost_budget.reserve("task:a", "second", 400_000, "model")
    # Rejected task reservations must not consume the shared daily balance.
    await cost_budget.reserve("task:b", "third", 1_000_000, "tencent")
    monkeypatch.setenv("AI_COST_CURRENCY", "USD")
    with pytest.raises(DocumentProcessingError) as error:
        await cost_budget.reserve("task:c", "fourth", 1, "model")
    assert error.value.code == "COST_CURRENCY_CONFLICT"


@pytest.mark.usefixtures("disposable_databases")
async def test_unknown_reservation_is_not_refunded_on_day_change(monkeypatch):
    db = await new_database()
    configure(monkeypatch)
    monkeypatch.setattr(cost_budget, "database", lambda runtime: db)
    monkeypatch.setattr(cost_budget, "now", lambda: datetime(2026, 10, 28, 23, 59, tzinfo=UTC))
    await cost_budget.reserve("task:a", "unknown", 900_000, "model")
    monkeypatch.setattr(cost_budget, "now", lambda: datetime(2026, 10, 29, tzinfo=UTC))
    with pytest.raises(DocumentProcessingError, match="budget"):
        await cost_budget.reserve("task:a", "retry", 200_000, "model")
    receipt = await cost_budget.reserve("task:b", "new-day", 900_000, "model")
    assert receipt is not None and receipt["reservedMicros"] == 900_000


@pytest.mark.usefixtures("disposable_databases")
async def test_model_cost_rejection_happens_before_a_second_provider_call(monkeypatch):
    from langchain_core.messages import HumanMessage
    from pydantic import BaseModel

    from practiq_ai import llm
    from tests.support import FakeModel

    class Result(BaseModel):
        value: int

    db = await new_database()
    configure(monkeypatch, task="0.2", daily="1")
    monkeypatch.setattr(cost_budget, "database", lambda runtime: db)
    model = FakeModel(responses=[{"value": 1}, {"value": 2}])
    records = []
    result, _, failure = await llm.structured_call(model, [HumanMessage(content="source")], Result, "test",
                                                 cost_scope="grade:test", call_records=records)
    assert result == Result(value=1) and failure is None
    assert records[0]["estimatedCost"]["reservedMicros"] > 100_000
    with pytest.raises(DocumentProcessingError) as error:
        await llm.structured_call(model, [HumanMessage(content="source")], Result, "test", cost_scope="grade:test", call_records=records)
    assert error.value.code == "COST_BUDGET_EXCEEDED" and len(model.calls) == 1
    assert records[-1]["status"] == "rejected"


@pytest.mark.usefixtures("disposable_databases")
@pytest.mark.parametrize("recovery", ["task_limit", "daily_limit", "new_day"])
async def test_rejected_model_cost_admission_is_rechecked_on_checkpoint_resume(monkeypatch, recovery):
    from uuid import uuid4

    from practiq_ai import execution
    from tests.support import parsed, run_config, setup_graph, tencent_provider

    graph, store, _, reference, model = setup_graph(monkeypatch, [parsed()])
    requests = tencent_provider(monkeypatch)
    db = await new_database()
    configure(monkeypatch, task="0.1" if recovery == "task_limit" else "1",
              daily="2" if recovery == "task_limit" else "0.2")
    monkeypatch.setenv("AI_MAX_DOCUMENT_PAGES", "1")
    monkeypatch.setattr(cost_budget, "database", lambda runtime: db)
    monkeypatch.setattr(cost_budget, "now", lambda: datetime(2026, 10, 28, 23, 59, tzinfo=UTC))
    config = run_config()
    with pytest.raises(DocumentProcessingError) as error:
        await graph.ainvoke({"document": reference}, config)
    assert error.value.code == "COST_BUDGET_EXCEEDED"
    assert not model.calls and requests
    provider_requests = list(requests)
    rejected = await store.asearch(execution.namespace("thread-1", "calls"))
    assert len(rejected) == 1 and rejected[0].value["status"] == "rejected"
    if recovery == "new_day":
        monkeypatch.setattr(cost_budget, "now", lambda: datetime(2026, 10, 29, tzinfo=UTC))
    else:
        monkeypatch.setenv("AI_TASK_COST_LIMIT" if recovery == "task_limit" else "AI_DAILY_COST_LIMIT", "2")
    result = await graph.ainvoke(None, {**config, "run_id": uuid4()})
    assert result["status"] == "SUCCEEDED"
    assert len(model.calls) == len(result["usage"]) == 1 and requests == provider_requests
    records = await store.asearch(execution.namespace("thread-1", "calls"))
    assert len(records) == 2
    assert any(item.key == rejected[0].key and item.value == rejected[0].value for item in records)
    assert sum(item.value["status"] == "completed" for item in records) == 1


@pytest.mark.usefixtures("disposable_databases")
async def test_tencent_cost_rejection_does_not_submit_or_start_a_model(monkeypatch):
    from tests.support import run_config, setup_graph, tencent_provider

    graph, _, _, reference, model = setup_graph(monkeypatch, [])
    requests = tencent_provider(monkeypatch)
    db = await new_database()
    configure(monkeypatch, task="0.01")
    monkeypatch.setattr(cost_budget, "database", lambda runtime: db)
    with pytest.raises(DocumentProcessingError) as error:
        await graph.ainvoke({"document": reference}, run_config())
    assert error.value.code == "COST_BUDGET_EXCEEDED" and not requests and not model.calls


@pytest.mark.usefixtures("disposable_databases")
async def test_evaluation_cost_database_keeps_exclusive_durable_reservations(monkeypatch):
    db = await new_database()
    monkeypatch.setenv("DATABASE_URI", db.uri)
    configure(monkeypatch)
    async with cost_budget.evaluation_database() as owned:
        assert owned is not None
        assert cost_budget.database(None) is owned
        receipt = await cost_budget.reserve("task:evaluation", "eval-call", 123, "model")
        with pytest.raises(RuntimeError, match="Stop the service"):
            async with cost_budget.evaluation_database():
                pytest.fail("evaluation ownership must be exclusive")
    persisted = await db.store.aget(cost_budget.NAMESPACE, "call:eval-call", refresh_ttl=False)
    assert persisted is not None and persisted.value == receipt
    with pytest.raises(DocumentProcessingError, match="running service database"):
        cost_budget.database(None)
