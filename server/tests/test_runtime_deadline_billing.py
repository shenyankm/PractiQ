"""Deadline cancellation preserves paid fragments and unknown account usage."""

import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4
from zipfile import ZipFile

import pytest

from practiq_ai import execution, runtime, saas, task_api
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
)
from tests.db_support import seed_account, setup_api
from tests.support import parsed


@pytest.mark.usefixtures('disposable_databases')
async def test_dispatched_deadline_preserves_partial_export_and_blocks_account(monkeypatch):
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    deadlines = []

    def execution_timeout(seconds):
        deadline = asyncio.timeout(seconds)
        deadlines.append(deadline)
        return deadline

    runtime_asyncio = SimpleNamespace(**vars(asyncio))
    runtime_asyncio.timeout = execution_timeout
    monkeypatch.setattr(runtime, 'asyncio', runtime_asyncio)

    def expire_second_call(_messages, _schema):
        deadlines[-1].reschedule(asyncio.get_running_loop().time())
        return (30, parsed('Second'))

    service, reference, model = await setup_api(
        monkeypatch, [parsed('First'), expire_second_call], parts=['1. First\n', '2. Second'],
    )
    credential = await seed_account(service.db)
    account = await saas.identity('13800138000', credential)
    other_credential = await seed_account(service.db, '13900139000')
    other_account = await saas.identity('13900139000', other_credential)
    foreign_call = str(uuid4())
    async with service.db.transaction() as conn:
        await conn.execute(
            "INSERT INTO import_calls(call_key,account_id,thread_id,rates,status,dispatched) VALUES(%s,%s,%s,%s,'pending',true)",
            (foreign_call, other_account, str(uuid4()), json.dumps({'inputMicropointsPer1k': 1_000_000, 'outputMicropointsPer1k': 3_000_000})),
        )
    foreign_receipt = await service.db.rows('SELECT * FROM import_calls WHERE call_key=%s', (foreign_call,))
    token = saas.ACCOUNT.set(account)
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        receipt = await task_api.create_task(DocumentTaskCreate(
            requestId=uuid4(), document=DocumentReference.model_validate(reference),
        ))
        await service.wait_idle()
        detail = await task_api.get_task(receipt['threadId'])
        assert detail['state'] == 'INTERRUPTED', detail
        assert detail['blocking'] == ['MODEL_RESULT_UNKNOWN']
        assert detail['canExportCompleted'] and 'resume' in detail['allowedActions']
        assert len(model.calls) == 2 and deadlines[-1].expired()

        calls = await service.db.rows('SELECT call_key,status,usage,dispatched FROM import_calls WHERE thread_id=%s ORDER BY created_at', (receipt['threadId'],))
        assert [call['status'] for call in calls] == ['settled', 'unknown'], calls
        assert detail['billing']['usageUnknown'] and detail['billing']['chargedMicropoints'] == '25000', detail['billing']
        assert await service.db.rows('SELECT * FROM import_calls WHERE call_key=%s', (foreign_call,)) == foreign_receipt
        unknown = calls[1]
        assert unknown['dispatched'] and unknown['usage'] is None
        assert detail['unknownUsageCalls'] == [unknown['call_key']]
        saved_call = await service.db.store.aget(
            execution.namespace(receipt['threadId'], 'calls'), unknown['call_key'], refresh_ttl=False,
        )
        assert saved_call and saved_call.value['usageStatus'] == 'unknown'
        assert saved_call.value['inputTokens'] is saved_call.value['outputTokens'] is None
        debits = await service.db.rows("SELECT reference,amount FROM import_ledger WHERE kind='model'")
        assert debits == [{'reference': calls[0]['call_key'], 'amount': -25000}]

        with await task_api.export_task(receipt['threadId'], detail['checkpointId'], completed=True) as bank, ZipFile(bank) as archive:
            payload = json.loads(archive.read('questions.json'))
        assert payload['status'] == 'PARTIAL'
        assert [question['stem'] for question in payload['result']['questions']] == ['First']
        assert len(model.calls) == 2
        assert (await task_api.get_task(receipt['threadId']))['runId'] == receipt['runId']

        await task_api.control_task(receipt['threadId'], DocumentTaskControl(
            requestId=uuid4(), action='resume', checkpointId=detail['checkpointId'],
        ))
        await service.wait_idle()
        resumed = await task_api.get_task(receipt['threadId'])
        assert resumed['state'] == 'PAUSED' and resumed['billing']['usageUnknown'], resumed
        assert any(reason.get('code') == 'USAGE_UNKNOWN' for reason in resumed['blocking'])

        new_task = await task_api.create_task(DocumentTaskCreate(
            requestId=uuid4(), document=DocumentReference.model_validate(reference),
        ))
        await service.wait_idle()
        blocked = await task_api.get_task(new_task['threadId'])
        assert blocked['state'] == 'PAUSED' and blocked['billing']['usageUnknown'], blocked
        assert any(reason.get('code') == 'USAGE_UNKNOWN' for reason in blocked['blocking'])
        assert len(model.calls) == 2
        assert await service.db.rows('SELECT call_key,status,usage,dispatched FROM import_calls WHERE thread_id=%s ORDER BY created_at', (receipt['threadId'],)) == calls
        assert await service.db.rows("SELECT reference,amount FROM import_ledger WHERE kind='model'") == debits
        assert await service.db.rows('SELECT * FROM import_calls WHERE call_key=%s', (foreign_call,)) == foreign_receipt
    finally:
        saas.ACCOUNT.reset(token)
