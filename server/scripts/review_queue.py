"""Build a local, content-free review queue from practiq.events JSONL logs."""

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from practiq_ai.contracts import DocumentSourceType


class ReviewCandidate(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    threadId: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,100}$")
    runId: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,100}$")
    sourceType: DocumentSourceType
    status: Literal["ERROR", "PARTIAL", "SUCCEEDED"]
    reviewRequired: bool
    errorCode: str | None = Field(default=None, pattern=r"^[A-Z][A-Z0-9_]{0,63}$")


class ReviewDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    threadId: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,100}$")
    runId: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,100}$")
    verdict: Literal["correct", "incorrect", "uncertain"]
    errorCategory: Literal["extraction", "model_output", "merge", "gold_label"] | None

    @model_validator(mode="after")
    def validate_category(self) -> Self:
        if (self.verdict == "incorrect") != (self.errorCategory is not None):
            raise ValueError("Only incorrect verdicts require an error category")
        return self


def apply_decisions(report: dict[str, Any], decisions: list[ReviewDecision]) -> None:
    items = {(item["threadId"], item["runId"]): item for item in report["items"]}
    seen = set()
    for decision in decisions:
        key = decision.threadId, decision.runId
        if key in seen or key not in items:
            raise ValueError("Decisions must name unique runs from the selected review queue")
        seen.add(key)
    for item in items.values():
        item.update(verdict=None, errorCategory=None)
    for decision in decisions:
        items[decision.threadId, decision.runId].update(decision.model_dump())


def select_reviews(events: list[dict[str, Any]]) -> dict[str, Any]:
    # ponytail: a batch holds only identifiers per run; use daily log batches as volume grows.
    candidates: dict[tuple[str, str], dict[str, Any]] = {}
    for event in events:
        if event.get("event") != "review_candidate":
            continue
        item = ReviewCandidate.model_validate(event).model_dump(mode="json")
        reasons = []
        if item["status"] != "SUCCEEDED":
            reasons.append(item["status"])
        if item["reviewRequired"]:
            reasons.append("QUALITY_REVIEW")
        key = item["threadId"], item["runId"]
        previous = candidates.get(key)
        if previous:
            if previous["sourceType"] != item["sourceType"]:
                raise ValueError("a run cannot change its source format")
            reasons.extend(previous["reasons"])
            if previous["status"] in {"ERROR", "PARTIAL"}:
                item["status"], item["errorCode"] = previous["status"], previous["errorCode"]
        candidates[key] = {**item, "reasons": sorted(set(reasons))}
    selected = []
    for item in candidates.values():
        # Stable across replays and file ordering, sampled independently in each format.
        digest = hashlib.sha256(f"{item['sourceType']}:{item['threadId']}".encode()).digest()
        if not item["reasons"] and int.from_bytes(digest, "big") % 20 == 0:
            item["reasons"] = ["SAMPLED_5_PERCENT"]
        if item["reasons"]:
            selected.append(item)
    return {"schemaVersion": 1, "kind": "local-review-queue", "sampleRate": 0.05,
            "observedByFormat": dict(Counter(item["sourceType"] for item in candidates.values())),
            "selectedByFormat": dict(Counter(item["sourceType"] for item in selected)),
            "items": sorted(selected, key=lambda item: (item["sourceType"], item["threadId"], item["runId"]))}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--decisions", type=Path, help="JSON list of content-free human review decisions")
    args = parser.parse_args(argv)
    try:
        if args.output.suffix != ".json" or args.output.exists() or args.output.with_suffix(".md").exists():
            raise ValueError("choose a new JSON output path")
        with args.log.open() as handle:
            report = select_reviews([json.loads(line) for line in handle if line.strip()])
        decisions = TypeAdapter(list[ReviewDecision]).validate_json(args.decisions.read_text()) if args.decisions else []
        apply_decisions(report, decisions)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x") as handle:
            json.dump(report, handle, indent=2, ensure_ascii=False)
        lines = ["# 本地复核清单", "", "记录不包含正文；使用本地任务查询接口读取授权材料。", "",
                 "| 格式 | Thread | Run | 状态 | 原因 | 复核结论 | 错误类别 |", "|---|---|---|---|---|---|---|"]
        lines.extend(f"| {item['sourceType']} | {item['threadId']} | {item['runId']} | {item['status']} | {', '.join(item['reasons'])} | {item['verdict'] or '待复核'} | {item['errorCategory'] or ''} |" for item in report["items"])
        with args.output.with_suffix(".md").open("x") as handle:
            handle.write("\n".join(lines) + "\n")
    except (OSError, ValueError, TypeError):
        print("BLOCKED: check JSONL events and choose a new output path")
        return 2
    print(f"Selected {len(report['items'])} runs: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
