"""Protocol and broker boundaries, including ambiguous publish and ACK outcomes."""
import asyncio
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock
from uuid import uuid4

import aio_pika
import pytest
from pamqp.commands import Basic

from practiq_ai import messaging, runtime, task_api
from practiq_ai.config import rabbitmq_uri
from practiq_ai.contracts import DocumentReference, DocumentTaskCreate
from tests.support import parsed


def wire(body=None, version=1, content_type='text/plain') -> Any:
    return SimpleNamespace(body=body if body is not None else str(uuid4()).encode(),
                           headers={messaging.VERSION_HEADER: version}, content_type=content_type)


@pytest.mark.parametrize('body,version,content_type', [
    (b'a' * 37, 1, 'text/plain'), (b'a' * 36, 1, 'text/plain'),
    (b'\xff' * 36, 1, 'text/plain'), (None, True, 'text/plain'),
    (None, 2, 'text/plain'), (None, 1, 'application/json'),
    (str(uuid4()).upper().encode(), 1, 'text/plain'),
])
def test_protocol_rejects_untrusted_message(body, version, content_type):
    with pytest.raises((ValueError, UnicodeError)):
        messaging.decode(wire(body, version, content_type))


def test_protocol_contains_only_run_identifier():
    message = wire()
    assert messaging.decode(message) == message.body.decode()


@pytest.mark.parametrize('value', ['https://user:secret@host/vhost', 'amqp://host', 'amqp://host:invalid/vhost',
                                   'amqp://host/vhost?password=secret', 'amqp://host/vhost#secret'])
def test_broker_configuration_errors_do_not_include_password(monkeypatch, value):
    monkeypatch.setenv('RABBITMQ_URI', value)
    with pytest.raises(ValueError) as exc:
        rabbitmq_uri()
    assert 'secret' not in str(exc.value)


@pytest.mark.parametrize('host', ['broker.example', '10.0.0.1', '192.0.2.1', '[2001:db8::1]',
                                 'localhost.example', '127.0.0.1.example'])
def test_remote_broker_requires_tls_without_leaking_credentials(monkeypatch, host):
    monkeypatch.setenv('RABBITMQ_URI', f'amqp://user:secret@{host}/practiq')
    with pytest.raises(ValueError, match='AMQPS') as exc:
        rabbitmq_uri()
    assert 'secret' not in str(exc.value)


@pytest.mark.parametrize('value', [
    'amqp://user:secret@localhost/practiq', 'amqp://user:secret@127.0.0.1/practiq',
    'amqp://user:secret@127.0.0.2/practiq', 'amqp://user:secret@[::1]/practiq',
    'amqps://user:secret@broker.example:5671/practiq', 'amqps://user:secret@[2001:db8::1]/practiq',
])
def test_broker_accepts_loopback_or_tls(monkeypatch, value):
    monkeypatch.setenv('RABBITMQ_URI', value)
    assert rabbitmq_uri() == value


@pytest.mark.parametrize('confirm', [None, Basic.Nack(), TimeoutError(), RuntimeError('unroutable')])
async def test_only_positive_publisher_confirm_is_accepted(confirm):
    publish = AsyncMock()
    if isinstance(confirm, Exception):
        publish.side_effect = confirm
    else:
        publish.return_value = confirm
    with pytest.raises((TypeError, RuntimeError, TimeoutError)):
        await messaging.publish(cast(Any, SimpleNamespace(default_exchange=SimpleNamespace(publish=publish))), str(uuid4()))
    args, kwargs = publish.call_args
    assert args[0].delivery_mode == aio_pika.DeliveryMode.PERSISTENT
    assert kwargs['mandatory'] and kwargs['timeout'] == 5


async def test_delivery_poison_and_infrastructure_are_not_busy_requeued():
    service = SimpleNamespace(deliver=AsyncMock(), accepting=True, fatal=AsyncMock())
    delivery = messaging.Delivery(service)
    message = wire(b'bad')
    message.reject = AsyncMock()
    await delivery.consume(message)
    message.reject.assert_awaited_once_with(requeue=False)
    service.deliver.assert_not_awaited()
    message = wire()
    message.ack = AsyncMock()
    service.deliver.side_effect = RuntimeError('connection failed')
    await delivery.consume(message)
    assert delivery.failed.is_set()
    message.ack.assert_not_awaited()


