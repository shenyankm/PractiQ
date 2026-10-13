"""AMQP delivery of committed runs; PostgreSQL owns execution and receipts."""

import asyncio
import logging
from math import ceil
from uuid import UUID

import aio_pika
from aio_pika.abc import AbstractChannel, AbstractIncomingMessage
from pamqp.commands import Basic
from psycopg import Error as DatabaseError

from . import telemetry
from .config import load, rabbitmq_uri
from .errors import DocumentProcessingError
from .execution import supported_task_sql

QUEUE = 'practiq.document.v1'
DEAD_QUEUE = QUEUE + '.dead'
DEAD_EXCHANGE = QUEUE + '.dlx'
VERSION_HEADER = 'practiq-version'
PUBLISH_TIMEOUT = 5


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
        self.connected = False
        self.failed = asyncio.Event()
        self.handlers: set[asyncio.Task] = set()

    async def consume(self, message: AbstractIncomingMessage):
        task = asyncio.current_task()
        assert task is not None
        self.handlers.add(task)
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
                await message.ack()
                telemetry.deliveries.labels('acknowledged').inc()
        except DatabaseError:
            self.service.accepting = False
            self.service.fatal(70)
        except DocumentProcessingError:
            telemetry.deliveries.labels('unsupported').inc()
            telemetry.event('delivery_rejected', errorCode='TASK_FORMAT_UNSUPPORTED')
            await message.reject(requeue=False)
        except asyncio.CancelledError:
            self.failed.set()
            raise
        except Exception:  # noqa: BLE001 - never log broker credentials or message bytes
            telemetry.deliveries.labels('infrastructure_failed').inc()
            telemetry.event('delivery_failed', errorCode='MESSAGE_INFRASTRUCTURE_FAILED')
            self.failed.set()
        finally:
            self.handlers.discard(task)

    async def run(self):
        # Client connection exceptions can embed the URL; suppress third-party logs.
        for name in ('aio_pika', 'aiormq'):
            logging.getLogger(name).setLevel(logging.CRITICAL)
        delay = 1
        while not self.service.stopping:
            connection = None
            try:
                if load().read_only:
                    await self.wait(1)
                    continue
                connection = await aio_pika.connect(rabbitmq_uri(), timeout=5)
                publisher = await connection.channel(publisher_confirms=True, on_return_raises=True)
                consumer = await connection.channel()
                queue = await topology(consumer)
                self.failed.clear()
                underlay = await consumer.get_underlay_channel()
                # RabbitMQ 4.3 may cancel a timed-out consumer without closing its channel.
                underlay.on_consumer_cancel_callbacks.add(lambda _frame: self.failed.set())
                tag = await queue.consume(self.consume, no_ack=False)
                self.connected = True
                while not self.service.stopping:
                    if connection.is_closed or consumer.is_closed or self.failed.is_set():
                        raise RuntimeError('Delivery connection lost')
                    rows = await self.service.db.rows(
                        "SELECT o.run_id,o.created_at FROM document_outbox o JOIN document_runs r USING(run_id) JOIN document_tasks t USING(thread_id) "
                        "WHERE o.published_at IS NULL AND (t.account_id IS NULL OR r.status NOT IN ('pending','running') OR NOT EXISTS ("
                        "SELECT 1 FROM document_runs other JOIN document_tasks other_task ON other_task.thread_id=other.thread_id "
                        "WHERE other_task.account_id=t.account_id AND other.run_id!=r.run_id AND other.status IN ('pending','running') AND "
                        f"{supported_task_sql('other_task')} AND (other.status='running' OR (other.created_at,other.run_id)<(r.created_at,r.run_id) OR "
                        "EXISTS(SELECT 1 FROM document_outbox published WHERE published.run_id=other.run_id AND published.published_at IS NOT NULL)))) "
                        "ORDER BY o.created_at LIMIT 100")
                    for row in rows:
                        if self.service.stopping:
                            break
                        await publish(publisher, row['run_id'])
                        async with self.service.db.connection() as conn:
                            await conn.execute('UPDATE document_outbox SET published_at=now() WHERE run_id=%s AND created_at=%s', (row['run_id'], row['created_at']))
                    delay = 1
                    await self.wait(1)
                await queue.cancel(tag, timeout=5)
            except asyncio.CancelledError:
                raise
            except DatabaseError:
                self.service.accepting = False
                self.service.fatal(70)
                return
            except Exception:  # noqa: BLE001 - retry unknown confirms without exposing URLs
                telemetry.event('broker_unavailable', errorCode='BROKER_UNAVAILABLE')
            finally:
                self.connected = False
                if connection is not None:
                    try:
                        await connection.close()
                    except Exception:  # noqa: BLE001 - cleanup failure must not prevent recovery
                        telemetry.event('broker_close_failed', errorCode='BROKER_UNAVAILABLE')
            # Old executions keep ownership and finish before another subscription.
            while pending := {*self.handlers, *self.service.active.values()}:
                await asyncio.gather(*pending, return_exceptions=True)
            if not self.service.stopping:
                try:
                    await asyncio.wait_for(self.service.stop_event.wait(), timeout=delay)
                except TimeoutError:
                    pass
                delay = min(delay * 2, 30)

    async def wait(self, seconds):
        try:
            await asyncio.wait_for(self.service.wake.wait(), timeout=seconds)
        except TimeoutError:
            pass
        self.service.wake.clear()
