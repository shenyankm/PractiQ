import os

import pytest

for key in tuple(os.environ):
    if key.startswith(("AI_", "LLM_")) or key in {"N_JOBS_PER_WORKER", "DATABASE_URI", "REDIS_URI"}:
        os.environ.pop(key)

os.environ.update({
    "LANGSMITH_TRACING": "false",
    "LANGCHAIN_TRACING_V2": "false",
    "AI_SERVICE_TOKEN": "test-token",
    "LLM_PROVIDER": "dashscope",
    "LLM_API_KEY": "test-key",
    "LLM_VISION_MODEL": "test-model",
    "LLM_TEXT_MODEL": "test-text-model",
    "N_JOBS_PER_WORKER": "8",
})


@pytest.fixture(scope="session", autouse=True)
def probe_report_identity(record_testsuite_property):
    from scripts.evaluate import probe_fingerprint

    record_testsuite_property("practiqProbeFingerprint", probe_fingerprint())
