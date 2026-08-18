from dataclasses import dataclass
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langgraph.types import RetryPolicy
from openai import APIConnectionError, APIStatusError, APITimeoutError, RateLimitError
from pydantic import BaseModel

from ..extractors import positive_env
from ..services.users import LLMConfig

BASE_URLS = {
    'dashscope': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'deepseek': 'https://api.deepseek.com',
    'moonshot': 'https://api.moonshot.cn/v1',
}


@dataclass(frozen=True)
class AgentContext:
    text_model: BaseChatModel
    vision_model: BaseChatModel | None = None


def build_models(config: LLMConfig) -> tuple[BaseChatModel, BaseChatModel | None]:
    if config.provider not in BASE_URLS:
        raise ValueError(f'Unsupported LLM provider: {config.provider}')
    if config.provider == 'deepseek' and config.vision_model:
        raise ValueError('DeepSeek does not support vision models')
    return _build_model(config, config.text_model), (
        _build_model(config, config.vision_model) if config.vision_model else None
    )


def _build_model(config: LLMConfig, model_name: str) -> ChatOpenAI:
    return ChatOpenAI(
        model=model_name,
        api_key=config.api_key,
        base_url=BASE_URLS[config.provider],
        max_tokens=positive_env('AI_AGENT_MAX_TOKENS', 16_384),
        timeout=positive_env('AI_AGENT_TIMEOUT_SECONDS', 180, float),
        max_retries=0,
    )


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


# Preserve the previous one initial request plus three transport retries.
TRANSPORT_RETRY_POLICY = RetryPolicy(
    initial_interval=1.0,
    max_attempts=4,
    retry_on=_retryable_openai_error,
)


async def structured_attempt[ResultT: BaseModel](
    model: BaseChatModel,
    messages: list[BaseMessage],
    schema: type[ResultT],
) -> tuple[ResultT | None, list[BaseMessage]]:
    response: dict[str, Any] = await model.with_structured_output(
        schema,
        method='function_calling',
        include_raw=True,
    ).ainvoke(messages)
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
