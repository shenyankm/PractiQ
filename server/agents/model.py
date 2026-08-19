import asyncio
from dataclasses import dataclass
from typing import Any, cast

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from openai import APIConnectionError, APIStatusError, APITimeoutError, RateLimitError
from pydantic import BaseModel

from ..extractors import positive_env
from ..operations import ensure_active, record_model_call, termination_status

BASE_URLS = {
    'dashscope': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'deepseek': 'https://api.deepseek.com',
    'moonshot': 'https://api.moonshot.cn/v1',
}


@dataclass(frozen=True)
class AgentContext:
    text_model: BaseChatModel
    vision_model: BaseChatModel | None = None


def build_models(
    provider: str, api_key: str, text_model: str, vision_model: str | None = None,
) -> tuple[BaseChatModel, BaseChatModel | None]:
    if provider not in BASE_URLS:
        raise ValueError(f'Unsupported LLM provider: {provider}')
    if provider == 'deepseek' and vision_model:
        raise ValueError('DeepSeek does not support vision models')
    return _build_model(provider, api_key, text_model), (
        _build_model(provider, api_key, vision_model) if vision_model else None
    )


def _build_model(provider: str, api_key: str, model_name: str) -> ChatOpenAI:
    model = ChatOpenAI(
        model=model_name,
        api_key=cast(Any, api_key),
        base_url=BASE_URLS[provider],
        **cast(dict[str, Any], {'max_tokens': positive_env('AI_AGENT_MAX_TOKENS', 16_384)}),
        timeout=positive_env('AI_AGENT_TIMEOUT_SECONDS', 180, float),
        max_retries=0,
    )
    object.__setattr__(model, 'practiq_provider', provider)
    return model


def graph_config(config: RunnableConfig | None = None) -> RunnableConfig:
    return {
        **(config or {}),
        'max_concurrency': positive_env('AI_AGENT_MAX_CONCURRENCY', 4),
    }


def _retryable_openai_error(exc: Exception) -> bool:
    if isinstance(exc, (APIConnectionError, APITimeoutError, RateLimitError)):
        return True
    if not isinstance(exc, APIStatusError):
        return False
    return exc.status_code in {408, 409, 429} or exc.status_code >= 500


async def structured_attempt[ResultT: BaseModel](
    model: BaseChatModel,
    messages: list[BaseMessage],
    schema: type[ResultT],
    *,
    stage: str,
) -> tuple[ResultT | None, list[BaseMessage]]:
    response: dict[str, Any] | None = None
    for attempt in range(1, 5):
        ensure_active()
        try:
            response = cast(dict[str, Any], await model.with_structured_output(
                schema,
                method='function_calling',
                include_raw=True,
            ).ainvoke(messages))
        except asyncio.CancelledError:
            record_model_call(model, stage, termination_status())
            raise
        except Exception as exc:
            record_model_call(model, stage, 'provider_error')
            if attempt == 4 or not _retryable_openai_error(exc):
                raise
            await asyncio.sleep(2 ** (attempt - 1))
            continue
        record_model_call(model, stage, 'succeeded', response.get('raw'))
        break
    assert response is not None
    if parsed := response['parsed']:
        return parsed, messages
    error = response['parsing_error']
    return None, [
        *messages,
        response['raw'],
        HumanMessage(
            content=(
                'Your previous output failed validation with these errors:\n'
                f'{error}\nReturn a corrected result.'
            )
        ),
    ]
