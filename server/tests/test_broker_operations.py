"""Broker fault isolation and production deployment boundaries."""

import asyncio
import json
import os
import ssl
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import aio_pika
import httpx
import pytest
import yaml
from pamqp.commands import Basic
from prometheus_client.parser import text_string_to_metric_families

from practiq_ai import messaging, runtime, task_api, telemetry
from practiq_ai.config import rabbitmq_uris
from practiq_ai.contracts import DocumentReference, DocumentTaskCreate


@pytest.mark.usefixtures('disposable_databases')
async def test_publisher_failure_does_not_close_consumer_or_lose_its_ack(monkeypatch):
    from tests.db_support import setup_api
    from tests.support import parsed

    entered, release, failed, acknowledged = (asyncio.Event() for _ in range(4))
    original_execute, original_ack = runtime.Service.execute, aio_pika.IncomingMessage.ack

    async def execute(self, run):
        entered.set()
        await release.wait()
        await original_execute(self, run)

    async def ack(message, *args, **kwargs):
        await original_ack(message, *args, **kwargs)
        acknowledged.set()

    async def unavailable(*args):
        failed.set()
        raise TimeoutError('confirmation unknown')

    monkeypatch.setattr(runtime.Service, 'execute', execute)
    monkeypatch.setattr(aio_pika.IncomingMessage, 'ack', ack)
    service, reference, model = await setup_api(monkeypatch, [parsed(), parsed('second')])
    def request():
        return DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference))
    first = await task_api.create_task(request())
    await asyncio.wait_for(entered.wait(), 10)
    publish = messaging.publish
    monkeypatch.setattr(messaging, 'publish', unavailable)
    second = await task_api.create_task(request())
    await asyncio.wait_for(failed.wait(), 10)
    try:
        release.set()
        await asyncio.wait_for(acknowledged.wait(), 5)
        assert (await task_api.get_task(first['threadId']))['state'] == 'COMPLETED'
        assert (await service.db.rows('SELECT published_at FROM document_outbox WHERE run_id=%s', (second['runId'],)))[0]['published_at'] is None
        assert len(model.calls) == 1
    finally:
        release.set()
        monkeypatch.setattr(messaging, 'publish', publish)
    async with asyncio.timeout(40):
        while not await service.ready():
            await asyncio.sleep(.05)
    await service.wait_idle()
    assert len(model.calls) == 2


@pytest.mark.parametrize('exc,reason', [
    (ssl.SSLError('secret'), 'tls'),
    (aio_pika.exceptions.AuthenticationError('secret'), 'authentication'),
    (aio_pika.exceptions.ChannelClosed(403, 'secret'), 'permission'),
    (aio_pika.exceptions.ChannelPreconditionFailed('secret'), 'topology_conflict'),
    (aio_pika.exceptions.ChannelNotFoundEntity('secret'), 'not_found'),
    (TimeoutError('secret'), 'timeout'),
    (aio_pika.exceptions.DeliveryError(None, Basic.Nack()), 'publish_rejected'),
    (ConnectionError('secret'), 'connection_lost'),
    (RuntimeError('secret'), 'unexpected'),
])
def test_broker_failure_logs_only_sanitized_reason_and_verified_identity(exc, reason):
    run_id = str(uuid4())
    with telemetry.capture_events() as events:
        messaging.failure(exc, 'publisher', 'publish', run_id)
    assert events[0]['role'] == 'publisher' and events[0]['stage'] == 'publish'
    assert events[0]['reason'] == reason and events[0]['runId'] == run_id
    assert 'secret' not in json.dumps(events)


def test_wrapped_tls_error_remains_diagnosable_without_logging_its_message():
    error = aio_pika.exceptions.AMQPConnectionError('secret')
    error.__cause__ = ssl.SSLCertVerificationError('secret')
    with telemetry.capture_events() as events:
        messaging.failure(error, 'consumer', 'connect')
    assert events[0]['reason'] == 'tls' and 'secret' not in json.dumps(events)


