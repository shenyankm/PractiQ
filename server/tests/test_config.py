import pytest

from practiq_ai import config


def _env(monkeypatch: pytest.MonkeyPatch, **values: str) -> None:
    for key in ("AI_SERVICE_TOKEN", "LLM_PROVIDER", "LLM_API_KEY", "LLM_VISION_MODEL", "AI_STORAGE_DIR"):
        monkeypatch.delenv(key, raising=False)
    for key, value in {
        'AI_SERVICE_TOKEN': 'token',
        'LLM_PROVIDER': 'dashscope',
        'LLM_API_KEY': 'key',
        'LLM_VISION_MODEL': 'model',
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


def test_load_defaults_worker_limit(monkeypatch: pytest.MonkeyPatch):
    _env(monkeypatch)
    monkeypatch.delenv("N_JOBS_PER_WORKER")
    assert config.load().jobs_per_worker == 8


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
        ({"LLM_PROVIDER": "openai"}, "LLM_BASE_URL"),
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
    _env(monkeypatch, AI_STORAGE_DIR=".local/ai")
    root = tmp_path / "server"
    (root / "src/practiq_ai").mkdir(parents=True)
    (root / "pyproject.toml").touch()
    monkeypatch.setattr(config, "SERVER_ROOT", root)
    expected = root / ".local/ai"
    monkeypatch.chdir(tmp_path)
    assert config.load().storage_dir == expected
    monkeypatch.setenv("AI_STORAGE_DIR", str(tmp_path / "files"))
    assert config.load().storage_dir == tmp_path / "files"


def test_oss_configuration(monkeypatch):
    _env(monkeypatch)
    assert config.load().storage_backend == 'local'
    values = {'AI_STORAGE_BACKEND': 'oss', 'AI_OSS_BUCKET': 'test-bucket',
              'AI_OSS_REGION': 'cn-hangzhou', 'AI_OSS_ACCESS_KEY_ID': 'private-id',
              'AI_OSS_ACCESS_KEY_SECRET': 'private-secret', 'AI_OSS_SECURITY_TOKEN': 'private-token',
              'AI_OSS_ENDPOINT': 'https://files.example.com', 'AI_OSS_USE_CNAME': 'true'}
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    cfg = config.load()
    assert cfg.oss_bucket == 'test-bucket' and cfg.oss_use_cname
    assert cfg.oss_security_token == 'private-token'
    assert 'private-' not in repr(cfg)
    for key in ('AI_OSS_BUCKET', 'AI_OSS_REGION', 'AI_OSS_ACCESS_KEY_ID', 'AI_OSS_ACCESS_KEY_SECRET'):
        monkeypatch.delenv(key)
        with pytest.raises(ValueError, match=key):
            config.load()
        monkeypatch.setenv(key, values[key])
    for key, value in [('AI_STORAGE_BACKEND','invalid'), ('AI_OSS_BUCKET','../bad'),
                       ('AI_OSS_REGION','https://bad'), ('AI_OSS_ENDPOINT','http://host'),
                       ('AI_OSS_ENDPOINT','https://user:password@host/path'),
                       ('AI_OSS_USE_CNAME','yes'), ('AI_OSS_ENDPOINT','')]:
        monkeypatch.setenv(key, value)
        with pytest.raises(ValueError):
            config.load()
        monkeypatch.setenv(key, values[key])


def test_sqlite_directory_and_custom_model_origin(tmp_path, monkeypatch):
    _env(monkeypatch, LLM_PROVIDER='openai', LLM_BASE_URL='http://127.0.0.1:1234/v1')
    monkeypatch.delenv('DATABASE_URI', raising=False)
    monkeypatch.setenv('AI_DATABASE_DIR', str(tmp_path / 'db'))
    assert config.database_dir() == tmp_path / 'db'
    assert config.load().base_url == 'http://127.0.0.1:1234/v1'
    for value in ('http://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret', 'file:///tmp/model'):
        monkeypatch.setenv('LLM_BASE_URL', value)
        with pytest.raises(ValueError, match='LLM_BASE_URL'):
            config.load()
    monkeypatch.setenv('AI_DATABASE_DIR', ' ')
    with pytest.raises(ValueError, match='AI_DATABASE_DIR'):
        config.database_dir()
    monkeypatch.setenv('DATABASE_URI', 'postgresql://unused')
    with pytest.raises(ValueError, match='no longer supported'):
        config.database_dir()
