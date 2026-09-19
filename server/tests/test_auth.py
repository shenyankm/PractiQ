import pytest
from fastapi import HTTPException

from practiq_ai.auth import authenticate


def test_auth_accepts_valid_bearer_token(monkeypatch):
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'secret')
    authenticate('Bearer secret')


@pytest.mark.parametrize('authorization', [None, '', 'Basic secret', 'Bearer wrong'])
def test_auth_rejects_missing_or_invalid_token(monkeypatch, authorization):
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'secret')
    with pytest.raises(HTTPException) as error:
        authenticate(authorization)
    assert error.value.status_code == 401