@pytest.mark.parametrize('close_error', [None, ConnectionError('close failed')])
async def test_repeated_publication_failures_back_off_even_when_connection_cleanup_fails(monkeypatch, close_error):
    service = SimpleNamespace(stopping=False, active={}, stop_event=SimpleNamespace(wait=AsyncMock()),
                              db=SimpleNamespace(rows=AsyncMock(return_value=[{'run_id': str(uuid4())}])))
    channel = SimpleNamespace(get_underlay_channel=AsyncMock(return_value=SimpleNamespace(on_consumer_cancel_callbacks=set())))
    connection = SimpleNamespace(channel=AsyncMock(return_value=channel), is_closed=False,
                                 close=AsyncMock(side_effect=close_error))
    queue = SimpleNamespace(consume=AsyncMock())
    delays = []
    async def wait_for(awaitable, *, timeout):
        await awaitable
        delays.append(timeout)
        if len(delays) == 3:
            service.stopping = True
    monkeypatch.setattr(messaging, 'load', lambda: SimpleNamespace(read_only=False))
    monkeypatch.setattr(messaging, 'rabbitmq_uri', lambda: 'amqp://host/vhost')
    monkeypatch.setattr(messaging.aio_pika, 'connect', AsyncMock(return_value=connection))
    monkeypatch.setattr(messaging, 'topology', AsyncMock(return_value=queue))
    monkeypatch.setattr(messaging, 'publish', AsyncMock(side_effect=TimeoutError('confirm unknown')))
    monkeypatch.setattr(messaging.asyncio, 'wait_for', wait_for)
    await messaging.Delivery(service).run()
    assert delays == [1, 2, 4]
    assert connection.close.await_count == 3


@pytest.mark.usefixtures('disposable_databases')
async def test_run_outbox_receipt_rollback_and_duplicate_are_atomic(monkeypatch):
    from tests.db_support import setup_api
    service, reference, _ = await setup_api(monkeypatch)
    request = DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference))
    original = task_api._save_receipt
    with monkeypatch.context() as patch:
        patch.setattr(task_api, '_save_receipt', AsyncMock(side_effect=RuntimeError('rollback')))
        with pytest.raises(RuntimeError, match='rollback'):
            await task_api.create_task(request)
    for table in ('document_tasks', 'document_runs', 'document_outbox', 'document_receipts'):
        assert not await service.db.rows(f'SELECT * FROM {table}')
    monkeypatch.setattr(task_api, '_save_receipt', original)
    receipt = await task_api.create_task(request)
    assert await task_api.create_task(request) == receipt
    await service.wait_idle()
    for table in ('document_runs', 'document_outbox', 'document_receipts'):
        assert len(await service.db.rows(f'SELECT * FROM {table}')) == 1


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('window', ['before_publish', 'after_publish', 'confirm_unknown', 'ack_unknown'])
async def test_ambiguous_broker_windows_do_not_repeat_models(monkeypatch, window):
    from tests.db_support import setup_api
    calls = []
    original_publish = messaging.publish
    original_ack = aio_pika.IncomingMessage.ack
    failed = asyncio.Event()
    async def publish(channel, run_id):
        if not failed.is_set() and window == 'before_publish':
            failed.set()
            raise ConnectionError('offline')
        await original_publish(channel, run_id)
        if not failed.is_set() and window in {'after_publish', 'confirm_unknown'}:
            failed.set()
            raise TimeoutError('confirm lost')
    async def ack(message, *args, **kwargs):
        if not failed.is_set() and window == 'ack_unknown':
            failed.set()
            raise ConnectionError('ACK lost')
        calls.append(1)
        await original_ack(message, *args, **kwargs)
    monkeypatch.setattr(messaging, 'publish', publish)
    monkeypatch.setattr(aio_pika.IncomingMessage, 'ack', ack)
    service, reference, model = await setup_api(monkeypatch)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await asyncio.wait_for(failed.wait(), 10)
    async with asyncio.timeout(15):
        while not calls or not (await service.db.rows('SELECT published_at FROM document_outbox'))[0]['published_at']:
            await asyncio.sleep(.02)
    await service.wait_idle()
    assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
    assert len(model.calls) == 1


