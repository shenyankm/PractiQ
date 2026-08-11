from __future__ import annotations

import json
import os
from functools import lru_cache

from agentscope.credential import DashScopeCredential
from agentscope.message import AssistantMsg, Msg, UserMsg
from agentscope.model import DashScopeChatModel
from pydantic import BaseModel, ValidationError

from ..extractors import DocumentProcessingError, positive_env

DEFAULT_TEXT_MODEL = 'qwen-max'
DEFAULT_VL_MODEL = 'qwen-vl-max'


def get_text_model() -> DashScopeChatModel | None:
    return _configured_model('AI_TEXT_MODEL', DEFAULT_TEXT_MODEL)


def get_vl_model() -> DashScopeChatModel | None:
    return _configured_model('AI_VL_MODEL', DEFAULT_VL_MODEL)


def _configured_model(env_name: str, default: str) -> DashScopeChatModel | None:
    api_key = os.getenv('DASHSCOPE_API_KEY', '').strip()
    if not api_key:
        return None
    return _build_model(
        api_key,
        os.getenv(env_name, default).strip() or default,
        positive_env('AI_AGENT_MAX_TOKENS', 16_384),
        positive_env('AI_AGENT_TIMEOUT_SECONDS', 180, float),
    )


@lru_cache(maxsize=4)
def _build_model(
    api_key: str,
    model_name: str,
    max_tokens: int,
    timeout_seconds: float,
) -> DashScopeChatModel:
    return DashScopeChatModel(
        credential=DashScopeCredential(api_key=api_key),
        model=model_name,
        parameters=DashScopeChatModel.Parameters(
            temperature=0,
            max_tokens=max_tokens,
        ),
        stream=False,
        max_retries=3,
        retry_delay=1.0,
        client_kwargs={'timeout': timeout_seconds},
    )


async def structured_call[ResultT: BaseModel](
    model: DashScopeChatModel | None,
    messages: list[Msg],
    schema: type[ResultT],
    validation_retries: int,
) -> ResultT | None:
    """结构化调用 + 校验失败反馈重试；传输层重试由框架内置机制负责。

    返回 None 表示重试耗尽仍未通过校验；传输层异常直接抛 502。
    """
    if model is None:
        raise DocumentProcessingError(503, 'AI provider is not configured')
    for attempt in range(validation_retries + 1):
        try:
            response = await model.generate_structured_output(
                messages=messages,
                structured_model=schema,
            )
        except Exception as exc:
            raise DocumentProcessingError(502, 'AI agent request failed') from exc
        try:
            return schema.model_validate(response.content)
        except ValidationError as error:
            if attempt == validation_retries:
                return None
            messages = [
                *messages,
                AssistantMsg(
                    name='assistant',
                    content=json.dumps(response.content, ensure_ascii=False),
                ),
                UserMsg(
                    name='user',
                    content=(
                        'Your previous output failed validation with these '
                        f'errors:\n{error}\nReturn a corrected result.'
                    ),
                ),
            ]
    return None
