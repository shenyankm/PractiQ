"""Subprocess-only fault injection; never imported by the shipped application."""
import asyncio
import os
from pathlib import Path

from practiq_ai import llm, messaging, runtime
from practiq_ai.graphs import document
from tests.support import FakeModel, question
from tests.tencent_service import app

root = Path(os.environ['TEST_EVENTS'])
root.mkdir(exist_ok=True)
phase = os.environ.get('TEST_PHASE', '')
# A publish-window kill can happen before execution reaches its own pause.
published_restart = (root / 'published').exists()


async def block_once(name):
    if phase != name:
        return
    marker = root / name
    try:
        with marker.open('x') as handle:
            handle.write('reached')
    except FileExistsError:
        return
    await asyncio.Event().wait()


def response(messages, schema):
    with (root / 'calls').open('a') as handle:
        handle.write('call\n')
    return {'questions': [question('First')], 'groups': []}


class Model(FakeModel):
    def with_structured_output(self, schema, **kwargs):
        runner = super().with_structured_output(schema, **kwargs)
        from langchain_core.runnables import RunnableLambda
        async def invoke(messages):
            # The application has already persisted the started/unknown call record.
            await block_once('model')
            result = await runner.ainvoke(messages)
            # Provider completed, but neither its response nor usage reached the caller.
            await block_once("provider_completed")
            return result
        return RunnableLambda(invoke)


model = Model(responses=[response] * 100)
document.get_model = lambda *_: model
original_execute = runtime.Service.execute
original_finish = runtime.Service.finish
original_gate = document._gate


async def execute(self, run):
    if phase == 'published' and not published_restart:
        await asyncio.Event().wait()
    if run['command']:
        await block_once('review_before')
    else:
        await block_once('queued')
    return await original_execute(self, run)


async def finish(self, run_id, status, error=None):
    if status == 'success':
        await block_once('completed')
    result = await original_finish(self, run_id, status, error)
    if status == 'success':
        await block_once('result_saved')
    return result


async def gate(state, *, phase):
    if phase == 'completed':
        await block_once('review_after')
        await block_once('model_saved')
    return await original_gate(state, phase=phase)


runtime.Service.execute = execute
runtime.Service.finish = finish
document._gate = gate
__all__ = ['app']

original_publish = messaging.publish

async def publish(channel, run_id):
    await block_once('outbox_committed')
    await original_publish(channel, run_id)
    await block_once('published')

messaging.publish = publish

original_store_put = llm.store_put

async def store_put(runtime, kind, key, value):
    await original_store_put(runtime, kind, key, value)
    if kind == 'model_results':
        await block_once('model_receipt')

llm.store_put = store_put
