"""Exercise Responses wire payloads and accounting boundaries without network calls."""

import gzip
import json
from contextlib import asynccontextmanager

import httpx2
import pytest
from langchain_core.messages import HumanMessage
from openai import APIStatusError
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
async def model_with_transport(respond, model_name='custom-model', base_url='http://127.0.0.1:1/v1'):
    model = llm.build_model('openai', 'synthetic', model_name,
                           base_url=base_url)
    client = model.root_async_client._client
    await client._transport.aclose()
    client._transport = httpx2.MockTransport(respond)
    try:
        yield model
    finally:
        await model.root_async_client.close()
        model.root_client.close()


@pytest.mark.parametrize('status', [301, 302, 303, 307, 308])
@pytest.mark.parametrize('location', ['https://other.invalid/responses', 'http://provider.invalid/v1/responses'])
async def test_model_clients_never_follow_redirects(status, location):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx2.Response(status, headers={'Location': location})

    async with model_with_transport(respond, base_url='https://provider.invalid/v1') as model:
        client = model.root_client._client
        client._transport.close()
        client._transport = httpx2.MockTransport(respond)
        for current in (client, model.root_async_client._client):
            assert current.follow_redirects is False
        with pytest.raises(APIStatusError):
            await model.root_async_client.responses.create(model='test', input='private document')
        with pytest.raises(APIStatusError):
            model.root_client.responses.create(model='test', input='private document')
    assert len(requests) == 2
    assert all(str(request.url) == 'https://provider.invalid/v1/responses' for request in requests)


class ResponseStream(httpx2.SyncByteStream, httpx2.AsyncByteStream):
    def __init__(self, body):
        self.body = body
        self.received = 0
        self.closed = False

    def __iter__(self):
        for offset in range(0, len(self.body), 128):
            chunk = self.body[offset:offset + 128]
            self.received += len(chunk)
            yield chunk

    async def __aiter__(self):
        for chunk in self:
            yield chunk

    def close(self):
        self.closed = True

    async def aclose(self):
        self.close()


@pytest.mark.parametrize('asynchronous', [False, True])
@pytest.mark.parametrize('status', [200, 503])
@pytest.mark.parametrize('size', [1024, 1025])
async def test_response_body_limit_covers_success_and_error_streams(monkeypatch, asynchronous, status, size):
    monkeypatch.setattr(llm, 'MODEL_RESPONSE_MAX_BYTES', 1024)
    body = json.dumps(response()).encode().ljust(size, b' ')
    stream = ResponseStream(body)
    value = httpx2.Response(status, request=httpx2.Request('POST', 'https://provider.invalid/v1/responses'),
                           stream=stream)

    async def read():
        if asynchronous:
            await llm._responses_async_response(value)
        else:
            llm._responses_response(value)

    if size > 1024:
        with pytest.raises(DocumentProcessingError) as exc:
            await read()
        assert exc.value.code == 'AI_RESPONSE_TOO_LARGE'
    else:
        await read()
        assert value.content == body
        assert value.json()['usage']['input_tokens'] == 10
    assert stream.closed


@pytest.mark.parametrize('asynchronous', [False, True])
@pytest.mark.parametrize('encoding', ['gzip', 'br', 'gzip, br'])
async def test_encoded_responses_are_rejected_before_decompression(asynchronous, encoding):
    stream = ResponseStream(gzip.compress(b' ' * 100_000))
    value = httpx2.Response(200, request=httpx2.Request('POST', 'https://provider.invalid/v1/responses'),
                           headers={'Content-Encoding': encoding}, stream=stream)
    with pytest.raises(DocumentProcessingError) as exc:
        if asynchronous:
            await llm._responses_async_response(value)
        else:
            llm._responses_response(value)
    assert exc.value.code == 'AI_RESPONSE_ENCODING'
    assert stream.closed and stream.received == 0