async def test_read_only_control_wake_is_consumed_without_connecting(monkeypatch):
    service = SimpleNamespace(stopping=False)
    delivery = messaging.Delivery(service)
    delivery.wake.set()
    waits = []

    async def wait(seconds):
        assert not delivery.wake.is_set()
        waits.append(seconds)
        delivery.wake.set()
        service.stopping = len(waits) == 2

    monkeypatch.setattr(messaging, 'load', lambda: SimpleNamespace(read_only=True))
    monkeypatch.setattr(delivery, 'wait', wait)
    await delivery.run()
    assert waits == [1, 1] and not delivery.connected


async def broker_metrics(detailed=False):
    from tests import mq_support
    if not mq_support.PROMETHEUS:
        pytest.skip('External test broker requires TEST_RABBITMQ_PROMETHEUS_URL')
    params = {'family': ['queue_coarse_metrics', 'queue_consumer_count']} if detailed else None
    async with httpx.AsyncClient(trust_env=False) as client:
        response = await client.get(mq_support.PROMETHEUS + ('/metrics/detailed' if detailed else '/metrics'), params=params)
        response.raise_for_status()
    return [sample for family in text_string_to_metric_families(response.text) for sample in family.samples]


@pytest.mark.usefixtures('disposable_databases')
async def test_memory_alarm_keeps_consumer_ack_and_outbox_recovers(monkeypatch):
    from tests import mq_support
    from tests.db_support import setup_api
    from tests.support import parsed

    entered, release, acknowledged = (asyncio.Event() for _ in range(3))
    original_execute, original_ack = runtime.Service.execute, aio_pika.IncomingMessage.ack

    async def execute(self, run):
        entered.set()
        await release.wait()
        await original_execute(self, run)

    async def ack(message, *args, **kwargs):
        await original_ack(message, *args, **kwargs)
        acknowledged.set()

    monkeypatch.setattr(runtime.Service, 'execute', execute)
    monkeypatch.setattr(aio_pika.IncomingMessage, 'ack', ack)
    service, reference, model = await setup_api(monkeypatch, [parsed(), parsed('second')])
    container = mq_support.CONTAINER or os.environ.get('TEST_RABBITMQ_CONTAINER')
    if not container:
        pytest.skip('Resource alarm requires the isolated TEST_RABBITMQ_CONTAINER')
    async with asyncio.timeout(15):
        limit = None
        while limit is None:
            limit = next((int(sample.value) for sample in await broker_metrics() if sample.name == 'rabbitmq_resident_memory_limit_bytes'), None)
            if limit is None:
                await asyncio.sleep(.1)

    async def watermark(*args):
        await asyncio.to_thread(subprocess.run, ['docker', 'exec', container, 'rabbitmqctl', 'set_vm_memory_high_watermark', *args],
                                check=True, capture_output=True, timeout=20)

    def request():
        return DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference))

    first = await task_api.create_task(request())
    await asyncio.wait_for(entered.wait(), 10)
    async with asyncio.timeout(10):
        while not (await service.db.rows('SELECT published_at FROM document_outbox WHERE run_id=%s', (first['runId'],)))[0]['published_at']:
            await asyncio.sleep(.05)
    try:
        await watermark('0')
        async with asyncio.timeout(15):
            while not any(sample.name == 'rabbitmq_alarms_memory_used_watermark' and sample.value == 1 for sample in await broker_metrics()):
                await asyncio.sleep(.1)
        second = await task_api.create_task(request())
        async with asyncio.timeout(15):
            while service.delivery.publisher_connected:
                await asyncio.sleep(.05)
        assert service.delivery.consumer_connected
        release.set()
        await asyncio.wait_for(acknowledged.wait(), 5)
        assert (await task_api.get_task(first['threadId']))['state'] == 'COMPLETED'
        assert (await service.db.rows('SELECT published_at FROM document_outbox WHERE run_id=%s', (second['runId'],)))[0]['published_at'] is None
        assert len(model.calls) == 1
    finally:
        release.set()
        await watermark('absolute', str(limit))
    async with asyncio.timeout(40):
        while not await service.ready():
            await asyncio.sleep(.1)
    await service.wait_idle()
    assert len(model.calls) == 2


