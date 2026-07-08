from __future__ import annotations

from importlib import import_module
from pathlib import Path
import sys
from typing import Any

import pytest


AI_ROOT = Path(__file__).resolve().parents[1]
if str(AI_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_ROOT))


@pytest.fixture(autouse=True)
def clear_provider_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "MOONSHOT_API_KEY",
        "DEEPSEEK_API_KEY",
        "OPENAI_API_KEY",
        "MOONSHOT_BASE_URL",
        "DEEPSEEK_BASE_URL",
        "OPENAI_BASE_URL",
        "OPENAI_MODEL",
        "DEEPSEEK_MODEL",
        "MASTRA_MODEL",
        "MASTRA_TEMPERATURE",
        "MASTRA_MAX_TOKENS",
        "KIMI_THINKING_TYPE",
        "KIMI_THINKING_ENABLED",
        "KIMI_THINKING_KEEP",
    ):
        monkeypatch.delenv(key, raising=False)


def require_config_loader() -> Any:
    try:
        module = import_module("openwook_ai.config")
    except ModuleNotFoundError as exc:
        pytest.fail(f"Migration contract missing module openwook_ai.config: {exc}")

    try:
        loader = getattr(module, "load_environment")
    except AttributeError:
        pytest.fail("Migration contract missing function load_environment in openwook_ai.config")

    assert callable(loader), "load_environment must be callable"
    return loader


def test_load_environment_reads_dotenv_local_then_dotenv_then_process_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / ".env.local").write_text(
        "OPENAI_API_KEY=from-dotenv-local\n"
        "DEEPSEEK_API_KEY=local-deepseek\n"
        "SHARED_VALUE=from-dotenv-local\n",
        encoding="utf-8",
    )
    (tmp_path / ".env").write_text(
        "OPENAI_API_KEY=from-dotenv\n"
        "MOONSHOT_API_KEY=from-dotenv\n"
        "SHARED_VALUE=from-dotenv\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OPENAI_API_KEY", "from-process")
    monkeypatch.setenv("PROCESS_ONLY_VALUE", "from-process-only")

    load_environment = require_config_loader()
    loaded = load_environment()

    assert loaded["OPENAI_API_KEY"] == "from-process"
    assert loaded["MOONSHOT_API_KEY"] == "from-dotenv"
    assert loaded["DEEPSEEK_API_KEY"] == "local-deepseek"
    assert loaded["SHARED_VALUE"] == "from-dotenv"
    assert loaded["PROCESS_ONLY_VALUE"] == "from-process-only"
