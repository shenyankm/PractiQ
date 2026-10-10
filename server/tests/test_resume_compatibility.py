"""Synthetic checkpoint matrix for the deliberately conservative resume gate."""

import shutil
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

import pytest
from langgraph.types import Command

from practiq_ai import execution
from practiq_ai.errors import DocumentProcessingError
from tests.support import parsed, run_config, setup_graph


@pytest.mark.parametrize("change,compatible", [
    ("unchanged", True), ("credential", True), ("timeout", True), ("capacity", True),
    ("model", False), ("parser-limit", False), ("budget", False),
    ("state", False), ("runtime", False), ("source", False),
    ("lock-comment", False), ("missing-signature", False),
])
async def test_checkpoint_resume_compatibility_preserves_units_usage_and_receipts(monkeypatch, tmp_path, change, compatible):
    source = Path(execution.__file__).parent
    copied = tmp_path / "practiq_ai"
    shutil.copytree(source, copied, ignore=shutil.ignore_patterns("__pycache__"))
    lock = source / "uv.lock"
    shutil.copyfile(lock if lock.exists() else source.parents[1] / "uv.lock", copied / "uv.lock")
    monkeypatch.setattr(execution, "__file__", str(copied / "execution.py"))
    monkeypatch.setattr(execution, "code_version", execution.code_version.__wrapped__)
    graph, store, files, reference, model = setup_graph(
        monkeypatch, [parsed("First"), {"bad":1}, {"bad":1}], parts=["First", "Second"],
    )
    config = run_config()
    paused = await graph.ainvoke({"document":reference,"failurePolicy":"review"},config)
    assert paused["__interrupt__"][0].value["kind"] == "review"
    before = deepcopy((await graph.aget_state(config)).values)
    calls = len(model.calls)
    receipts = [item.value for item in await store.asearch(execution.namespace("thread-1", "calls"))]
    kinds = list(files.put_kinds)
    if change == "credential":
        monkeypatch.setenv("LLM_API_KEY", "synthetic-rotated-key")
    elif change == "timeout":
        monkeypatch.setenv("AI_AGENT_TIMEOUT_SECONDS", "240")
    elif change == "capacity":
        monkeypatch.setenv("AI_PROVIDER_RPM", "60")
    elif change == "model":
        monkeypatch.setenv("LLM_MODEL", "synthetic-other-model")
    elif change == "parser-limit":
        monkeypatch.setenv("AI_MAX_DOCUMENT_PAGES", "2")
    elif change == "budget":
        monkeypatch.setenv("AI_TASK_MAX_MODEL_CALLS", "399")
    elif change == "state":
        monkeypatch.setattr(execution, "STATE_VERSION", execution.STATE_VERSION + 1)
    elif change == "runtime":
        runtime = deepcopy(execution.runtime_version())
        runtime["packages"]["pydantic"] = "synthetic-other-version"
        monkeypatch.setattr(execution, "runtime_version", lambda: runtime)
    elif change in {"source", "lock-comment"}:
        path = copied / ("contracts.py" if change == "source" else "uv.lock")
        path.write_bytes(path.read_bytes() + b"\n# synthetic non-semantic audit change\n")
        assert execution.runtime_version() == before["execution"]["signature"]["runtime"]
    elif change == "missing-signature":
        missing = deepcopy(before["execution"])
        missing.pop("signature")
        await graph.aupdate_state(config,{"execution":missing})
    resume = Command(resume={"action":"retry_failed","requestId":str(uuid4())})
    if compatible:
        model.responses.append(parsed("Second"))
        result = await graph.ainvoke(resume,config)
        assert result["status"] == "SUCCEEDED"
        assert len(model.calls) == calls + 1
        assert result["usage"][:len(before["usage"])] == before["usage"]
        completed = (await graph.aget_state(config)).values
        assert completed["document"] == before["document"]
        preserved = [unit for unit in before["chunkResults"] if unit["parsed"]]
        assert len(preserved) == 1
        assert all(unit in completed["chunkResults"] for unit in preserved)
    else:
        with pytest.raises(DocumentProcessingError) as error:
            await graph.ainvoke(resume,config)
        assert error.value.code == "EXECUTION_VERSION_MISMATCH"
        assert len(model.calls) == calls and files.put_kinds == kinds
        after = (await graph.aget_state(config)).values
        assert after["usage"] == before["usage"] and after["document"] == before["document"]
        assert after["chunkResults"] == before["chunkResults"]
        assert [item.value for item in await store.asearch(execution.namespace("thread-1", "calls"))] == receipts
