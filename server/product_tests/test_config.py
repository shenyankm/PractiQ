import pytest

from practiq_ai.product import config


def _env(monkeypatch: pytest.MonkeyPatch, **values: str) -> None:
    for key in ('AI_SERVICE_TOKEN', 'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_TEXT_MODEL', 'AI_HOST', 'AI_PORT'):
        monkeypatch.delenv(key, raising=False)
    for key, value in {
        'AI_SERVICE_TOKEN': 'token',
        'LLM_PROVIDER': 'dashscope',
        'LLM_API_KEY': 'key',
        'LLM_TEXT_MODEL': 'model',
        **values,
    }.items():
        monkeypatch.setenv(key, value)


def test_load_uses_ai_specific_host_and_port(monkeypatch: pytest.MonkeyPatch):
    _env(monkeypatch, AI_HOST='0.0.0.0', AI_PORT='8081')
    monkeypatch.setenv('PRACTIQ_HOST', 'wrong-host')
    monkeypatch.setenv('PORT', '9999')
    loaded = config.load()
    assert (loaded.host, loaded.port) == ('0.0.0.0', 8081)


@pytest.mark.parametrize('port', ('0', '65536', 'bad'))
def test_load_rejects_invalid_ai_ports(monkeypatch: pytest.MonkeyPatch, port: str):
    _env(monkeypatch, AI_PORT=port)
    with pytest.raises(ValueError, match='AI_PORT'):
        config.load()


def test_load_requires_service_token(monkeypatch: pytest.MonkeyPatch):
    _env(monkeypatch, AI_SERVICE_TOKEN='')
    with pytest.raises(ValueError, match='AI_SERVICE_TOKEN'):
        config.load()
