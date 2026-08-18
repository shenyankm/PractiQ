-- Purpose: Migrate stored LLM configuration to the LangGraph-supported providers.
-- This fragment is safe to apply directly to an existing database during deployment.

UPDATE users
SET llm_provider = NULL,
    llm_api_key_ciphertext = NULL,
    llm_text_model = NULL,
    llm_vision_model = NULL
WHERE llm_provider IS NOT NULL
  AND llm_provider NOT IN ('dashscope', 'deepseek', 'moonshot');

UPDATE users
SET llm_vision_model = NULL
WHERE llm_provider = 'deepseek'
  AND llm_vision_model IS NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_llm_provider;
ALTER TABLE users
    ADD CONSTRAINT chk_users_llm_provider CHECK (
        llm_provider IS NULL OR llm_provider IN ('dashscope', 'deepseek', 'moonshot')
    );

ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_llm_config;
ALTER TABLE users
    ADD CONSTRAINT chk_users_llm_config CHECK (
        (llm_provider IS NULL AND llm_api_key_ciphertext IS NULL AND llm_text_model IS NULL AND llm_vision_model IS NULL)
        OR
        (
            llm_provider IS NOT NULL
            AND llm_api_key_ciphertext IS NOT NULL
            AND llm_text_model IS NOT NULL
            AND btrim(llm_text_model) <> ''
            AND (llm_vision_model IS NULL OR btrim(llm_vision_model) <> '')
            AND (llm_vision_model IS NULL OR llm_provider IN ('dashscope', 'moonshot'))
        )
    );
