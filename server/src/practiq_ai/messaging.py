"""AMQP delivery of committed runs; PostgreSQL owns execution and receipts."""

import asyncio
import logging
import ssl
from math import ceil
from typing import Literal
from uuid import UUID

import aio_pika
from aio_pika.abc import AbstractChannel, AbstractIncomingMessage
from pamqp.commands import Basic
from psycopg import Error as DatabaseError

from . import telemetry
from .config import load, rabbitmq_uris
from .errors import DocumentProcessingError

QUEUE = 'practiq.document.v1'
DEAD_QUEUE = QUEUE + '.dead'
DEAD_EXCHANGE = QUEUE + '.dlx'
VERSION_HEADER = 'practiq-version'
PUBLISH_TIMEOUT = 5
DISPATCH_SQL = """
SELECT o.run_id,o.created_at FROM document_outbox o
JOIN document_runs r USING(run_id) JOIN document_tasks t USING(thread_id)
WHERE o.published_at IS NULL ORDER BY o.created_at,o.run_id LIMIT %s
"""


def failure(exc: Exception, role: Literal['publisher', 'consumer'], stage: str, run_id: str | None = None):
    # Exception strings and broker URLs can contain credentials; classify only known types/codes.
    if isinstance(exc, ssl.SSLError) or isinstance(exc.__cause__, ssl.SSLError):
        reason = 'tls'
    elif isinstance(exc, (aio_pika.exceptions.AuthenticationError, aio_pika.exceptions.ProbableAuthenticationError)):
        reason = 'authentication'
    elif getattr(exc, 'reply_code', None) in {403, 530} or (exc.args and exc.args[0] in (403, 530)):
        reason = 'permission'
    elif isinstance(exc, aio_pika.exceptions.ChannelPreconditionFailed):
        reason = 'topology_conflict'
    elif isinstance(exc, aio_pika.exceptions.ChannelNotFoundEntity):
        reason = 'not_found'
    elif isinstance(exc, TimeoutError):
        reason = 'timeout'
    elif isinstance(exc, aio_pika.exceptions.DeliveryError):
        reason = 'publish_rejected'
    elif isinstance(exc, (ConnectionError, aio_pika.exceptions.AMQPConnectionError,
                          aio_pika.exceptions.ChannelClosed, aio_pika.exceptions.ChannelInvalidStateError)):
        reason = 'connection_lost'
    else:
        reason = 'unexpected'
    telemetry.broker_failures.labels(role, stage, reason).inc()
    telemetry.event('broker_failure', errorCode='BROKER_UNAVAILABLE', role=role, stage=stage, reason=reason, runId=run_id)


def decode(message: AbstractIncomingMessage) -> str:
    if (len(message.body) != 36 or message.content_type != 'text/plain'
            or type(message.headers.get(VERSION_HEADER)) is not int
            or message.headers[VERSION_HEADER] != 1):
        raise ValueError('Invalid run delivery protocol')
    run_id = message.body.decode('ascii')
    if str(UUID(run_id)) != run_id:
        raise ValueError('Invalid run identifier')
    return run_id


async def topology(channel: AbstractChannel):
    dead = await channel.declare_exchange(DEAD_EXCHANGE, aio_pika.ExchangeType.DIRECT, durable=True)
    dlq = await channel.declare_queue(DEAD_QUEUE, durable=True, arguments={
        'x-queue-type': 'quorum', 'x-overflow': 'reject-publish', 'x-delivery-limit': -1,
    })
    await dlq.bind(dead, routing_key=DEAD_QUEUE)
    # At-least-once dead lettering retains poison messages until the DLQ confirms.
    queue = await channel.declare_queue(QUEUE, durable=True, arguments={
        'x-queue-type': 'quorum', 'x-delivery-limit': 20,
        'x-delayed-retry-type': 'failed', 'x-delayed-retry-min': 1000, 'x-delayed-retry-max': 30_000,
        'x-dead-letter-exchange': DEAD_EXCHANGE, 'x-dead-letter-routing-key': DEAD_QUEUE,
        'x-dead-letter-strategy': 'at-least-once', 'x-overflow': 'reject-publish',
        'x-consumer-timeout': max(300_000, ceil(load().run_timeout_seconds * 1000) + 300_000),
    })
    await channel.set_qos(prefetch_count=load().jobs_per_worker)
    return queue


async def publish(channel: AbstractChannel, run_id: str):
    confirmation = await channel.default_exchange.publish(aio_pika.Message(
        run_id.encode('ascii'), content_type='text/plain', headers={VERSION_HEADER: 1},
        delivery_mode=aio_pika.DeliveryMode.PERSISTENT, message_id=run_id,
    ), routing_key=QUEUE, mandatory=True, timeout=PUBLISH_TIMEOUT)
    if not isinstance(confirmation, Basic.Ack):
        raise TypeError('Publication was not confirmed')


