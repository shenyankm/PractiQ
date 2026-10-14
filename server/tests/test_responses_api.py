"""Exercise Responses wire payloads and accounting boundaries without network calls."""

import json
from contextlib import asynccontextmanager

import httpx2
import pytest
from langchain_core.messages import HumanMessage
from pydantic import BaseModel, Field

from practiq_ai import llm, telemetry
from practiq_ai.errors import DocumentProcessingError


class Result(BaseModel):
    value: int = Field(ge=0)


def response(arguments='{"value":2}', *, status='completed', incomplete=None, usage=None, error=None):
    return {'id': 'resp-test', 'object': 'response', 'created_at': 0, 'status': status,
            'error': error, 'incomplete_details': incomplete, 'model': 'returned-model', 'service_tier': None,
            'output': [{'id': 'fc-test', 'type': 'function_call', 'call_id': 'call-test', 'status': 'completed',
                        'name': 'Result', 'arguments': arguments}],
            'usage': usage if usage is not None else {'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15,
                'input_tokens_details': {'cached_tokens': 3}, 'output_tokens_details': {'reasoning_tokens': 0}}}


@asynccontextmanager
async def model_with_transport(respond, model_api='responses', model_name='custom-model'):
    model = llm.build_model('openai', 'synthetic', model_name,
                           base_url='http://127.0.0.1:1/v1', model_api=model_api)
    client = model.root_async_client._client
    await client._transport.aclose()
    client._transport = httpx2.MockTransport(respond)
    try:
        yield model
    finally:
        await model.root_async_client.close()
        model.root_client.close()


@pytest.mark.parametrize('method', ['function_calling', 'auto'])
async def test_responses_wire_and_correction_keep_optional_schema_and_usage(monkeypatch, method):
    monkeypatch.setenv('AI_STRUCTURED_OUTPUT_METHOD', method)
    requests = []
    def respond(request):
        assert request.url.path == '/v1/responses'
        payload = json.loads(request.content)
        requests.append(payload)
        assert payload['store'] is False and payload['max_output_tokens'] == 16384
        assert 'messages' not in payload and 'response_format' not in payload
        assert payload['tools'][0]['strict'] is False and payload['tools'][0]['name'] == 'Result'
        assert payload['tool_choice'] == {'type': 'function', 'name': 'Result'}
        if len(requests) == 2:
            calls = [item for item in payload['input'] if item['type'] == 'function_call']
            replies = [item for item in payload['input'] if item['type'] == 'function_call_output']
            assert len(calls) == len(replies) == 1 and calls[0]['call_id'] == replies[0]['call_id'] == 'call-test'
        return httpx2.Response(200, json=response('{"value":-1}' if len(requests) == 1 else '{"value":2}'))
    async with model_with_transport(respond) as model:
        parsed, usage, failure = await llm.structured_call(model, [HumanMessage(content='Extract')], Result, 'test')
    assert parsed == Result(value=2) and failure is None
    assert len(requests) == len(usage) == 2 and sum(item.outputTokens for item in usage) == 10


@pytest.mark.parametrize('status,incomplete,code', [
    ('incomplete', {'reason': 'max_output_tokens'}, 'OUTPUT_TRUNCATED'),
    ('incomplete', {'reason': 'content_filter'}, 'OUTPUT_INVALID'),
    (None, None, 'OUTPUT_INVALID'),
])
async def test_responses_incomplete_valid_json_is_rejected_with_known_usage(status, incomplete, code):
    record = {}
    async with model_with_transport(lambda _: httpx2.Response(200, json=response(status=status, incomplete=incomplete))) as model:
        parsed, corrected, usage = await llm.structured_attempt(model, [HumanMessage(content='Extract')], Result, 'test', call_record=record)
    assert parsed is None and corrected and usage.inputTokens == 10 and usage.outputTokens == 5
    assert record['validationCode'] == code


