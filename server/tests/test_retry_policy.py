"""Retry admission validates selection without constructing graph state."""

from copy import deepcopy
from typing import Any
from uuid import uuid4

import pytest

from practiq_ai.contracts import FailedUnit, RetryUnits
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.retry_policy import selected_retry_units, unit_failures


@pytest.mark.parametrize('indexes,expected', [([], {1, 2}), ([2], {2})])
def test_retry_selection_preserves_saved_state_and_skips_exhausted_units(indexes, expected):
    state = {'retryCounts': {'document_parse:0': 2}, 'chunkResults': [
        {'index': index, 'parsed': None, 'failureCode': 'OUTPUT_INVALID'} for index in range(3)
    ]}
    before = deepcopy(state)
    request = RetryUnits(requestId=uuid4(), units=[FailedUnit(stage='document_parse', index=index) for index in indexes])
    assert selected_retry_units(state, request) == {('document_parse', index) for index in expected}
    assert state == before
    assert [item['retriesRemaining'] for item in unit_failures(state)] == [0, 2, 2]


@pytest.mark.parametrize('failure,code', [
    ('applied', 'CONTROL_ALREADY_EXECUTED'),
    ('exhausted', 'RETRY_LIMIT_EXCEEDED'),
    ('unavailable', 'INVALID_RETRY_UNITS'),
    ('nonretryable', 'INVALID_RETRY_UNITS'),
])
def test_retry_selection_rejects_invalid_requests_without_changes(failure, code):
    request = RetryUnits(requestId=uuid4(), units=[FailedUnit(stage='document_parse', index=0)])
    state: dict[str, Any] = {'chunkResults': [{'index': 0, 'parsed': None, 'failureCode': 'OUTPUT_INVALID'}]}
    if failure == 'applied':
        state['appliedRetries'] = [str(request.requestId)]
    elif failure == 'exhausted':
        state['retryCounts'] = {'document_parse:0': 2}
    elif failure == 'unavailable':
        state['chunkResults'] = []
    else:
        state['chunkResults'][0]['failureCode'] = 'OUTPUT_TRUNCATED'
    before = deepcopy(state)
    with pytest.raises(DocumentProcessingError) as raised:
        selected_retry_units(state, request)
    assert raised.value.code == code and state == before
