from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class ProviderConfig:
    provider_name: str
    api_key: str
    base_url: str
    model_name: str
    temperature: float
    max_tokens: int


_PROVIDER_ORDER = ('moonshot', 'deepseek', 'openai')
_KIMI_BASE_URL = 'https://api.moonshot.cn/v1'
_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'


def resolve_provider_chain(env: Mapping[str, str | None]) -> list[ProviderConfig]:
    return [resolve_provider_config(env, provider) for provider in _PROVIDER_ORDER if _api_key(env, provider)]


def resolve_provider_config(env: Mapping[str, str | None], provider_name: str | None = None) -> ProviderConfig:
    provider = provider_name or _first_configured_provider(env)
    return ProviderConfig(
        provider_name=provider,
        api_key=_api_key(env, provider) or '',
        base_url=_base_url(env, provider),
        model_name=str(env.get('MASTRA_MODEL') or _model_name(env, provider)),
        temperature=float(env.get('MASTRA_TEMPERATURE') or ('1.0' if provider == 'moonshot' else '0.2')),
        max_tokens=int(env.get('MASTRA_MAX_TOKENS') or ('16384' if provider == 'moonshot' else '4096')),
    )


def apply_moonshot_thinking(payload: dict[str, Any], env: Mapping[str, str | None]) -> dict[str, Any]:
    if 'thinking' in payload:
        return payload
    thinking_type = env.get('KIMI_THINKING_TYPE') or ('disabled' if env.get('KIMI_THINKING_ENABLED') == 'false' else 'enabled')
    thinking: dict[str, str] = {'type': str(thinking_type)}
    if env.get('KIMI_THINKING_KEEP'):
        thinking['keep'] = str(env['KIMI_THINKING_KEEP'])
    return {**payload, 'thinking': thinking}


def _first_configured_provider(env: Mapping[str, str | None]) -> str:
    if env.get('MOONSHOT_API_KEY'):
        return 'moonshot'
    if env.get('DEEPSEEK_API_KEY'):
        return 'deepseek'
    return 'openai'


def _api_key(env: Mapping[str, str | None], provider: str) -> str | None:
    if provider == 'moonshot':
        return env.get('MOONSHOT_API_KEY')
    if provider == 'deepseek':
        return env.get('DEEPSEEK_API_KEY')
    return env.get('OPENAI_API_KEY')


def _base_url(env: Mapping[str, str | None], provider: str) -> str:
    if provider == 'moonshot':
        return str(env.get('MOONSHOT_BASE_URL') or _KIMI_BASE_URL)
    if provider == 'deepseek':
        return str(env.get('DEEPSEEK_BASE_URL') or _DEEPSEEK_BASE_URL)
    return str(env.get('OPENAI_BASE_URL') or _KIMI_BASE_URL)


def _model_name(env: Mapping[str, str | None], provider: str) -> str:
    if provider == 'moonshot':
        return str(env.get('OPENAI_MODEL') or 'kimi-k2.6')
    if provider == 'deepseek':
        return str(env.get('DEEPSEEK_MODEL') or env.get('OPENAI_MODEL') or 'deepseek-v4-flash')
    return str(env.get('OPENAI_MODEL') or 'gpt-4o-mini')
