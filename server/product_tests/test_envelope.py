
import json

from starlette.requests import Request

from practiq_ai.product import envelope


def _request(request_id: str = '') -> Request:
    scope = {
        'type': 'http',
        'method': 'GET',
        'path': '/',
        'headers': [],
        'query_string': b'',
        'state': {},
    }
    request = Request(scope)
    request.state.request_id = request_id
    return request


def test_ok_envelope_with_request_id():
    request = _request('req-123')
    response = envelope.ok(request, {'hello': 'world'})
    body = json.loads(bytes(response.body))
    assert response.status_code == 200
    assert body == {'data': {'hello': 'world'}, 'meta': {'requestId': 'req-123'}}
    assert response.headers['x-request-id'] == 'req-123'


def test_created_status():
    request = _request('req-1')
    response = envelope.created(request, {'id': 1})
    assert response.status_code == 201


def test_envelope_without_request_id_omits_meta_when_empty():
    request = _request('')
    response = envelope.ok(request, {'a': 1})
    body = json.loads(bytes(response.body))
    assert body == {'data': {'a': 1}}


def test_error_response_api_error():
    request = _request('req-9')
    response = envelope.error_response(
        request, envelope.new_error(403, 'FORBIDDEN', 'Bank owner access required')
    )
    body = json.loads(bytes(response.body))
    assert response.status_code == 403
    assert body == {'error': {'code': 'FORBIDDEN', 'message': 'Bank owner access required', 'requestId': 'req-9'}}


def test_error_response_unknown_maps_to_internal():
    request = _request('')
    response = envelope.error_response(request, RuntimeError('boom'))
    body = json.loads(bytes(response.body))
    assert response.status_code == 500
    assert body['error']['code'] == 'INTERNAL_ERROR'
    assert body['error']['message'] == 'Unexpected server error'


def test_validation_error_details():
    request = _request('r')
    err = envelope.validation_error([envelope.ValidationDetail('stem', 'is required')])
    response = envelope.error_response(request, err)
    body = json.loads(bytes(response.body))
    assert response.status_code == 422
    assert body['error']['code'] == 'VALIDATION_ERROR'
    assert body['error']['details'] == [{'field': 'stem', 'message': 'is required'}]
