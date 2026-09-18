"""Reference-aware storage inventory; dry-run by default, recoverable cleanup only."""

import argparse
import asyncio
import json
import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import alibabacloud_oss_v2 as oss
import httpx
from langgraph_sdk import get_client

from practiq_ai.execution import TTL_MINUTES
from practiq_ai.storage import ObjectStore, OSSObjectStore, get_object_store

KEY = re.compile(r"^practiq-agent/(?:sources|artifacts)/([0-9a-f]{64})/")


def referenced_sources(value: Any) -> set[str]:
    if isinstance(value, dict):
        key = value.get("objectKey")
        found = {match.group(1)} if isinstance(key, str) and (match := KEY.match(key)) else set()
        return found.union(*(referenced_sources(item) for item in value.values()))
    if isinstance(value, list):
        return set().union(*(referenced_sources(item) for item in value))
    return set()


async def live_sources(api: Any) -> set[str]:
    """Scan every native thread and historical checkpoint, not just latest output."""
    sources: set[str] = set()
    offset = 0
    while True:
        threads = await api.threads.search(limit=100, offset=offset)
        for thread in threads:
            sources.update(referenced_sources(thread))
            before = None
            while True:
                # The native GET route accepts an ID cursor. The current server's
                # POST history schema/runtime disagree about the `before` shape.
                params = {"limit": 10, **({"before": before} if before else {})}
                history = await api.http.get(f"/threads/{quote(thread['thread_id'], safe='')}/history", params=params)
                sources.update(referenced_sources(history))
                if len(history) < 10:
                    break
                cursor = history[-1]["checkpoint"]["checkpoint_id"]
                if cursor == before:
                    raise RuntimeError("History pagination did not advance")
                before = cursor
        offset += len(threads)
        if len(threads) < 100:
            break
    offset = 0
    while True:
        page = await api.store.search_items(("document_tasks",), limit=100, offset=offset, refresh_ttl=False)
        sources.update(referenced_sources(page["items"]))
        if len(page["items"]) < 100:
            return sources
        offset += len(page["items"])


def inventory(store: ObjectStore) -> list[dict[str, Any]]:
    items = []
    if isinstance(store, OSSObjectStore):
        token = None
        while True:
            page = store.client.list_objects_v2(oss.ListObjectsV2Request(
                bucket=store._config.oss_bucket, prefix="practiq-agent/", continuation_token=token))
            for item in page.contents or []:
                if item.key and KEY.match(item.key):
                    if item.last_modified is None or item.size is None or item.etag is None:
                        raise RuntimeError("Object metadata is incomplete")
                    items.append({"key": item.key, "modified": item.last_modified.timestamp(), "size": item.size, "identity": item.etag})
            if not page.is_truncated:
                return items
            if not page.next_continuation_token or page.next_continuation_token == token:
                raise RuntimeError("Object pagination did not advance")
            token = page.next_continuation_token
    prefix = store.root / "practiq-agent"
    if prefix.is_symlink():
        raise ValueError("Refusing symlinked storage")
    for path in prefix.rglob("*"):
        if path.is_symlink():
            raise ValueError("Refusing symlinked storage")
        if path.is_file():
            key = path.relative_to(store.root).as_posix()
            if KEY.match(key):
                stat = path.stat()
                items.append({"key": key, "modified": stat.st_mtime, "size": stat.st_size,
                              "identity": f"{stat.st_ino}:{stat.st_mtime_ns}"})
    return items


def candidates(items: list[dict[str, Any]], sources: set[str], cutoff: float) -> list[dict[str, Any]]:
    return [item for item in items if item["modified"] < cutoff
            and (match := KEY.match(item["key"])) and match.group(1) not in sources]


def quarantine(store: ObjectStore, items: list[dict[str, Any]], run_id: str) -> None:
    current = {item["key"]: item for item in inventory(store)}
    if any(current.get(item["key"]) != item for item in items):
        raise RuntimeError("Storage changed since inventory; rescan before cleanup")
    if isinstance(store, OSSObjectStore):
        status = store.client.get_bucket_versioning(oss.GetBucketVersioningRequest(bucket=store._config.oss_bucket))
        if status.version_status != "Enabled":
            raise ValueError("Recoverable OSS cleanup requires enabled bucket versioning")
        for item in items:
            # No version_id: create a delete marker; retained object versions remain recoverable.
            store.client.delete_object(oss.DeleteObjectRequest(bucket=store._config.oss_bucket, key=item["key"]))
    else:
        for item in items:
            source = store._path(item["key"])
            target = store.root / ".quarantine" / run_id / item["key"]
            if any(parent.is_symlink() for parent in (target, *target.parents) if parent.is_relative_to(store.root)):
                raise ValueError("Refusing symlinked quarantine")
            target.parent.mkdir(parents=True, exist_ok=True)
            source.rename(target)


async def run(args: argparse.Namespace) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {args.token}"}
    api = get_client(url=args.base_url, api_key=None, headers=headers)

    async def require_drained() -> None:
        async with httpx.AsyncClient(base_url=args.base_url, headers=headers, timeout=30) as client:
            response = await client.get("/api/maintenance")
            response.raise_for_status()
            if not response.json()["enabled"] or await api.threads.count(status="busy"):
                raise RuntimeError("Cleanup requires maintenance mode and no busy threads on all replicas")

    if args.quarantine:
        await require_drained()
    store = get_object_store()
    sources = await live_sources(api)  # Any API failure aborts; never assume no references.
    items = await asyncio.to_thread(inventory, store)
    cutoff = (datetime.now(UTC) - timedelta(days=args.retention_days)).timestamp()
    selected = candidates(items, sources, cutoff)
    run_id = str(uuid4())
    result = {"runId": run_id, "backend": store._config.storage_backend,
              "mode": "quarantine" if args.quarantine else "dry-run", "retentionDays": args.retention_days,
              "objects": len(selected), "bytes": sum(item["size"] for item in selected), "candidates": selected,
              "completed": False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Persist the recovery inventory before moving any object, including on partial failure.
    with args.output.open("x") as handle:
        json.dump(result, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    if args.quarantine:
        await require_drained()
        if await live_sources(api) != sources:
            raise RuntimeError("References changed; rescan before cleanup")
        await asyncio.to_thread(quarantine, store, selected, run_id)
    result["completed"] = True
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--token", default=os.getenv("AI_SERVICE_TOKEN"))
    parser.add_argument("--retention-days", type=int, default=187)
    parser.add_argument("--quarantine", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.token or args.retention_days < TTL_MINUTES / 1440 + 7:
        parser.error("A service token and at least 187 days retention are required")
    if args.output.exists():
        parser.error("Refusing to overwrite an inventory")
    result = asyncio.run(run(args))
    print(f"{result['mode']}: {result['objects']} objects; inventory: {args.output}")


if __name__ == "__main__":
    main()