async def test_responses_token_truncation_stops_same_limit_corrections_after_one_paid_call():
    requests = []
    def respond(request):
        requests.append(json.loads(request.content))
        return httpx2.Response(200, json=response(status='incomplete', incomplete={'reason': 'max_output_tokens'},
            usage={'input_tokens': 10, 'output_tokens': 8192, 'total_tokens': 8202}))
    records = []
    with telemetry.capture_events() as events:
        async with model_with_transport(respond) as model:
            parsed, usage, failure = await llm.structured_call(model, [HumanMessage(content='Extract')], Result, 'test', call_records=records)
    assert parsed is None and failure == 'OUTPUT_TRUNCATED'
    assert len(requests) == len(records) == len(usage) == 1
    assert requests[0]['max_output_tokens'] == 16384 and usage[0].outputTokens == 8192
    assert records[0]['usageStatus'] == 'known' and records[0]['validationCode'] == 'OUTPUT_TRUNCATED'
    assert [event['decision'] for event in events if event['event'] == 'model_decision'] == ['stop']


@pytest.mark.parametrize('usage,code', [
    (None, 'AI_USAGE_MISSING'), ({'prompt_tokens': 10, 'completion_tokens': 5}, 'AI_USAGE_MISSING'),
    ({'input_tokens': 10}, 'AI_USAGE_MISSING'), ({'output_tokens': 5}, 'AI_USAGE_MISSING'),
    ({'input_tokens': None, 'output_tokens': 5}, 'AI_USAGE_MISSING'),
    ({'input_tokens': True, 'output_tokens': 5}, 'AI_USAGE_INVALID'),
    ({'input_tokens': 10, 'output_tokens': -1}, 'AI_USAGE_INVALID'),
    ({'input_tokens': 10.5, 'output_tokens': 5}, 'AI_USAGE_INVALID'),
])
async def test_raw_responses_usage_is_validated_before_sdk_coercion(usage, code):
    body = response()
    body['usage'] = usage
    async with model_with_transport(lambda _: httpx2.Response(200, json=body)) as model:
        with pytest.raises(DocumentProcessingError) as exc:
            await llm.structured_attempt(model, [HumanMessage(content='Extract')], Result, 'test')
    assert exc.value.code == code


async def test_malformed_responses_usage_stops_without_repeating_a_paid_attempt():
    requests = []
    def respond(request):
        requests.append(request)
        return httpx2.Response(200, content=b'not a JSON response')
    records = []
    async with model_with_transport(respond) as model:
        with pytest.raises(DocumentProcessingError) as exc:
            await llm.structured_call(model, [], Result, 'test', call_records=records)
    assert exc.value.code == 'AI_USAGE_INVALID' and len(requests) == 1
    assert records[0]['usageStatus'] == 'unknown'


async def test_responses_error_envelope_remains_unknown_and_never_retries_or_exposes_body():
    requests = []
    def respond(request):
        requests.append(request)
        return httpx2.Response(200, json=response(status='failed', error={'code': 'server_error', 'message': 'private-provider-body'}))
    records = []
    with telemetry.capture_events() as events:
        async with model_with_transport(respond) as model:
            parsed, usage, failure = await llm.structured_call(model, [HumanMessage(content='Extract')], Result, 'test', call_records=records)
    assert parsed is None and usage == [] and failure == 'AI_PROVIDER_ERROR' and len(requests) == 1
    assert records[0]['usageStatus'] == 'unknown'
    assert 'private-provider-body' not in json.dumps([records, events])


@pytest.mark.parametrize('model_api', [None, 'chat_completions'])
async def test_default_and_explicit_chat_completions_preserve_original_wire(model_api):
    def respond(request):
        assert request.url.path == '/v1/chat/completions'
        payload = json.loads(request.content)
        assert 'messages' in payload and 'store' not in payload
        assert 'strict' not in payload['tools'][0]['function']
        return httpx2.Response(200, json={'id': 'chat-test', 'object': 'chat.completion', 'created': 0,
            'model': 'custom-model', 'choices': [{'index': 0, 'finish_reason': 'tool_calls', 'message': {
                'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'call-test', 'type': 'function',
                    'function': {'name': 'Result', 'arguments': '{"value":2}'}}]}}],
            'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}})
    async with model_with_transport(respond, model_api=model_api) as model:
        parsed, _, usage = await llm.structured_attempt(model, [HumanMessage(content='Extract')], Result, 'test')
    assert parsed == Result(value=2) and usage.inputTokens == 10


def test_invalid_model_api_is_rejected_before_client_construction():
    with pytest.raises(ValueError, match='Unsupported model API'):
        llm.build_model('openai', 'synthetic', 'custom-model', base_url='https://example.invalid/v1', model_api='invalid')
