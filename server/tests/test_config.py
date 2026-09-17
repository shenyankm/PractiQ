import pytest

from practiq_ai import config


def _env(monkeypatch: pytest.MonkeyPatch, **values: str) -> None:
    for key in ("AI_SERVICE_TOKEN", "LLM_PROVIDER", "LLM_API_KEY", "LLM_TEXT_MODEL", "AI_STORAGE_DIR"):
        monkeypatch.delenv(key, raising=False)
    for key, value in {
        'AI_SERVICE_TOKEN': 'token',
        'LLM_PROVIDER': 'dashscope',
        'LLM_API_KEY': 'key',
        'LLM_TEXT_MODEL': 'model',
        **values,
    }.items():
        monkeypatch.setenv(key, value)


def test_load_reads_model_and_storage_settings(monkeypatch: pytest.MonkeyPatch):
    _env(
        monkeypatch,
        LLM_PROVIDER="deepseek",
        LLM_VISION_MODEL="vision",
        AI_MAX_DOCUMENT_PAGES="100",
        AI_GRAPH_MAX_CONCURRENCY="2",
        AI_STORAGE_CONCURRENCY="4",
    )
    loaded = config.load()
    assert loaded.provider == "deepseek"
    assert loaded.vision_model == "vision"
    assert loaded.storage_dir.is_absolute()
    assert loaded.max_document_pages == 100
    assert loaded.graph_max_concurrency == 2
    assert loaded.storage_concurrency == 4


def test_load_requires_service_token(monkeypatch: pytest.MonkeyPatch):
    _env(monkeypatch, AI_SERVICE_TOKEN='')
    with pytest.raises(ValueError, match='AI_SERVICE_TOKEN'):
        config.load()


def test_load_requires_worker_limit(monkeypatch: pytest.MonkeyPatch):
    _env(monkeypatch)
    monkeypatch.delenv("N_JOBS_PER_WORKER")
    with pytest.raises(ValueError, match="N_JOBS_PER_WORKER"):
        config.load()


def test_auth_token_does_not_require_model_or_storage_settings(monkeypatch: pytest.MonkeyPatch):
    for key in ("LLM_API_KEY", "AI_STORAGE_DIR"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'token')

    assert config.service_token() == 'token'


@pytest.mark.parametrize(
    ("name", "value"),
    (
        ("AI_SOURCE_MAX_BYTES", "nonsense"),
        ("AI_MAX_DOCUMENT_PAGES", "0"),
        ("AI_STORAGE_TIMEOUT_SECONDS", "-1"),
    ),
)
def test_load_rejects_invalid_numeric_settings(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    _env(monkeypatch, **{name: value})
    with pytest.raises(ValueError, match=name):
        config.load()


def test_load_rejects_model_concurrency_over_sixteen(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _env(
        monkeypatch,
        N_JOBS_PER_WORKER="8",
        AI_GRAPH_MAX_CONCURRENCY="3",
    )
    with pytest.raises(ValueError, match="must not exceed 16"):
        config.load()


@pytest.mark.parametrize(
    ("values", "message"),
    (
        ({"AI_STORAGE_DIR": " "}, "AI_STORAGE_DIR"),
        ({"LLM_PROVIDER": "unknown"}, "Unsupported LLM_PROVIDER"),
        ({"LLM_PROVIDER": "openai"}, "Unsupported LLM_PROVIDER"),
        ({"AI_STORAGE_TIMEOUT_SECONDS": "nonsense"}, "positive number"),
    ),
)
def test_load_rejects_invalid_service_settings(
    monkeypatch: pytest.MonkeyPatch,
    values: dict[str, str],
    message: str,
) -> None:
    _env(monkeypatch, **values)
    with pytest.raises(ValueError, match=message):
        config.load()


def test_storage_paths_are_independent_of_working_directory(tmp_path, monkeypatch):
    from pathlib import Path
    _env(monkeypatch, AI_STORAGE_DIR=".local/ai")
    expected = Path(config.__file__).resolve().parents[3] / ".local/ai"
    monkeypatch.chdir(tmp_path)
    assert config.load().storage_dir == expected
    monkeypatch.setenv("AI_STORAGE_DIR", str(tmp_path / "files"))
    assert config.load().storage_dir == tmp_path / "files"