class Delivery:
    def __init__(self, service):
        self.service = service
        self.publisher_connected = False
        self.consumer_connected = False
        self.failed = asyncio.Event()
        self.wake = asyncio.Event()
        self.handlers: set[asyncio.Task] = set()

    @property
    def connected(self) -> bool:
        return self.publisher_connected and self.consumer_connected

    async def consume(self, message: AbstractIncomingMessage):
        task = asyncio.current_task()
        assert task is not None
        self.handlers.add(task)
        run_id = None
        stage = 'execute'
        try:
            try:
                run_id = decode(message)
            except (ValueError, UnicodeError):
                telemetry.deliveries.labels('poison').inc()
                telemetry.event('delivery_rejected', errorCode='MESSAGE_PROTOCOL_INVALID')
                await message.reject(requeue=False)
                return
            if await self.service.deliver(run_id):
                # Completion or deferred outbox admission is committed first; ambiguous ACKs are safe.
                stage = 'ack'
                await message.ack()
                telemetry.deliveries.labels('acknowledged').inc()
        except DatabaseError:
            self.service.accepting = False
            self.service.fatal(70)
        except DocumentProcessingError:
            telemetry.deliveries.labels('unsupported').inc()
            telemetry.event('delivery_rejected', errorCode='TASK_FORMAT_UNSUPPORTED', runId=run_id)
            await message.reject(requeue=False)
        except asyncio.CancelledError:
            self.failed.set()
            raise
        except Exception as exc:  # noqa: BLE001 - never log broker credentials or message bytes
            telemetry.deliveries.labels('infrastructure_failed').inc()
            failure(exc, 'consumer', stage, run_id)
            self.failed.set()
        finally:
            self.handlers.discard(task)

    async def run(self):
        # Client connection exceptions can embed the URL; suppress third-party logs.
        for name in ('aio_pika', 'aiormq'):
            logging.getLogger(name).setLevel(logging.CRITICAL)
        while load().read_only and not self.service.stopping:
            self.wake.clear()
            await self.wait(1)
        if self.service.stopping:
            return
        async with asyncio.TaskGroup() as group:
            group.create_task(self.publishing(), name='document-publisher')
            group.create_task(self.listening(), name='document-consumer')

    async def publishing(self):
        delay = 1
        endpoints, endpoint = rabbitmq_uris(), 0
        while not self.service.stopping:
            connection = None
            stage, run_id = 'connect', None
            try:
                self.wake.clear()
                connection = await aio_pika.connect(endpoints[endpoint], timeout=5, client_properties={'connection_name': 'practiq-publisher'})
                publisher = await connection.channel(publisher_confirms=True, on_return_raises=True)
                stage = 'topology'
                await topology(publisher)
                self.publisher_connected = True
                while not self.service.stopping:
                    self.wake.clear()
                    stage, run_id = 'outbox', None
                    if connection.is_closed or publisher.is_closed:
                        raise ConnectionError('Publisher connection lost')
                    queued = await publisher.declare_queue(QUEUE, durable=True, passive=True, timeout=5)
                    # Retained dead-letter receipts are not live broker backlog.
                    ready = queued.declaration_result.message_count
                    if type(ready) is not int or ready < 0:
                        raise TypeError('Broker queue depth unavailable')
                    capacity = max(0, load().jobs_per_worker - len(self.service.active) - ready)
                    rows = await self.service.db.rows(DISPATCH_SQL, (capacity,))
                    if rows:
                        async with self.service.db.connection() as conn:
                            for row in rows:
                                if self.service.stopping:
                                    break
                                stage, run_id = 'publish', row['run_id']
                                await publish(publisher, run_id)
                                stage = 'outbox'
                                await conn.execute('UPDATE document_outbox SET published_at=now() WHERE run_id=%s AND created_at=%s', (row['run_id'], row['created_at']))
                    delay = 1
                    if not capacity or len(rows) < capacity:
                        await self.wait(1)
            except asyncio.CancelledError:
                raise
            except DatabaseError:
                self.service.accepting = False
                self.service.fatal(70)
                return
            except Exception as exc:  # noqa: BLE001 - retry unknown confirms without exposing URLs
                failure(exc, 'publisher', stage, run_id)
            finally:
                self.publisher_connected = False
                await self.close(connection, 'publisher')
            endpoint = (endpoint + 1) % len(endpoints)
            delay = await self.backoff(delay)

    async def listening(self):
        delay = 1
        endpoints, endpoint = rabbitmq_uris(), 0
        while not self.service.stopping:
            connection = None
            stage = 'connect'
            try:
                connection = await aio_pika.connect(endpoints[endpoint], timeout=5, client_properties={'connection_name': 'practiq-consumer'})
                consumer = await connection.channel()
                stage = 'topology'
                queue = await topology(consumer)
                self.failed.clear()
                underlay = await consumer.get_underlay_channel()
                # RabbitMQ 4.3 may cancel a timed-out consumer without closing its channel.
                underlay.on_consumer_cancel_callbacks.add(lambda _frame: self.failed.set())
                stage = 'subscribe'
                tag = await queue.consume(self.consume, no_ack=False)
                self.consumer_connected = True
                stage = 'consume'
                while not self.service.stopping:
                    if connection.is_closed or consumer.is_closed or self.failed.is_set():
                        raise ConnectionError('Consumer connection lost')
                    try:
                        await asyncio.wait_for(self.failed.wait(), timeout=1)
                    except TimeoutError:
                        delay = 1
                stage = 'cancel'
                await queue.cancel(tag, timeout=5)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - reconnect without exposing broker credentials
                failure(exc, 'consumer', stage)
            finally:
                self.consumer_connected = False
                await self.close(connection, 'consumer')
            # Old executions keep ownership and finish before another subscription.
            while pending := {*self.handlers, *self.service.active.values()}:
                await asyncio.gather(*pending, return_exceptions=True)
            endpoint = (endpoint + 1) % len(endpoints)
            delay = await self.backoff(delay)

    async def close(self, connection, role: Literal['publisher', 'consumer']):
        if connection is not None:
            try:
                await connection.close()
            except Exception as exc:  # noqa: BLE001 - cleanup failure must not prevent recovery
                failure(exc, role, 'close')

    async def backoff(self, delay):
        if not self.service.stopping:
            try:
                await asyncio.wait_for(self.service.stop_event.wait(), timeout=delay)
            except TimeoutError:
                pass
        return min(delay * 2, 30)

    async def wait(self, seconds):
        try:
            await asyncio.wait_for(self.wake.wait(), timeout=seconds)
        except TimeoutError:
            pass
