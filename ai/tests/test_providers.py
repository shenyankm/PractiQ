from __future__ import annotations

from collections.abc import Mapping, Sequence
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


def require_provider_module() -> Any:
    try:
        return import_module("openwook_ai.providers")
    except ModuleNotFoundError as exc:
        pytest.fail(f"Migration contract missing module openwook_ai.providers: {exc}")


def require_provider_member(name: str) -> Any:
    module = require_provider_module()
    try:
        member = getattr(module, name)
    except AttributeError:
        pytest.fail(f"Migration contract missing function {name} in openwook_ai.providers")

    assert callable(member), f"{name} must be callable"
    return member


def normalize_provider_config(config: Any) -> dict[str, Any]:
    field_names = (
        "provider_name",
        "api_key",
        "base_url",
        "model_name",
        "temperature",
        "max_tokens",
    )
    if isinstance(config, Mapping):
        missing = [field for field in field_names if field not in config]
        assert not missing, f"provider config missing fields: {missing}"
        return {field: config[field] for field in field_names}

    normalized = {field: getattr(config, field, None) for field in field_names}
    missing = [field for field, value in normalized.items() if value is None]
    assert not missing, f"provider config missing attrs: {missing}"
    return normalized


def normalize_provider_chain(chain: Any) -> list[dict[str, Any]]:
    assert isinstance(chain, Sequence), "resolve_provider_chain must return a sequence"
    return [normalize_provider_config(item) for item in chain]


@pytest.mark.parametrize(
    ("env", "expected_order"),
    [
        ({}, []),
        ({"OPENAI_API_KEY": "openai-key"}, ["openai"]),
        (
            {"DEEPSEEK_API_KEY": "deepseek-key", "OPENAI_API_KEY": "openai-key"},
            ["deepseek", "openai"],
        ),
        (
            {
                "MOONSHOT_API_KEY": "moonshot-key",
                "DEEPSEEK_API_KEY": "deepseek-key",
                "OPENAI_API_KEY": "openai-key",
            },
            ["moonshot", "deepseek", "openai"],
        ),
    ],
)
def test_resolve_provider_chain_uses_moonshot_then_deepseek_then_openai(
    env: dict[str, str],
    expected_order: list[str],
) -> None:
    resolve_provider_chain = require_provider_member("resolve_provider_chain")

    chain = normalize_provider_chain(resolve_provider_chain(env))

    assert [config["provider_name"] for config in chain] == expected_order


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        (
            {"MOONSHOT_API_KEY": "moonshot-key"},
            {
                "provider_name": "moonshot",
                "api_key": "moonshot-key",
                "base_url": "https://api.moonshot.cn/v1",
                "model_name": "kimi-k2.6",
                "temperature": 1.0,
                "max_tokens": 16384,
            },
        ),
        (
            {"DEEPSEEK_API_KEY": "deepseek-key"},
            {
                "provider_name": "deepseek",
                "api_key": "deepseek-key",
                "base_url": "https://api.deepseek.com",
                "model_name": "deepseek-v4-flash",
                "temperature": 0.2,
                "max_tokens": 4096,
            },
        ),
        (
            {"OPENAI_API_KEY": "openai-key"},
            {
                "provider_name": "openai",
                "api_key": "openai-key",
                "base_url": "https://api.moonshot.cn/v1",
                "model_name": "gpt-4o-mini",
                "temperature": 0.2,
                "max_tokens": 4096,
            },
        ),
    ],
)
def test_resolve_provider_config_uses_provider_defaults(
    env: dict[str, str],
    expected: dict[str, Any],
) -> None:
    resolve_provider_config = require_provider_member("resolve_provider_config")

    config = normalize_provider_config(resolve_provider_config(env))

    assert config == expected


@pytest.mark.parametrize(
    ("env", "expected_model_name"),
    [
        ({"MOONSHOT_API_KEY": "moonshot-key", "OPENAI_MODEL": "shared-model"}, "shared-model"),
        ({"DEEPSEEK_API_KEY": "deepseek-key", "OPENAI_MODEL": "shared-model"}, "shared-model"),
        ({"DEEPSEEK_API_KEY": "deepseek-key", "DEEPSEEK_MODEL": "deepseek-r1"}, "deepseek-r1"),
        ({"OPENAI_API_KEY": "openai-key", "OPENAI_MODEL": "gpt-4.1"}, "gpt-4.1"),
    ],
)
def test_resolve_provider_config_uses_model_fallbacks_from_mastra_contract(
    env: dict[str, str],
    expected_model_name: str,
) -> None:
    resolve_provider_config = require_provider_member("resolve_provider_config")

    config = normalize_provider_config(resolve_provider_config(env))

    assert config["model_name"] == expected_model_name


@pytest.mark.parametrize(
    "provider_env",
    [
        {"MOONSHOT_API_KEY": "moonshot-key"},
        {"DEEPSEEK_API_KEY": "deepseek-key"},
        {"OPENAI_API_KEY": "openai-key"},
    ],
)
def test_resolve_provider_config_applies_global_mastra_overrides(provider_env: dict[str, str]) -> None:
    resolve_provider_config = require_provider_member("resolve_provider_config")

    config = normalize_provider_config(
        resolve_provider_config(
            {
                **provider_env,
                "MASTRA_MODEL": "global-model",
                "MASTRA_TEMPERATURE": "0.75",
                "MASTRA_MAX_TOKENS": "8192",
            }
        )
    )

    assert config["model_name"] == "global-model"
    assert config["temperature"] == 0.75
    assert config["max_tokens"] == 8192


@pytest.mark.parametrize(
    ("env", "starting_payload", "expected_payload"),
    [
        (
            {},
            {"messages": [{"role": "user", "content": "hello"}]},
            {
                "messages": [{"role": "user", "content": "hello"}],
                "thinking": {"type": "enabled"},
            },
        ),
        (
            {"KIMI_THINKING_ENABLED": "false"},
            {"messages": [{"role": "user", "content": "hello"}]},
            {
                "messages": [{"role": "user", "content": "hello"}],
                "thinking": {"type": "disabled"},
            },
        ),
        (
            {"KIMI_THINKING_TYPE": "manual", "KIMI_THINKING_KEEP": "5"},
            {"messages": [{"role": "user", "content": "hello"}]},
            {
                "messages": [{"role": "user", "content": "hello"}],
                "thinking": {"type": "manual", "keep": "5"},
            },
        ),
        (
            {},
            {
                "messages": [{"role": "user", "content": "hello"}],
                "thinking": {"type": "already-set", "keep": "2"},
            },
            {
                "messages": [{"role": "user", "content": "hello"}],
                "thinking": {"type": "already-set", "keep": "2"},
            },
        ),
    ],
)
def test_apply_moonshot_thinking_matches_kimi_request_contract(
    env: dict[str, str],
    starting_payload: dict[str, Any],
    expected_payload: dict[str, Any],
) -> None:
    apply_moonshot_thinking = require_provider_member("apply_moonshot_thinking")

    payload = apply_moonshot_thinking(starting_payload, env)

    assert payload == expected_payload
