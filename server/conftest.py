import json
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
    "LLM_MODEL": "test-model",
    "N_JOBS_PER_WORKER": "8",
})

PROBE_NODEIDS = pytest.StashKey[list[str]]()


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]):
    if any("::" in str(arg) for arg in config.args):
        config.stash[PROBE_NODEIDS] = []
        return
    from scripts.evaluate import PROBE_TESTS

    probes = {(module, name) for modules in PROBE_TESTS.values() for module, names in modules.items() for name in names}
    config.stash[PROBE_NODEIDS] = sorted(
        item.nodeid for item in items if (item.path.stem, item.name.split("[", 1)[0]) in probes
    )


@pytest.fixture(scope="session", autouse=True)
def probe_report_identity(request, record_testsuite_property):
    from scripts.evaluate import probe_fingerprint

    record_testsuite_property("practiqProbeFingerprint", probe_fingerprint())
    record_testsuite_property("practiqProbeNodeids", json.dumps(request.config.stash[PROBE_NODEIDS]))
