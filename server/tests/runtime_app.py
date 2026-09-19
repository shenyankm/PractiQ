"""Subprocess-only fault injection; never imported by the shipped application."""
import asyncio
import os
from pathlib import Path

from practiq_ai import runtime
from practiq_ai.graphs import document
from practiq_ai.webapp import app
from tests.test_workflows import FakeModel, question

root = Path(os.environ['TEST_EVENTS'])
root.mkdir(exist_ok=True)
phase = os.environ.get('TEST_PHASE', '')


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
            return await runner.ainvoke(messages)
        return RunnableLambda(invoke)


model = Model(responses=[response] * 100)
document.get_model = lambda *_: model
original_execute = runtime.Service.execute
original_finish = runtime.Service.finish
original_gate = document._gate


async def execute(self, run):
    if run['command']:
        await block_once('review_before')
    else:
        await block_once('queued')
    return await original_execute(self, run)


async def finish(self, run_id, status, error=None):
    if status == 'success':
        await block_once('completed')
    return await original_finish(self, run_id, status, error)


async def gate(state, *, phase):
    if phase == 'completed':
        await block_once('review_after')
        await block_once('model_saved')
    return await original_gate(state, phase=phase)


runtime.Service.execute = execute
runtime.Service.finish = finish
document._gate = gate
__all__ = ['app']
