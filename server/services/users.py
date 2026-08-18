"""User entitlement and encrypted per-user LLM configuration."""

from dataclasses import dataclass

from psycopg_pool import AsyncConnectionPool

from .. import envelope, membership
from ..auth.runtime import User

LLM_PROVIDERS = {'dashscope', 'deepseek', 'moonshot'}


@dataclass(frozen=True)
class LLMConfig:
    provider: str
    api_key: str
    text_model: str
    vision_model: str | None

    def public_dict(self) -> dict:
        return {
            'provider': self.provider,
            'textModel': self.text_model,
            'visionModel': self.vision_model,
            'configured': True,
        }


async def require_pro_entitlement(conn, user: User, feature: str) -> None:
    cursor = await conn.execute(
        'SELECT membership, trial_ends_at FROM users WHERE id = %s LIMIT 1', (user.id,)
    )
    row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'User not found')
    effective = membership.effective_membership(row[0], row[1])
    if not membership.tier_at_least(effective, 'pro'):
        raise envelope.new_error(403, 'PRO_REQUIRED', f'{feature} requires PRO membership')


async def require_organization_entitlement(conn, user: User, feature: str) -> None:
    cursor = await conn.execute(
        'SELECT membership, trial_ends_at FROM users WHERE id = %s LIMIT 1', (user.id,)
    )
    row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'User not found')
    effective = membership.effective_membership(row[0], row[1])
    if not membership.tier_at_least(effective, 'organization'):
        raise envelope.new_error(
            403, 'ORGANIZATION_REQUIRED', f'{feature} requires ORGANIZATION membership'
        )


async def llm_config_metadata(pool: AsyncConnectionPool, user_id: int) -> dict:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT llm_provider, llm_text_model, llm_vision_model,
                   llm_api_key_ciphertext IS NOT NULL
            FROM users WHERE id = %s LIMIT 1
            """,
            (user_id,),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'User not found')
    if row[0] not in LLM_PROVIDERS or not row[3]:
        return {'provider': None, 'textModel': None, 'visionModel': None, 'configured': False}
    return {'provider': row[0], 'textModel': row[1], 'visionModel': row[2], 'configured': True}


async def require_llm_config(
    pool: AsyncConnectionPool, user: User, encryption_secret: str, feature: str,
) -> LLMConfig:
    async with pool.connection() as conn:
        await require_pro_entitlement(conn, user, feature)
        cursor = await conn.execute(
            """
            SELECT llm_provider,
                   pgp_sym_decrypt(llm_api_key_ciphertext, %s),
                   llm_text_model,
                   llm_vision_model
            FROM users
            WHERE id = %s AND llm_api_key_ciphertext IS NOT NULL
            LIMIT 1
            """,
            (encryption_secret, user.id),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(
            409, 'LLM_CONFIG_REQUIRED', 'Configure an LLM API key before using cloud AI'
        )
    config = LLMConfig(row[0], row[1], row[2], row[3])
    _validate_llm_config(config)
    return config


async def save_llm_config(
    pool: AsyncConnectionPool,
    user: User,
    encryption_secret: str,
    config: LLMConfig,
) -> dict:
    _validate_llm_config(config)
    async with pool.connection() as conn:
        await require_pro_entitlement(conn, user, 'LLM API key hosting')
        await conn.execute(
            """
            UPDATE users
            SET llm_provider = %s,
                llm_api_key_ciphertext = pgp_sym_encrypt(%s, %s, 'cipher-algo=aes256'),
                llm_text_model = %s,
                llm_vision_model = %s
            WHERE id = %s
            """,
            (
                config.provider, config.api_key, encryption_secret,
                config.text_model, config.vision_model, user.id,
            ),
        )
    return config.public_dict()


def _validate_llm_config(config: LLMConfig) -> None:
    errors = []
    if config.provider not in LLM_PROVIDERS:
        errors.append(
            envelope.ValidationDetail(
                'provider', 'must be dashscope, deepseek, or moonshot'
            )
        )
    if config.provider == 'deepseek' and config.vision_model:
        errors.append(
            envelope.ValidationDetail(
                'visionModel', 'DeepSeek does not support vision models'
            )
        )
    if errors:
        raise envelope.validation_error(errors)


async def delete_llm_config(pool: AsyncConnectionPool, user_id: int) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE users
            SET llm_provider = NULL,
                llm_api_key_ciphertext = NULL,
                llm_text_model = NULL,
                llm_vision_model = NULL
            WHERE id = %s
            """,
            (user_id,),
        )