@pytest.mark.usefixtures('disposable_databases')
async def test_duplicate_deliveries_share_execution_and_completed_or_deleted_runs_are_passive(monkeypatch):
    from tests.db_support import setup_api
    entered, release = asyncio.Event(), asyncio.Event()
    original = runtime.Service.execute
    async def execute(self, run):
        entered.set()
        await release.wait()
        return await original(self, run)
    monkeypatch.setattr(runtime.Service, 'execute', execute)
    service, reference, model = await setup_api(monkeypatch, [parsed()])
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await asyncio.wait_for(entered.wait(), 10)
    duplicate = asyncio.create_task(service.deliver(receipt['runId']))
    await asyncio.sleep(.05)
    assert len(service.active) == 1 and not model.calls
    release.set()
    assert await duplicate
    await service.wait_idle()
    assert await service.deliver(receipt['runId'])
    await task_api.delete_task(receipt['threadId'])
    assert await service.deliver(receipt['runId'])
    assert len(model.calls) == 1
    assert not await service.db.rows('SELECT * FROM document_outbox')


@pytest.mark.usefixtures('disposable_databases')
async def test_quorum_topology_poison_deadletters_and_unroutable_publish_is_not_confirmed(monkeypatch):
    import os
    from urllib.parse import urlsplit

    from practiq_ai.config import load
    from tests.db_support import setup_api
    from tests.mq_support import api

    _service, _, model = await setup_api(monkeypatch)
    uri = os.environ['RABBITMQ_URI']
    vhost = urlsplit(uri).path.lstrip('/')
    detail = (await asyncio.to_thread(api, 'GET', f'/api/queues/{vhost}/{messaging.QUEUE}')).json()
    assert detail['type'] == 'quorum' and detail['durable']
    assert detail['arguments']['x-consumer-timeout'] >= load().run_timeout_seconds * 1000 + 300_000
    assert detail['arguments']['x-delivery-limit'] == 20
    assert detail['arguments']['x-dead-letter-strategy'] == 'at-least-once'
    connection = await aio_pika.connect(uri)
    async with connection:
        channel = await connection.channel(on_return_raises=True)
        await channel.default_exchange.publish(aio_pika.Message(b'poison'), routing_key=messaging.QUEUE)
        dlq = await channel.get_queue(messaging.DEAD_QUEUE)
        async with asyncio.timeout(10):
            message = None
            while message is None:
                message = await dlq.get(fail=False)
                if message is None:
                    await asyncio.sleep(.05)
        assert message.body == b'poison'
        await message.ack()
        with pytest.raises(aio_pika.exceptions.DeliveryError):
            await channel.default_exchange.publish(aio_pika.Message(b'body'), routing_key='missing', mandatory=True, timeout=5)
    assert not model.calls


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('failure', ['disconnect', 'restart'])
async def test_broker_failure_keeps_old_execution_exclusive_and_outbox_durable(monkeypatch, failure):
    import os
    import subprocess
    from urllib.parse import quote, urlsplit

    from tests import mq_support
    from tests.db_support import setup_api

    entered, release = asyncio.Event(), asyncio.Event()
    original = runtime.Service.execute
    async def execute(self, run):
        entered.set()
        await release.wait()
        await original(self, run)
    monkeypatch.setattr(runtime.Service, 'execute', execute)
    monkeypatch.setenv('N_JOBS_PER_WORKER', '1')
    service, reference, model = await setup_api(monkeypatch, [parsed(), parsed('second')])
    first = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await asyncio.wait_for(entered.wait(), 10)
    if failure == 'restart':
        container = mq_support.CONTAINER or os.environ.get('TEST_RABBITMQ_CONTAINER')
        if not container:
            release.set()
            pytest.skip('Broker restart requires the isolated TEST_RABBITMQ_CONTAINER')
        await asyncio.to_thread(subprocess.run, ['docker', 'restart', container], check=True, capture_output=True, timeout=60)
    else:
        vhost = urlsplit(os.environ['RABBITMQ_URI']).path.lstrip('/')
        async with asyncio.timeout(15):
            connections = []
            while not connections:
                connections = [item for item in (await asyncio.to_thread(mq_support.api, 'GET', '/api/connections')).json() if item['vhost'] == vhost]
                if not connections:
                    await asyncio.sleep(.1)
        for connection in connections:
            await asyncio.to_thread(mq_support.api, 'DELETE', '/api/connections/' + quote(connection['name'], safe=''))
    async with asyncio.timeout(10):
        while service.delivery.connected:
            await asyncio.sleep(.02)
    assert not await service.ready()
    assert len(service.active) == 1
    second = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await asyncio.sleep(.2)
    assert not model.calls and len(service.active) == 1
    assert (await service.db.rows('SELECT published_at FROM document_outbox WHERE run_id=%s', (second['runId'],)))[0]['published_at'] is None
    release.set()
    async with asyncio.timeout(60):
        while not service.delivery.connected:
            await asyncio.sleep(.1)
    await service.wait_idle()
    for receipt in (first, second):
        assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
    assert len(model.calls) == 2