@pytest.mark.usefixtures('disposable_databases')
async def test_capacity_policy_rejects_publish_and_full_dlq_retains_dead_letters():
    from urllib.parse import urlsplit

    from tests import mq_support
    from tests.db_support import new_database
    from tests.mq_support import api

    await new_database()
    container = mq_support.CONTAINER or os.environ.get('TEST_RABBITMQ_CONTAINER')
    if not container:
        pytest.skip('Durable DLQ recovery requires the isolated TEST_RABBITMQ_CONTAINER')
    vhost = urlsplit(os.environ['RABBITMQ_URI']).path.lstrip('/')
    policies = json.loads((Path(__file__).parents[1] / 'deploy/rabbitmq-policies.json').read_text())['policies']
    for policy, capacity in zip(policies, (2, 1), strict=True):
        body = {key: value for key, value in policy.items() if key not in {'name', 'vhost'}}
        body['definition']['max-length'] = capacity
        await asyncio.to_thread(api, 'PUT', f'/api/policies/{vhost}/{policy["name"]}', body)
    async with await aio_pika.connect(os.environ['RABBITMQ_URI']) as connection:
        channel = await connection.channel(on_return_raises=True)
        queue = await messaging.topology(channel)
        accepted_ids = []
        for _ in range(10):
            try:
                run_id = str(uuid4())
                await messaging.publish(channel, run_id)
                accepted_ids.append(run_id)
            except aio_pika.exceptions.DeliveryError:
                break
        # Quorum queues can accept a small in-flight overshoot before rejecting publishers.
        accepted = len(accepted_ids)
        assert 2 <= accepted < 10
        # Fill the target explicitly; neither queue must overshoot its configured capacity.
        filled_ids = []
        for _ in range(10):
            run_id = str(uuid4())
            try:
                confirmation = await channel.default_exchange.publish(aio_pika.Message(
                    run_id.encode('ascii'), content_type='text/plain', headers={messaging.VERSION_HEADER: 1},
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT, message_id=run_id,
                ), routing_key=messaging.DEAD_QUEUE, mandatory=True, timeout=5)
                assert isinstance(confirmation, Basic.Ack)
                filled_ids.append(run_id)
            except aio_pika.exceptions.DeliveryError:
                break
        assert 1 <= len(filled_ids) < 10
        for _ in range(accepted):
            message = await queue.get(timeout=5)
            assert message is not None
            await message.reject(requeue=False)
        # A broker restart verifies retained dead letters survive beyond the worker's retry timer.
        await asyncio.to_thread(subprocess.run, ['docker', 'restart', container], check=True, capture_output=True, timeout=60)
        async with asyncio.timeout(40):
            while True:
                try:
                    await asyncio.to_thread(api, 'GET', '/api/overview')
                    break
                except httpx.HTTPError:
                    await asyncio.sleep(.2)
        await asyncio.to_thread(api, 'DELETE', f'/api/policies/{vhost}/{policies[1]["name"]}')
        async with await aio_pika.connect(os.environ['RABBITMQ_URI']) as recovered:
            dlq = await (await recovered.channel()).get_queue(messaging.DEAD_QUEUE)
            seen = set()
            async with asyncio.timeout(40):
                while seen != set(accepted_ids + filled_ids):
                    message = await dlq.get(fail=False)
                    if message is None:
                        await asyncio.sleep(.1)
                    else:
                        seen.add(messaging.decode(message))
                        await message.ack()


