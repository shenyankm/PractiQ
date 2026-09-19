"""Check the actual provider payload and failed-output usage boundary offline."""

import json
from typing import Any, cast

import httpx2
import pytest
from langchain_core.messages import BaseMessage, HumanMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from practiq_ai import llm


class Result(BaseModel):
    value: int = Field(ge=0)


@pytest.mark.parametrize(
    "bad_content,finish",
    [(' {"value":1}', "length"), ('{"value":', "stop"), ('{"value":-1}', "stop")],
)
async def test_native_wire_format_repairs_and_records_failed_usage(
    monkeypatch, bad_content, finish
):
    monkeypatch.setenv("AI_STRUCTURED_OUTPUT_METHOD", "json_schema")
    requests = []

    def respond(request):
        payload = json.loads(request.content)
        requests.append(payload)
        assert payload["response_format"]["type"] == "json_schema"
        assert payload["response_format"]["json_schema"]["strict"] is True
        assert (
            payload["response_format"]["json_schema"]["schema"]
            == Result.model_json_schema()
        )
        assert payload["enable_thinking"] is False
        assert "tools" not in payload
        first = len(requests) == 1
        return httpx2.Response(
            200,
            json={
                "id": "test",
                "object": "chat.completion",
                "created": 0,
                "model": "qwen3.7-flash",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": finish if first else "stop",
                        "message": {
                            "role": "assistant",
                            "content": bad_content if first else '{"value":2}',
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            },
        )

    async with httpx2.AsyncClient(transport=httpx2.MockTransport(respond)) as client:
        model = ChatOpenAI(
            model="qwen3.7-flash",
            api_key=cast(Any, "test"),
            base_url=llm.BASE_URLS["dashscope"],
            max_retries=0,
            extra_body={"enable_thinking": False},
            http_async_client=client,
        )
        messages: list[BaseMessage] = [HumanMessage(content="Return JSON with value=2")]
        with llm.collect_usage() as usage:
            result, corrected, _ = await llm.structured_attempt(
                model, messages, Result, "test", runtime=None, logical_attempt=1
            )
            assert result is None
            result, _, _ = await llm.structured_attempt(
                model, corrected, Result, "test", runtime=None, logical_attempt=2
            )
        assert result == Result(value=2)
        assert len(usage) == 2
        assert sum(call.outputTokens for call in usage) == 10
        assert len(requests) == 2


def test_default_and_supported_protocol_selection(monkeypatch):
    monkeypatch.delenv("AI_STRUCTURED_OUTPUT_METHOD", raising=False)
    model = llm.build_model("dashscope", "test", "qwen3.7-flash")
    calls = []
    monkeypatch.setattr(
        ChatOpenAI,
        "with_structured_output",
        lambda self, schema, **kwargs: calls.append(kwargs),
    )
    llm.structured_output(model, Result)
    assert calls == [{"method": "function_calling", "include_raw": True}]
    assert cast(ChatOpenAI, model).extra_body == {"enable_thinking": False}
    monkeypatch.setenv("AI_STRUCTURED_OUTPUT_METHOD", "json_schema")
    other = llm.build_model("deepseek", "test", "deepseek-chat")
    with pytest.raises(ValueError, match="provider/model"):
        llm.structured_output(other, Result)
    monkeypatch.setenv("AI_STRUCTURED_OUTPUT_METHOD", "invalid")
    with pytest.raises(ValueError, match="AI_STRUCTURED_OUTPUT_METHOD"):
        llm.structured_output(model, Result)


@pytest.mark.parametrize('tool', [False, True])
@pytest.mark.parametrize('source', ['{"stem":"题干","answerMode":"short_answer"', '{"stem":"题干","options":[],}', '```json\n{"stem":"题干"}\n```'])
async def test_local_repair_accepts_incomplete_question_without_another_call(monkeypatch, tool, source):
    from langchain_core.messages import AIMessage

    from practiq_ai.contracts import ParsedQuestion

    raw = AIMessage(content='' if tool else source,
                    additional_kwargs={'tool_calls': [{'id':'repair','type':'function','function':{'name':'ParsedQuestion','arguments':source}}]} if tool else {},
                    usage_metadata={'input_tokens':10,'output_tokens':5,'total_tokens':15},
                    response_metadata={'finish_reason':'stop'})
    class Runner:
        async def ainvoke(self, messages, config=None):
            return {'raw':raw,'parsed':None,'parsing_error':ValueError('invalid JSON')}
    monkeypatch.setattr(llm, 'structured_output', lambda *args: Runner())
    model = llm.build_model('dashscope','test','qwen3.7-flash')
    messages: list[BaseMessage] = [HumanMessage(content='Extract')]
    with llm.collect_usage() as usage:
        result = await llm.structured_attempt(model, messages, ParsedQuestion, 'test')
    assert result[0] is not None
    assert result[0].stem == '题干'
    assert 'answerPayload' in result[0].missingFields
    assert result[1] == messages and len(usage) == 1


@pytest.mark.parametrize('source', ['{"value":', '{"value":"cut', '{"value":tru', '{"value":1,', '{"value":1]', '{"value":-1,}', '{"value":"2",}'])
def test_local_repair_does_not_invent_values_or_bypass_validation(source):
    from langchain_core.messages import AIMessage
    from pydantic import ConfigDict
    class StrictResult(Result):
        model_config = ConfigDict(strict=True)
    with pytest.raises(ValueError):
        llm.validate_response({'raw':AIMessage(content=source), 'parsed':None}, StrictResult)


def test_punctuation_repair_preserves_strings_false_zero_and_null():
    from practiq_ai.json_repair import repair_json
    source = '{"text":"逗号,}与引号\\\"不应修改","values":[false,0,null,]'
    assert json.loads(repair_json(source)) == {'text':'逗号,}与引号"不应修改','values':[False,0,None]}


async def test_corrections_keep_only_latest_output_and_stop_on_identical_failure():
    from tests.support import FakeModel

    model = FakeModel(responses=[{'value': -1}, {'value': -2}, {'value': -3}, {'value': 2}])
    original: list[BaseMessage] = [HumanMessage(content='source stays unchanged')]
    parsed, usage, failure = await llm.structured_call(model, original, Result, 'test')
    assert parsed == Result(value=2) and failure is None and len(usage) == 4
    assert [len(messages) for messages in model.calls] == [1, 3, 3, 3]
    assert all(messages[0] == original[0] for messages in model.calls)
    assert '-1' not in str(model.calls[-1]) and '-2' not in str(model.calls[-1])
    stalled = FakeModel(responses=[{'value': -1}] * 4)
    parsed, usage, failure = await llm.structured_call(stalled, original, Result, 'test')
    assert parsed is None and failure == 'OUTPUT_STALLED'
    assert len(stalled.calls) == len(usage) == 2


def test_stall_fingerprint_ignores_tool_ids_but_preserves_bad_arguments():
    from langchain_core.messages import AIMessage

    error = HumanMessage(content='Invalid JSON')
    def raw(args, identifier):
        return AIMessage(content='', additional_kwargs={'tool_calls': [
            {'id': identifier, 'type': 'function', 'function': {'name': 'Result', 'arguments': args}},
        ]})
    assert llm._failure_fingerprint(raw('{broken', 'a'), error) == llm._failure_fingerprint(raw('{broken', 'b'), error)
    assert llm._failure_fingerprint(raw('{broken', 'a'), error) != llm._failure_fingerprint(raw('{different', 'a'), error)


async def test_transient_error_does_not_trigger_output_stall(monkeypatch):
    from openai import APIConnectionError

    from tests.support import FakeModel

    monkeypatch.setattr(llm, '_retry_delay', lambda _: 0)
    error = APIConnectionError(request=httpx2.Request('POST', 'https://example.invalid'))
    model = FakeModel(responses=[{'value': -1}, error, {'value': -1}, {'value': 2}])
    result, usage, failure = await llm.structured_call(model, [HumanMessage(content='source')], Result, 'test')
    assert result == Result(value=2) and failure is None
    assert len(model.calls) == 4 and len(usage) == 3


def test_model_schema_requires_presence_without_inventing_missing_values():
    from langchain_core.utils.function_calling import convert_to_openai_tool

    from practiq_ai.contracts import ParsedQuestion
    from practiq_ai.graphs.document import PageParseResult

    wire = convert_to_openai_tool(llm._model_schema(PageParseResult))
    parameters = wire['function']['parameters']
    question = parameters['$defs']['ParsedQuestion']
    assert set(question['required']) == set(ParsedQuestion.model_fields)
    assert set(parameters['required']) == {'questions', 'groups', 'figures'}
    assert 'kind' in parameters['$defs']['PageFigure']['required']
    assert {"type": "null"} in question['properties']['answerMode']['anyOf']
    assert {"type": "null"} in question['properties']['answerPayload']['anyOf']
    # The public draft contract remains permissive about absent values.
    draft = ParsedQuestion.model_validate({'stem': 'An unanswered question'})
    assert draft.answerMode is None and draft.answerPayload is None and draft.options == []
    assert 'answerMode' in draft.missingFields


@pytest.mark.parametrize('wire', [
    [{'function': {'name': 'Wrong', 'arguments': '{"value":1}'}}],
    [{'function': {'name': 'Result', 'arguments': '{"value":1}'}}] * 2,
    [{}], [{'function': None}], [{'function': {'name': 'Result'}}],
    [{'function': {'arguments': '{"value":1}'}}], [None], 'malformed', {},
])
async def test_wire_validation_cannot_be_bypassed_by_parsed_object(monkeypatch, wire):
    from langchain_core.messages import AIMessage

    # Construct malformed provider envelopes without SDK normalization hiding them.
    raw = AIMessage(content='', usage_metadata={'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15})
    raw.additional_kwargs['tool_calls'] = wire
    response = {'raw': raw, 'parsed': Result(value=1), 'parsing_error': None}
    with pytest.raises(ValueError, match='tool'):
        llm.validate_response(response, Result)
    class Runner:
        async def ainvoke(self, messages, config=None):
            return response
    monkeypatch.setattr(llm, 'structured_output', lambda *_: Runner())
    parsed, usage, failure = await llm.structured_call(llm.build_model('dashscope', 'test', 'qwen3.7-flash'), [HumanMessage(content='source')], Result, 'test')
    assert parsed is None and failure == 'OUTPUT_STALLED' and len(usage) == 2


def test_wire_arguments_are_authoritative_and_normalized_calls_are_checked():
    from langchain_core.messages import AIMessage

    raw = AIMessage(content='', additional_kwargs={'tool_calls': [
        {'function': {'name': 'Result', 'arguments': '{"value":2}'}}]})
    response = {'raw': raw, 'parsed': Result(value=1)}
    assert llm.validate_response(response, Result).value == 2
    raw.additional_kwargs['tool_calls'][0]['function']['arguments'] = '{"value":-1}'
    with pytest.raises(ValueError):
        llm.validate_response(response, Result)
    raw = AIMessage(content='', tool_calls=[{'name': 'Wrong', 'args': {'value': 2}, 'id': 'a'}])
    with pytest.raises(ValueError, match='tool'):
        llm.validate_response({'raw': raw, 'parsed': Result(value=1)}, Result)
    raw.tool_calls[0]['name'] = 'Result'
    assert llm.validate_response({'raw': raw, 'parsed': Result(value=1)}, Result).value == 2


@pytest.mark.parametrize('repeated', [False, True])
async def test_truncation_code_survives_budget_and_stall(monkeypatch, repeated):
    from langchain_core.messages import AIMessage

    from tests.support import FakeModel

    attempts = []
    class Runner:
        async def ainvoke(self, messages, config=None):
            attempts.append(messages)
            return {'raw': AIMessage(content=json.dumps({'value': 1 if repeated else len(attempts)}),
                                    response_metadata={'finish_reason': 'length'},
                                    usage_metadata={'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15}),
                    'parsed': Result(value=1), 'parsing_error': None}
    monkeypatch.setattr(llm, 'structured_output', lambda *_: Runner())
    parsed, usage, failure = await llm.structured_call(FakeModel(responses=[]), [HumanMessage(content='source')], Result, 'test')
    assert parsed is None and failure == 'OUTPUT_TRUNCATED'
    assert len(usage) == len(attempts) == (2 if repeated else 4)
    assert sum(call.outputTokens for call in usage) == 5 * len(attempts)
    assert 'Do not omit questions' in attempts[1][-1].content


def test_semantic_descriptions_reach_wire_schema():
    from practiq_ai.graphs.document import PageParseResult

    schema = llm._model_schema(PageParseResult)['$defs']
    for model, fields in {'ParsedQuestion': ['answerPayload', 'sourceText', 'confidence', 'needsReview'],
                          'ParsedGroup': ['questionIndexes'], 'PageFigure': ['kind', 'bbox']}.items():
        assert all(schema[model]['properties'][field]['description'] for field in fields)


async def test_old_attempt_checkpoints_without_validation_code_replay(monkeypatch):
    from types import SimpleNamespace
    from uuid import uuid4

    from langchain_core.messages import messages_to_dict

    from tests.support import FakeModel

    replays = []
    async def cached(attempt, artifact):
        replays.append(attempt)
        return {'parsed': None, 'failureFingerprint': str(attempt),
                'correction': messages_to_dict([HumanMessage(content='old correction')]),
                'usage': {'callKey': str(uuid4()), 'modelId': 'fake', 'callKind': 'test', 'inputTokens': 10, 'outputTokens': 5}}
    async def guard(_):
        pass
    monkeypatch.setattr(llm, 'task', lambda **_: lambda function: cached)
    monkeypatch.setattr(llm, 'guard', guard)
    model = FakeModel(responses=[])
    parsed, usage, failure = await llm.structured_call(model, [HumanMessage(content='source')], Result, 'test',
                                                     runtime=cast(Any, SimpleNamespace(execution_info=SimpleNamespace(thread_id='t', run_id='r'))))
    assert parsed is None and failure == 'OUTPUT_INVALID'
    assert replays == [1, 2, 3, 4] and len(usage) == 4 and not model.calls


@pytest.mark.parametrize('arguments', ['{"value":-1}', '{broken'])
async def test_default_tool_protocol_correction_pairs_every_call(monkeypatch, arguments):
    monkeypatch.delenv('AI_STRUCTURED_OUTPUT_METHOD', raising=False)
    requests = []
    def respond(request):
        payload = json.loads(request.content)
        requests.append(payload)
        pending = set()
        for message in payload['messages']:
            if message['role'] == 'assistant':
                pending.update(call['id'] for call in message.get('tool_calls', []))
            elif message['role'] == 'tool':
                pending.remove(message['tool_call_id'])
            else:
                assert not pending, 'unanswered tool call before user message'
        assert not pending
        assert payload['tools'][0]['function']['name'] == 'Result'
        return httpx2.Response(200, json={
            'id': 'test', 'object': 'chat.completion', 'created': 0, 'model': 'qwen3.7-flash',
            'choices': [{'index': 0, 'finish_reason': 'tool_calls', 'message': {'role': 'assistant', 'content': None,
                'tool_calls': [{'id': f'call-{len(requests)}', 'type': 'function', 'function': {
                    'name': 'Result', 'arguments': arguments if len(requests) == 1 else '{"value":2}'}}]}}],
            'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}})
    async with httpx2.AsyncClient(transport=httpx2.MockTransport(respond)) as client:
        model = ChatOpenAI(model='qwen3.7-flash', api_key=cast(Any, 'test'), max_retries=0, http_async_client=client)
        result, usage, failure = await llm.structured_call(model, [HumanMessage(content='Extract')], Result, 'test')
    assert result == Result(value=2) and failure is None
    assert len(requests) == len(usage) == 2 and sum(item.outputTokens for item in usage) == 10
