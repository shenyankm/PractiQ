"""Standalone operator evaluation admission never changes HTTP identity policy."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from langchain_core.messages import HumanMessage
from pydantic import BaseModel

from practiq_ai import identity, llm, runtime
from scripts import evaluate_grading
from tests.support import FakeModel


@pytest.mark.parametrize('source_only', [False, True])
async def test_grading_evaluation_uses_operator_receipts_without_an_application_owner(monkeypatch, source_only):
    monkeypatch.setenv('AI_TASK_COST_LIMIT', '')
    monkeypatch.setenv('AI_DAILY_COST_LIMIT', '')
    monkeypatch.setattr(runtime, 'current', None)
    model = FakeModel(responses=[{'value': 1}])
    records = []

    class Output(BaseModel):
        value: int

    async def evaluate(*args):
        result, usage, error = await llm.structured_call(model, [HumanMessage(content='Synthetic evaluation')], Output, 'evaluation', cost_scope='evaluation:standalone', call_records=records)
        assert result is not None and result.value == 1 and usage and error is None
        return {'status': 'PASSED'}
    monkeypatch.setattr(evaluate_grading, 'evaluate_source' if source_only else 'evaluate', evaluate)
    assert await evaluate_grading.run_evaluation(1, None, source_only=source_only) == {'status': 'PASSED'}
    assert len(model.calls) == 1 and records[0]['usageStatus'] == 'known'
    with pytest.raises(HTTPException) as missing:
        await identity.reserve('evaluation:outside', 'call', 'modelCalls', {})
    assert missing.value.status_code == 503


def test_operator_evaluation_refuses_a_service_or_http_actor(monkeypatch):
    monkeypatch.setattr(runtime, 'current', SimpleNamespace())
    with pytest.raises(RuntimeError, match='standalone'), identity.operator_evaluation():
        pytest.fail('Running service must not bypass account admission')
    monkeypatch.setattr(runtime, 'current', None)
    token = identity.actor.set({'id': 'authenticated-user'})
    try:
        with pytest.raises(RuntimeError, match='standalone'), identity.operator_evaluation():
            pytest.fail('Authenticated actor must not bypass account admission')
    finally:
        identity.actor.reset(token)