async def test_model_clients_request_identity_encoding():
    requests = []

    def respond(request):
        requests.append(request)
        return httpx2.Response(200, content=b'{}')

    async with model_with_transport(respond) as model:
        client = model.root_client._client
        client._transport.close()
        client._transport = httpx2.MockTransport(respond)
        model.root_client._client.get('https://provider.invalid/v1/probe')
        await model.root_async_client._client.get('https://provider.invalid/v1/probe')
    assert [request.headers['accept-encoding'] for request in requests] == ['identity', 'identity']


async def test_oversized_response_stays_unknown_without_paid_retry(monkeypatch):
    monkeypatch.setattr(llm, 'MODEL_RESPONSE_MAX_BYTES', 1024)
    requests = []
    stream = ResponseStream(b' ' * 100_000)

    def respond(request):
        requests.append(request)
        return httpx2.Response(200, stream=stream)

    records = []
    async with model_with_transport(respond) as model:
        with pytest.raises(DocumentProcessingError) as exc:
            await llm.structured_call(model, [], Result, 'test', call_records=records)
    assert exc.value.code == 'AI_RESPONSE_TOO_LARGE'
    assert len(requests) == len(records) == 1
    assert records[0]['usageStatus'] == 'unknown'
    assert stream.closed and stream.received < 100_000


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
@pytest.mark.parametrize('model_name', ['custom-model', 'gpt-5-pro'])
async def test_responses_incomplete_valid_json_is_rejected_with_known_usage(status, incomplete, code, model_name):
    record = {}
    async with model_with_transport(lambda _: httpx2.Response(200, json=response(status=status, incomplete=incomplete)),
                                    model_name=model_name) as model:
        parsed, corrected, usage = await llm.structured_attempt(model, [HumanMessage(content='Extract')], Result, 'test', call_record=record)
    assert parsed is None and corrected and usage.inputTokens == 10 and usage.outputTokens == 5
    assert record['validationCode'] == code


@pytest.mark.parametrize('model_name', ['custom-model', 'gpt-5-pro'])
async def test_responses_token_truncation_stops_same_limit_corrections_after_one_paid_call(model_name):
    requests = []
    def respond(request):
        requests.append(json.loads(request.content))
        return httpx2.Response(200, json=response(status='incomplete', incomplete={'reason': 'max_output_tokens'},
            usage={'input_tokens': 10, 'output_tokens': 8192, 'total_tokens': 8202}))
    records = []
    with telemetry.capture_events() as events:
        async with model_with_transport(respond, model_name=model_name) as model:
            parsed, usage, failure = await llm.structured_call(model, [HumanMessage(content='Extract')], Result, 'test', call_records=records)
    assert parsed is None and failure == 'OUTPUT_TRUNCATED'
    assert len(requests) == len(records) == len(usage) == 1
    assert requests[0]['max_output_tokens'] == 16384 and usage[0].outputTokens == 8192
    assert records[0]['usageStatus'] == 'known' and records[0]['validationCode'] == 'OUTPUT_TRUNCATED'
    assert [event['decision'] for event in events if event['event'] == 'model_decision'] == ['stop']


@pytest.mark.parametrize('base_url', ['http://127.0.0.1:1/v1', 'https://provider.invalid/custom/v1'])
async def test_all_endpoints_use_completed_responses(base_url):
    def respond(request):
        assert request.url.path.endswith('/responses')
        assert json.loads(request.content)['store'] is False
        return httpx2.Response(200, json=response())
    async with model_with_transport(respond, model_name='gpt-5-pro', base_url=base_url) as model:
        assert model.use_responses_api is True
        parsed, _, usage = await llm.structured_attempt(model, [], Result, 'test')
    assert parsed == Result(value=2) and usage.inputTokens == 10 and usage.outputTokens == 5


