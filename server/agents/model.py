from __future__ import annotations

import json

from agentscope.credential import (
    AnthropicCredential,
    DashScopeCredential,
    DeepSeekCredential,
    GeminiCredential,
    MoonshotCredential,
    OpenAICredential,
    XAICredential,
)
from agentscope.message import AssistantMsg, Msg, UserMsg
from agentscope.model import (
    AnthropicChatModel,
    ChatModelBase,
    DashScopeChatModel,
    DeepSeekChatModel,
    GeminiChatModel,
    MoonshotChatModel,
    OpenAIChatModel,
    XAIChatModel,
)
from pydantic import BaseModel, ValidationError

from ..extractors import DocumentProcessingError, positive_env
from ..services.users import LLMConfig

MODEL_TYPES = {
    'anthropic': (AnthropicCredential, AnthropicChatModel),
    'dashscope': (DashScopeCredential, DashScopeChatModel),
    'deepseek': (DeepSeekCredential, DeepSeekChatModel),
    'gemini': (GeminiCredential, GeminiChatModel),
    'moonshot': (MoonshotCredential, MoonshotChatModel),
    'openai': (OpenAICredential, OpenAIChatModel),
    'xai': (XAICredential, XAIChatModel),
}


def build_models(config: LLMConfig) -> tuple[ChatModelBase, ChatModelBase | None]:
    return _build_model(config, config.text_model), (
        _build_model(config, config.vision_model) if config.vision_model else None
    )


def _build_model(config: LLMConfig, model_name: str) -> ChatModelBase:
    credential_type, model_type = MODEL_TYPES[config.provider]
    return model_type(
        credential=credential_type(api_key=config.api_key),
        model=model_name,
        parameters=model_type.Parameters(
            max_tokens=positive_env('AI_AGENT_MAX_TOKENS', 16_384),
        ),
        stream=False,
        max_retries=3,
        retry_delay=1.0,
        client_kwargs={
            'timeout': positive_env('AI_AGENT_TIMEOUT_SECONDS', 180, float),
        },
    )


async def structured_call[ResultT: BaseModel](
    model: ChatModelBase,
    messages: list[Msg],
    schema: type[ResultT],
    validation_retries: int,
) -> ResultT | None:
    """Call a configured model and retry only structured-output validation."""
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