@pytest.mark.usefixtures('disposable_databases')
async def test_infrastructure_poison_reaches_delivery_limit_without_model_work(monkeypatch):
    import os

    from tests.db_support import setup_api

    original = aio_pika.Channel.declare_queue
    async def declare(channel, name, **kwargs):
        if name == messaging.QUEUE:
            kwargs['arguments'] = {**kwargs['arguments'], 'x-delivery-limit': 1,
                                   'x-delayed-retry-min': 1000, 'x-delayed-retry-max': 1000}
        return await original(channel, name, **kwargs)
    monkeypatch.setattr(aio_pika.Channel, 'declare_queue', declare)
    service, reference, model = await setup_api(monkeypatch)
    attempts = AsyncMock(side_effect=RuntimeError('infrastructure poison'))
    monkeypatch.setattr(service, 'deliver', attempts)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    connection = await aio_pika.connect(os.environ['RABBITMQ_URI'])
    async with connection:
        channel = await connection.channel()
        queue = await channel.get_queue(messaging.DEAD_QUEUE)
        async with asyncio.timeout(15):
            message = None
            while message is None:
                message = await queue.get(fail=False)
                if message is None:
                    await asyncio.sleep(.05)
        assert message.body == receipt['runId'].encode()
        assert message.headers['x-first-death-reason'] == 'delivery_limit'
        await message.ack()
    assert 1 <= attempts.await_count <= 3 and not model.calls
    assert (await service.db.rows('SELECT status FROM document_runs'))[0]['status'] == 'pending'


def test_amqp_notice_inventory_matches_lock_and_exact_texts():
    import hashlib
    import json
    import tomllib
    from pathlib import Path

    root = Path(__file__).parents[1]
    packages = {item['name']: item['version'] for item in tomllib.loads((root / 'uv.lock').read_text())['package']}
    for package in json.loads((root / 'licenses/amqp/inventory.json').read_text()):
        assert packages[package['name']] == package['version']
        for notice in package['notices']:
            assert hashlib.sha256((root / 'licenses/amqp' / notice['file']).read_bytes()).hexdigest() == notice['sha256']


@pytest.mark.usefixtures('disposable_databases')
async def test_consumer_timeout_does_not_overlap_or_repeat_old_execution(monkeypatch):
    from langchain_core.runnables import RunnableLambda

    from tests.db_support import setup_api
    from tests.support import FakeModel

    original_declare = aio_pika.Channel.declare_queue
    async def declare(channel, name, **kwargs):
        if name == messaging.QUEUE:
            # Exercise the broker timeout with an intentionally short test-only limit.
            kwargs['arguments'] = {**kwargs['arguments'], 'x-consumer-timeout': 60_000}
        return await original_declare(channel, name, **kwargs)
    monkeypatch.setattr(aio_pika.Channel, 'declare_queue', declare)
    service, reference, model = await setup_api(monkeypatch)
    entered, release = asyncio.Event(), asyncio.Event()
    original_output = FakeModel.with_structured_output
    def output(self, schema, **kwargs):
        runner = original_output(self, schema, **kwargs)
        async def invoke(messages):
            entered.set()
            await release.wait()
            return await runner.ainvoke(messages)
        return RunnableLambda(invoke)
    monkeypatch.setattr(FakeModel, 'with_structured_output', output)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await asyncio.wait_for(entered.wait(), 10)
    try:
        async with asyncio.timeout(140):
            while service.delivery.connected:
                await asyncio.sleep(.1)
        assert len(service.active) == 1 and not model.calls
        assert (await service.db.rows('SELECT status FROM document_runs'))[0]['status'] == 'running'
    finally:
        release.set()
    await service.wait_idle()
    async with asyncio.timeout(10):
        while not await service.ready():
            await asyncio.sleep(.05)
    assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
    assert len(model.calls) == 1


