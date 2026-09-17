import os

for key in tuple(os.environ):
    if key.startswith(("AI_", "LLM_")) or key == "N_JOBS_PER_WORKER":
        os.environ.pop(key)

os.environ.update({
    "AI_SERVICE_TOKEN": "test-token",
    "LLM_PROVIDER": "dashscope",
    "LLM_API_KEY": "test-key",
    "LLM_TEXT_MODEL": "test-model",
    "N_JOBS_PER_WORKER": "8",
})