def test_broker_deployment_preserves_data_and_bounds_resources():
    deploy = Path(__file__).parents[1] / 'deploy'
    config = yaml.safe_load((deploy / 'service.compose.yml').read_text())['services']['rabbitmq']
    assert config['mem_limit'] == '1536m' and config['cpus'] == 2
    assert config['ulimits']['nofile']['soft'] >= 50000
    assert 'rabbitmq-data:/var/lib/rabbitmq' in config['volumes']
    assert '127.0.0.1:15692:15692' in config['ports']
    assert 'vm_memory_high_watermark.absolute = 768MiB' in (deploy / 'rabbitmq.conf').read_text()
    for policy in json.loads((deploy / 'rabbitmq-policies.json').read_text())['policies']:
        assert policy['definition']['max-length'] > 0 and policy['definition']['max-length-bytes'] > 0
        assert policy['definition']['overflow'] == 'reject-publish'
        assert not {'message-ttl', 'expires'} & policy['definition'].keys()


@pytest.mark.parametrize('fallback', ['{}', 'null', '[false]', '[""]', '["amqp://host/practiq"]',
                                      '["amqps://user:secret@host/another"]', '["amqps://user:secret@host/practiq?x=1"]',
                                      '[1,2,3]', 'secret'])
def test_failover_endpoints_reject_invalid_or_different_vhosts_without_credentials(monkeypatch, fallback):
    monkeypatch.setenv('RABBITMQ_URI', 'amqp://user:secret@127.0.0.1/practiq')
    monkeypatch.setenv('RABBITMQ_FAILOVER_URIS', fallback)
    with pytest.raises(ValueError) as error:
        rabbitmq_uris()
    assert 'secret' not in str(error.value)


def test_failover_is_optional_and_preserves_endpoint_order(monkeypatch):
    primary = 'amqp://user:secret@127.0.0.1/practiq'
    secondary = 'amqps://user:secret@broker-2.example/practiq'
    monkeypatch.setenv('RABBITMQ_URI', primary)
    monkeypatch.delenv('RABBITMQ_FAILOVER_URIS', raising=False)
    assert rabbitmq_uris() == (primary,)
    monkeypatch.setenv('RABBITMQ_FAILOVER_URIS', json.dumps([secondary, primary]))
    assert rabbitmq_uris() == (primary, secondary)


@pytest.mark.usefixtures('disposable_databases')
async def test_passive_metrics_expose_connection_roles_pending_age_and_read_only(monkeypatch):
    from practiq_ai import webapp
    from tests.db_support import setup_api

    service, reference, model = await setup_api(monkeypatch)
    monkeypatch.setattr(messaging, 'publish', AsyncMock())
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    async with service.db.connection() as conn:
        await conn.execute("UPDATE document_runs SET created_at=now()-interval '31 minutes' WHERE run_id=%s", (receipt['runId'],))
    service.delivery.publisher_connected = False
    response = await webapp.application_metrics()
    samples = {sample.name: sample.value for family in text_string_to_metric_families(bytes(response.body).decode()) for sample in family.samples}
    assert samples['practiq_pending_oldest_seconds'] >= 1860
    assert samples['practiq_broker_connected'] == samples['practiq_broker_publisher_connected'] == 0
    assert samples['practiq_broker_consumer_connected'] == samples['practiq_broker_required'] == 1
    monkeypatch.setenv('AI_READ_ONLY', '1')
    assert b'practiq_broker_required 0\n' in (await webapp.application_metrics()).body
    assert not model.calls