@pytest.mark.usefixtures('disposable_databases')
async def test_cancelled_delivery_handler_cannot_release_execution_capacity(monkeypatch):
    from langchain_core.runnables import RunnableLambda

    from tests.db_support import setup_api
    from tests.support import FakeModel

    monkeypatch.setenv('N_JOBS_PER_WORKER', '1')
    service, reference, model = await setup_api(monkeypatch, [parsed(), parsed('second')])
    monkeypatch.setattr(messaging, 'publish', AsyncMock())
    entered, second_entered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original = FakeModel.with_structured_output
    starts = []
    def output(self, schema, **kwargs):
        runner = original(self, schema, **kwargs)
        async def invoke(messages):
            starts.append(1)
            (entered if len(starts) == 1 else second_entered).set()
            await release.wait()
            return await runner.ainvoke(messages)
        return RunnableLambda(invoke)
    monkeypatch.setattr(FakeModel, 'with_structured_output', output)
    first = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    message = wire(first['runId'].encode())
    message.ack = AsyncMock()
    handler = asyncio.create_task(service.delivery.consume(message))
    await asyncio.wait_for(entered.wait(), 10)
    handler.cancel()
    await asyncio.gather(handler, return_exceptions=True)
    second = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    message = wire(second['runId'].encode())
    message.ack = AsyncMock()
    next_delivery = asyncio.create_task(service.delivery.consume(message))
    try:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(second_entered.wait(), 3)
        assert len(starts) == 1
    finally:
        release.set()
        await next_delivery
    await service.wait_idle()
    for receipt in (first, second):
        assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
    assert len(model.calls) == 2


@pytest.mark.usefixtures('disposable_databases')
async def test_shutdown_during_delivery_admission_does_not_start_execution(monkeypatch):
    from contextlib import asynccontextmanager

    from tests.db_support import setup_api

    service, reference, model = await setup_api(monkeypatch)
    monkeypatch.setattr(messaging, 'publish', AsyncMock())
    admitted, release = asyncio.Event(), asyncio.Event()
    original = service.db.transaction
    @asynccontextmanager
    async def transaction():
        async with original() as conn:
            yield conn
        current = asyncio.current_task()
        if current is not None and current.get_name() == 'admission-probe':
            admitted.set()
            await release.wait()
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    monkeypatch.setattr(service.db, 'transaction', transaction)
    delivery = asyncio.create_task(service.deliver(receipt['runId']), name='admission-probe')
    await asyncio.wait_for(admitted.wait(), 10)
    try:
        service.stopping = True
        service.stop_event.set()
        service.wake.set()
        release.set()
        assert await delivery is False
        assert not service.active and not model.calls
    finally:
        release.set()


@pytest.mark.usefixtures('disposable_databases')
async def test_execution_cancelled_before_first_step_is_redelivered_without_stale_active_entry(monkeypatch):
    from tests.db_support import setup_api

    service, reference, model = await setup_api(monkeypatch)
    original = asyncio.create_task
    cancelled = []
    def create_task(coro, **kwargs):
        task = original(coro, **kwargs)
        if kwargs.get('name', '').startswith('document-') and not cancelled:
            cancelled.append(1)
            task.cancel()
        return task
    monkeypatch.setattr(asyncio, 'create_task', create_task)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    assert cancelled and not service.active
    assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
    assert len(model.calls) == 1