@pytest.mark.parametrize('base_url', ['http://127.0.0.1:1/v1', 'https://provider.invalid/custom/v1'])
async def test_sync_responses_explicitly_disable_storage(base_url):
    def respond(request):
        assert request.url.path.endswith('/responses')
        assert json.loads(request.content)['store'] is False
        return httpx2.Response(200, json=response())
    async with model_with_transport(respond, model_name='gpt-5-pro', base_url=base_url) as model:
        client = model.root_client._client
        client._transport.close()
        client._transport = httpx2.MockTransport(respond)
        result = llm.structured_output(model, Result).invoke([HumanMessage(content='Extract')])
        assert isinstance(result, dict)
        assert llm.validate_response(result, Result) == Result(value=2)


@pytest.mark.parametrize('usage,code', [
    (None, 'AI_USAGE_MISSING'), ({'prompt_tokens': 10, 'completion_tokens': 5}, 'AI_USAGE_MISSING'),
    ({'input_tokens': 10}, 'AI_USAGE_MISSING'), ({'output_tokens': 5}, 'AI_USAGE_MISSING'),
    ({'input_tokens': None, 'output_tokens': 5}, 'AI_USAGE_MISSING'),
    ({'input_tokens': True, 'output_tokens': 5}, 'AI_USAGE_INVALID'),
    ({'input_tokens': 10, 'output_tokens': -1}, 'AI_USAGE_INVALID'),
    ({'input_tokens': 10.5, 'output_tokens': 5}, 'AI_USAGE_INVALID'),
])
@pytest.mark.parametrize('model_name', ['custom-model', 'gpt-5-pro'])
@pytest.mark.parametrize('base_url', ['http://127.0.0.1:1/v1', 'https://provider.invalid/custom/v1'])
async def test_raw_responses_usage_is_validated_before_sdk_coercion(usage, code, model_name, base_url):
    body = response()
    body['usage'] = usage
    def respond(request):
        assert request.url.path.endswith('/responses')
        return httpx2.Response(200, json=body)
    async with model_with_transport(respond, model_name=model_name, base_url=base_url) as model:
        with pytest.raises(DocumentProcessingError) as exc:
            await llm.structured_attempt(model, [HumanMessage(content='Extract')], Result, 'test')
    assert exc.value.code == code


async def test_responses_missing_usage_stays_unknown_without_replay():
    requests = []
    def respond(request):
        requests.append(request)
        body = response()
        body['usage'].pop('input_tokens')
        return httpx2.Response(200, json=body)
    records = []
    async with model_with_transport(respond, model_name='gpt-5-pro') as model:
        with pytest.raises(DocumentProcessingError) as exc:
            await llm.structured_call(model, [], Result, 'test', call_records=records)
    assert exc.value.code == 'AI_USAGE_MISSING' and len(requests) == 1
    assert records[0]['usageStatus'] == 'unknown'


async def test_sync_responses_reject_missing_raw_usage():
    from openai import APIConnectionError

    def respond(request):
        assert request.url.path.endswith('/responses')
        body = response()
        body['usage'].pop('input_tokens')
        return httpx2.Response(200, json=body)
    async with model_with_transport(respond, model_name='gpt-5-pro') as model:
        client = model.root_client._client
        client._transport.close()
        client._transport = httpx2.MockTransport(respond)
        with pytest.raises(APIConnectionError) as exc:
            model.root_client.responses.create(model='gpt-5-pro', input='Extract')
    assert isinstance(exc.value.__cause__, DocumentProcessingError)
    assert exc.value.__cause__.code == 'AI_USAGE_MISSING'


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


async def test_unsupported_responses_endpoint_never_falls_back_to_chat_completions():
    requests = []
    def respond(request):
        requests.append(request)
        assert request.url.path == '/v1/responses'
        return httpx2.Response(404, json={'error': {'message': 'Responses unsupported', 'type': 'invalid_request_error'}})
    records = []
    async with model_with_transport(respond) as model:
        parsed, usage, failure = await llm.structured_call(model, [HumanMessage(content='Extract')], Result, 'test', call_records=records)
    assert parsed is None and failure == 'AI_PROVIDER_ERROR'
    assert len(requests) == len(records) == 1 and usage == []