@pytest.mark.usefixtures('disposable_databases')
async def test_three_node_quorum_survives_connected_leader_loss_without_repeating_models(monkeypatch):
    from tests import mq_support
    from tests.db_support import SERVICES, setup_api
    from tests.mq_cluster_support import cluster
    from tests.support import parsed

    deployment = cluster()
    instance = await asyncio.to_thread(deployment.__enter__)
    service = None
    entered, release = asyncio.Event(), asyncio.Event()
    try:
        vhost = 'practiq_cluster_test_' + uuid4().hex
        await asyncio.to_thread(instance.api, 'PUT', '/api/vhosts/' + vhost, {})
        await asyncio.to_thread(instance.api, 'PUT', f'/api/permissions/{vhost}/cluster-test',
                                {'configure': '.*', 'write': '.*', 'read': '.*'})
        endpoints = [await asyncio.to_thread(instance.uri, node, vhost) for node in range(1, 4)]
        async with await aio_pika.connect(endpoints[0]) as connection:
            await messaging.topology(await connection.channel())
        # Management statistics arrive asynchronously; choose the actual leader before connecting.
        async with asyncio.timeout(15):
            while True:
                queue = await asyncio.to_thread(instance.api, 'GET', f'/api/queues/{vhost}/{messaging.QUEUE}')
                if queue.get('node'):
                    break
                await asyncio.sleep(.1)
        assert len(queue['members']) == 3
        dead = await asyncio.to_thread(instance.api, 'GET', f'/api/queues/{vhost}/{messaging.DEAD_QUEUE}')
        assert len(dead['members']) == 3
        leader = [f'rabbit@practiq-rabbitmq-{node}' for node in range(1, 4)].index(queue['node'])
        endpoints = endpoints[leader:] + endpoints[:leader]
        monkeypatch.setattr(mq_support, 'new_vhost', lambda: endpoints[0])
        monkeypatch.setenv('RABBITMQ_FAILOVER_URIS', json.dumps(endpoints[1:]))
        original = runtime.Service.execute

        async def execute(self, run):
            entered.set()
            await release.wait()
            await original(self, run)

        monkeypatch.setattr(runtime.Service, 'execute', execute)
        service, reference, model = await setup_api(monkeypatch, [parsed(), parsed('second')])
        def request():
            return DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference))
        first = await task_api.create_task(request())
        await asyncio.wait_for(entered.wait(), 10)
        container = await asyncio.to_thread(instance.compose, 'ps', '--quiet', f'rabbitmq-{leader + 1}')
        await asyncio.to_thread(subprocess.run, ['docker', 'update', '--restart=no', container], check=True, capture_output=True, timeout=10)
        await asyncio.to_thread(subprocess.run, ['docker', 'kill', container], check=True, capture_output=True, timeout=10)
        async with asyncio.timeout(15):
            while service.delivery.consumer_connected:
                await asyncio.sleep(.05)
        second = await task_api.create_task(request())
        async with asyncio.timeout(40):
            while not (await service.db.rows('SELECT published_at FROM document_outbox WHERE run_id=%s', (second['runId'],)))[0]['published_at']:
                await asyncio.sleep(.1)
        assert service.delivery.publisher_connected and not service.delivery.consumer_connected
        assert not model.calls
        release.set()
        async with asyncio.timeout(40):
            while not await service.ready():
                await asyncio.sleep(.1)
        # Quorum disconnect grace (60s) plus delayed retry (up to 30s) can outlive transport readiness.
        try:
            async with asyncio.timeout(100):
                while await service.db.rows("SELECT run_id FROM document_runs WHERE status IN ('pending','running')") or service.active:
                    await asyncio.sleep(.05)
        except TimeoutError:
            states = await service.db.rows('SELECT run_id,status,error_code FROM document_runs')
            raise AssertionError({'runs': states, 'modelCalls': len(model.calls),
                                  'publisher': service.delivery.publisher_connected, 'consumer': service.delivery.consumer_connected}) from None
        assert len(model.calls) == 2
        for receipt in (first, second):
            assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
    finally:
        if service is not None:
            release.set()
            await service.stop(timeout=0)
            SERVICES.remove(service)
        await asyncio.to_thread(deployment.__exit__, None, None, None)
