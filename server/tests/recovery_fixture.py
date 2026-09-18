"""Isolated standalone-server crash drill hooks; never load in a real deployment.

Set PRACTIQ_RECOVERY_DRILL=1, PRACTIQ_RECOVERY_DIR to a persistent test mount,
PRACTIQ_RECOVERY_POINT and PRACTIQ_RECOVERY_PROVIDER to the fake provider origin.
Expose document_parser from this file through the test deployment graph config.
"""

import asyncio
import os
from pathlib import Path

from practiq_ai import llm
from practiq_ai.graphs import document
from practiq_ai.storage import ObjectStore

if os.environ.get("PRACTIQ_RECOVERY_DRILL") != "1":
    raise RuntimeError("Crash injection requires an isolated recovery deployment")

provider = os.environ["PRACTIQ_RECOVERY_PROVIDER"]
if not provider.startswith("http://"):
    raise RuntimeError("Use the isolated fake provider, never a real provider")
llm.BASE_URLS["dashscope"] = provider.rstrip("/") + "/v1"
llm.get_model.cache_clear()


def crash_once(point: str) -> None:
    if os.environ.get("PRACTIQ_RECOVERY_POINT") != point:
        return
    marker = Path(os.environ["PRACTIQ_RECOVERY_DIR"]) / f"{point}.fired"
    try:
        with marker.open("x") as handle:
            handle.write(point)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        return
    os._exit(86)


original_attempt = llm.structured_attempt
original_put = ObjectStore.put_artifact
original_gate = document._gate


async def attempt(*args, **kwargs):
    await asyncio.to_thread(crash_once, "before_request")
    result = await original_attempt(*args, **kwargs)
    await asyncio.to_thread(crash_once, "after_response")
    return result


async def put(self, *args, **kwargs):
    result = await original_put(self, *args, **kwargs)
    if kwargs["kind"].startswith("crop-"):
        await asyncio.to_thread(crash_once, "after_artifact")
    return result


async def gate(state, *, phase):
    if state.get("retryCounts") and phase in {"vision", "chunk"}:
        # Retry admission committed in the preceding load/review node.
        await asyncio.to_thread(crash_once, "after_retry_checkpoint")
    if phase == "completed":
        # merge and result_review have committed before this node is entered.
        await asyncio.to_thread(crash_once, "after_checkpoint")
    return await original_gate(state, phase=phase)


llm.structured_attempt = attempt
ObjectStore.put_artifact = put
document._gate = gate
document_parser = document.build_document_graph()