@pytest.mark.usefixtures('disposable_databases')
async def test_queued_pause_stops_without_broker_and_requires_explicit_resume(monkeypatch):
    from practiq_ai.contracts import DocumentTaskControl
    from tests.db_support import setup_api

    service, reference, model = await setup_api(monkeypatch)
    original = messaging.publish
    monkeypatch.setattr(messaging, 'publish', AsyncMock(side_effect=ConnectionError('offline')))
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    request = DocumentTaskControl(requestId=uuid4(), action='pause', runId=receipt['runId'])
    response = await task_api.control_task(receipt['threadId'], request)
    assert await task_api.control_task(receipt['threadId'], request) == response
    await service.wait_idle()
    detail = await task_api.get_task(receipt['threadId'])
    assert detail['state'] == 'PAUSED' and not model.calls
    monkeypatch.setattr(messaging, 'publish', original)
    async with asyncio.timeout(10):
        while not (await service.db.rows('SELECT published_at FROM document_outbox'))[0]['published_at']:
            await asyncio.sleep(.05)
    assert not model.calls
    await task_api.control_task(receipt['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=detail['checkpointId']))
    await service.wait_idle()
    assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
    assert len(model.calls) == 1


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('review', [False, True])
async def test_resume_queued_pause_preserves_selected_retry_input_or_review_command(monkeypatch, review):
    from practiq_ai.contracts import DocumentTaskControl, FailedUnit
    from practiq_ai.graphs import document
    from tests.db_support import setup_api

    original_chunk = document._chunk
    failed = True
    async def chunk(state, runtime):
        if failed:
            return {'chunkResults': [{'index': state['index'], 'parsed': None, 'failureCode': 'OUTPUT_INVALID'}], 'usage': []}
        return await original_chunk(state, runtime)
    monkeypatch.setattr(document, '_chunk', chunk)
    service, reference, model = await setup_api(monkeypatch, [parsed('recovered')], parts=['a', 'b'])
    first = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference),
                                                        failurePolicy='review' if review else 'return_partial'))
    await service.wait_idle()
    before = await task_api.get_task(first['threadId'])
    original_publish = messaging.publish
    monkeypatch.setattr(messaging, 'publish', AsyncMock())
    retry = DocumentTaskControl(requestId=uuid4(), action='retry_failed', checkpointId=before['checkpointId'],
                                units=[FailedUnit(stage='document_parse', index=0)])
    queued = await task_api.control_task(first['threadId'], retry)
    await task_api.control_task(first['threadId'], DocumentTaskControl(requestId=uuid4(), action='pause', runId=queued['runId']))
    await service.wait_idle()
    paused = await task_api.get_task(first['threadId'])
    assert paused['state'] == 'PAUSED' and 'resume' in paused['allowedActions']
    failed = False
    monkeypatch.setattr(messaging, 'publish', original_publish)
    await task_api.control_task(first['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=paused['checkpointId']))
    await service.wait_idle()
    after = await task_api.get_task(first['threadId'])
    assert after['state'] == ('WAITING_REVIEW' if review else 'COMPLETED')
    assert [item['index'] for item in after['failures']] == [1]
    assert len(model.calls) == 1
    assert await task_api.control_task(first['threadId'], retry) == queued


@pytest.mark.usefixtures('disposable_databases')
async def test_restricted_service_identity_can_declare_publish_and_consume(monkeypatch):
    import os
    from urllib.parse import urlsplit, urlunsplit

    from aiormq.exceptions import ChannelAccessRefused

    from tests.db_support import new_database
    from tests.mq_support import api

    await new_database()
    uri = urlsplit(os.environ['RABBITMQ_URI'])
    name = 'practiq_service_' + uuid4().hex
    vhost = uri.path.lstrip('/')
    pattern = r'^practiq[.]document[.]v1([.]dead|[.]dlx)?$'
    await asyncio.to_thread(api, 'PUT', '/api/users/' + name, {'password': 'test-broker-only', 'tags': ''})
    try:
        await asyncio.to_thread(api, 'PUT', f'/api/permissions/{vhost}/{name}',
                                {'configure': pattern, 'write': pattern + r'|^amq[.]default$', 'read': pattern})
        netloc = f'{name}:test-broker-only@{uri.hostname}:{uri.port}'
        connection = await aio_pika.connect(urlunsplit((uri.scheme, netloc, uri.path, '', '')))
        async with connection:
            channel = await connection.channel(on_return_raises=True)
            queue = await messaging.topology(channel)
            run_id = str(uuid4())
            await messaging.publish(channel, run_id)
            message = await queue.get(timeout=5)
            assert message is not None and messaging.decode(message) == run_id
            await message.ack()
            with pytest.raises(ChannelAccessRefused):
                await channel.declare_queue('unrelated', durable=True)
    finally:
        await asyncio.to_thread(api, 'DELETE', '/api/users/' + name)
