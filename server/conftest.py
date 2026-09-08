import os

for key in tuple(os.environ):
    if key.startswith(("AI_", "LLM_")) or key == "N_JOBS_PER_WORKER":
        os.environ.pop(key)

os.environ.update({
    "AI_SERVICE_TOKEN": "test-token",
    "LLM_PROVIDER": "dashscope",
    "LLM_API_KEY": "test-key",
    "LLM_TEXT_MODEL": "test-model",
    "AI_OSS_ENDPOINT": "https://oss-cn-hangzhou.aliyuncs.com",
    "AI_OSS_BUCKET": "test-bucket",
    "AI_OSS_ACCESS_KEY_ID": "test-id",
    "AI_OSS_ACCESS_KEY_SECRET": "test-secret",
    "N_JOBS_PER_WORKER": "8",
})
