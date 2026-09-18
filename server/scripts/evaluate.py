"""Local, reference-based document evaluation; comparisons never call services."""

import argparse
import asyncio
import hashlib
import json
import re
import statistics
import subprocess
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime
from math import isfinite
from pathlib import Path
from typing import Any, Literal, Self, cast
from uuid import UUID, uuid4

import httpx
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from openai import APIError
from pydantic import BaseModel, ConfigDict, Field, model_validator

from practiq_ai.config import load
from practiq_ai.contracts import (
    AnswerMode,
    AnswerPayload,
    DocumentParseResult,
    DocumentProcessing,
    DocumentSourceType,
    DocumentUploadRequest,
    ParsedGroup,
    ParsedOption,
    ParsedQuestion,
    VisualKind,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.storage import get_object_store

ROOT = Path(__file__).parents[1]
SCORER_VERSION = "2.0.0"
SOURCE_TYPES = {"text", "csv", "xlsx", "docx", "pdf", "image"}
ANSWER_MODES = {"choice", "true_false", "fill_blank", "short_answer"}
METRICS = (
    "questionPrecision", "questionRecall", "answerModeAccuracy", "optionsAccuracy",
    "parsedAnswerAccuracy", "groupF1", "visualF1",
)
MEDIA_TYPES = {
    "csv": "text/csv",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image": "image/png", "pdf": "application/pdf", "text": "text/plain",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
BLOCKING_CODES = {
    "AI_PROVIDER_ERROR", "AI_PROVIDER_UNAVAILABLE", "OBJECT_STORE_UNAVAILABLE",
    "VISION_MODEL_REQUIRED", "CONFIGURATION_ERROR", "UPLOAD_UNAVAILABLE",
}
FORBIDDEN_REPORT_KEYS = {
    "apikey", "authorization", "databaseurl", "databaseuri", "headers", "password",
    "signedurl", "objectkey", "accesskeyid", "accesskeysecret", "secret", "token",
}
SETTING_NAMES = (
    "source_max_bytes", "vision_max_bytes", "max_document_pages", "max_vision_page_pixels",
    "max_total_input_chars", "graph_max_concurrency", "storage_concurrency",
    "storage_timeout_seconds", "model_timeout_seconds", "model_max_tokens",
)


class GoldModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class GoldQuestion(GoldModel):
    stem: str = Field(min_length=1)
    stemAliases: list[str] = Field(default_factory=list)
    answerMode: AnswerMode
    options: list[ParsedOption] = Field(default_factory=list)
    answerPayload: AnswerPayload | None
    answerAliases: list[AnswerPayload] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_question(self) -> Self:
        base = {
            **self.model_dump(exclude={"stemAliases", "answerAliases"}),
            "questionTypeId": "expected", "confidence": 1, "needsReview": False,
            "contentBlocks": [{"partType": "text", "textValue": self.stem}],
        }
        parsed_answer = ParsedQuestion.model_validate(base).answerPayload
        if isinstance(parsed_answer, dict):
            raise ValueError("gold answers must be complete")  # noqa: TRY004 - Pydantic validators require ValueError
        self.answerPayload = parsed_answer
        if self.answerPayload is None and self.answerAliases:
            raise ValueError("missing source answers cannot have answer aliases")
        for alias in self.answerAliases:
            ParsedQuestion.model_validate({**base, "answerPayload": alias})
        if any(not normalize_stem(alias) for alias in [self.stem, *self.stemAliases]):
            raise ValueError("stems and aliases must not be blank")
        return self


class ExpectedError(GoldModel):
    code: str = Field(min_length=1)
    statusCode: int = Field(ge=400, le=599)


class GoldCase(GoldModel):
    id: str = Field(min_length=1, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    sourceType: DocumentSourceType
    path: str = Field(min_length=1)
    tags: list[str] = Field(default_factory=list)
    critical: bool = False
    expectedQuestions: list[GoldQuestion] = Field(default_factory=list)
    expectedGroups: list[ParsedGroup] | None = None
    expectedVisualKinds: list[VisualKind] | None = None
    expectedError: ExpectedError | None = None

    @model_validator(mode="after")
    def validate_expectations(self) -> Self:
        if any(not tag.strip() for tag in self.tags) or len(set(self.tags)) != len(self.tags):
            raise ValueError("tags must be unique non-blank strings")
        if self.expectedError:
            if self.expectedQuestions or self.expectedGroups is not None or self.expectedVisualKinds is not None:
                raise ValueError("error cases cannot contain result expectations")
            if self.expectedError.code in BLOCKING_CODES:
                raise ValueError("service unavailability cannot be an expected success")
        elif not self.expectedQuestions:
            raise ValueError("normal cases require expectedQuestions")
        for group in self.expectedGroups or []:
            if any(index < 0 or index >= len(self.expectedQuestions) for index in group.questionIndexes):
                raise ValueError("expected group index is outside expectedQuestions")
        # Repeated stems are valid; aliases must not ambiguously match different stems.
        owners: dict[str, str] = {}
        for question in self.expectedQuestions:
            stem = normalize_stem(question.stem)
            for alias in [question.stem, *question.stemAliases]:
                key = normalize_stem(alias)
                if key in owners and owners[key] != stem:
                    raise ValueError("ambiguous stem alias")
                owners[key] = stem
        return self


class Manifest(GoldModel):
    schemaVersion: Literal[2]
    cases: list[GoldCase] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_ids(self) -> Self:
        ids = [case.id for case in self.cases]
        if len(set(ids)) != len(ids):
            raise ValueError("case ids must be unique")
        return self


def normalize_stem(value: str) -> str:
    value = re.sub(r"^\s*(?:\d{1,4}\s*[.、)．]|[一二三四五六七八九十]{1,3}\s*[、.．])", "", value, count=1)
    return re.sub(r"\s+", "", value)


def _normalize_json(value: Any) -> Any:
    if isinstance(value, str):
        return re.sub(r"\s+", " ", value).strip()
    if isinstance(value, list):
        return [_normalize_json(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize_json(item) for key, item in value.items()}
    return value


def load_manifest(path: Path) -> dict[str, Any]:
    manifest = Manifest.model_validate(json.loads(path.read_text(encoding="utf-8")))
    for case in manifest.cases:
        fixture = (path.parent / case.path).resolve()
        if not fixture.is_relative_to(path.parent.resolve()) or not fixture.is_file():
            raise ValueError(f"fixture does not exist inside evals: {case.path}")
    return manifest.model_dump(mode="json")


def _question_view(question: dict[str, Any]) -> dict[str, Any]:
    return {
        "stem": question["stem"], "answerMode": question["answerMode"],
        "options": [{"label": item["label"], "content": item["content"]} for item in question.get("options", [])],
        "answerPayload": question.get("answerPayload"),
    }


def score_document_case(expected: list[dict[str, Any]], predicted: list[dict[str, Any]]) -> dict[str, Any]:
    # ponytail: scan up to 1000 predictions per gold question; index stem queues if profiling warrants it.
    remaining = list(range(len(predicted)))
    rows = []
    for index, gold in enumerate(expected):
        stems = {normalize_stem(stem) for stem in [gold["stem"], *gold.get("stemAliases", [])]}
        actual_index = next((i for i in remaining if normalize_stem(predicted[i]["stem"]) in stems), None)
        actual = predicted[actual_index] if actual_index is not None else None
        expected_view = _question_view(gold)
        actual_view = _question_view(actual) if actual is not None else None
        if actual_index is not None:
            remaining.remove(actual_index)
        correct = {
            field: actual_view is not None and _normalize_json(actual_view[field]) == _normalize_json(expected_view[field])
            for field in ("answerMode", "options", "answerPayload")
        }
        if actual_view is not None:
            correct["answerPayload"] = any(
                _normalize_json(actual_view["answerPayload"]) == _normalize_json(answer)
                for answer in [gold["answerPayload"], *gold.get("answerAliases", [])]
            )
        rows.append({
            "expectedIndex": index, "predictedIndex": actual_index,
            "answerMode": gold["answerMode"], "expected": expected_view, "predicted": actual_view,
            "matched": actual is not None, "correct": correct,
            "inventedAnswer": actual is not None and gold["answerPayload"] is None and actual.get("answerPayload") is not None,
            "differences": ["missing"] if actual is None else [key for key, ok in correct.items() if not ok],
        })
    rows.extend({
        "expectedIndex": None, "predictedIndex": i, "answerMode": predicted[i]["answerMode"],
        "expected": None, "predicted": _question_view(predicted[i]), "matched": False,
        "correct": {}, "inventedAnswer": False, "differences": ["extra"],
    } for i in remaining)
    return {**question_counts(rows), "questions": rows}


def question_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    gold = [row for row in rows if row["expectedIndex"] is not None]
    return {
        "expected": len(gold), "predicted": sum(row["predictedIndex"] is not None for row in rows),
        "matched": sum(row["matched"] for row in gold),
        "modeCorrect": sum(row["correct"]["answerMode"] for row in gold),
        "optionsExpected": sum(row["answerMode"] == "choice" for row in gold),
        "optionsCorrect": sum(row["correct"]["options"] for row in gold if row["answerMode"] == "choice"),
        "answerCorrect": sum(row["correct"]["answerPayload"] for row in gold),
        "inventedAnswers": sum(row["inventedAnswer"] for row in gold),
    }


def _structure_score(expected: list[Any] | None, predicted: list[Any]) -> dict[str, Any] | None:
    if expected is None:
        return None
    gold, actual = Counter(expected), Counter(predicted)
    return {
        "expected": len(expected), "predicted": len(predicted),
        "matched": sum((gold & actual).values()),
        "missing": list((gold - actual).elements()), "extra": list((actual - gold).elements()),
    }


def score_result(case: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    score = score_document_case(case["expectedQuestions"], result.get("questions", []))
    mapping = {row["predictedIndex"]: row["expectedIndex"] for row in score["questions"] if row["matched"]}
    expected_groups = case.get("expectedGroups")
    gold_groups = None if expected_groups is None else [
        (normalize_stem(group["title"]), tuple(sorted(set(group["questionIndexes"])))) for group in expected_groups
    ]
    actual_groups = [
        (normalize_stem(group["title"]), tuple(sorted({mapping.get(i, -i - 1) for i in group["questionIndexes"]})))
        for group in result.get("groups", [])
    ]
    score["groups"] = _structure_score(gold_groups, actual_groups)
    score["visuals"] = _structure_score(case.get("expectedVisualKinds"), [item["kind"] for item in result.get("visualElements", [])])
    return score


def percent(numerator: int, denominator: int) -> float | None:
    return numerator / denominator * 100 if denominator else None


def quality_metrics(scores: list[dict[str, Any]]) -> dict[str, float | None]:
    totals: Counter[str] = Counter()
    for score in scores:
        totals.update({key: value for key, value in score.items() if type(value) is int})
    metrics = {
        "questionPrecision": percent(totals["matched"], totals["predicted"]),
        "questionRecall": percent(totals["matched"], totals["expected"]),
        "answerModeAccuracy": percent(totals["modeCorrect"], totals["expected"]),
        "optionsAccuracy": percent(totals["optionsCorrect"], totals["optionsExpected"]),
        "parsedAnswerAccuracy": percent(totals["answerCorrect"], totals["expected"]),
    }
    for kind, name in (("groups", "groupF1"), ("visuals", "visualF1")):
        structures = [score[kind] for score in scores if score.get(kind) is not None]
        denominator = sum(item["expected"] + item["predicted"] for item in structures)
        metrics[name] = (percent(2 * sum(item["matched"] for item in structures), denominator) if denominator else 100.0) if structures else None
    return metrics


def percentile(values: list[float], value: int) -> float | None:
    if len(values) < 2:
        return values[0] if values else None
    return statistics.quantiles(values, n=100, method="inclusive")[value - 1]


def _error(exc: Exception) -> dict[str, Any]:
    return {
        "type": type(exc).__name__,
        "code": exc.code if isinstance(exc, DocumentProcessingError) else "UNEXPECTED_ERROR",
        "statusCode": exc.status_code if isinstance(exc, DocumentProcessingError) else None,
    }


class EvaluationUsage(BaseCallbackHandler):
    """Observe each physical call, including responses preceding graph failure."""

    run_inline = True

    def __init__(self) -> None:
        self.calls: dict[str, dict[str, Any]] = {}

    def on_chat_model_start(self, serialized: dict[str, Any], messages: Any, *, run_id: UUID, metadata: dict[str, Any] | None = None, **kwargs: Any) -> None:
        self.calls[str(run_id)] = {
            "callId": str(run_id), "node": (metadata or {}).get("langgraph_node"),
            "status": "STARTED", "inputTokens": None, "outputTokens": None,
        }

    def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs: Any) -> None:
        call = self.calls[str(run_id)]
        raw = getattr(response.generations[0][0], "message", None) if response.generations and response.generations[0] else None
        usage = getattr(raw, "usage_metadata", None) or getattr(raw, "response_metadata", {}).get("token_usage") or (response.llm_output or {}).get("token_usage") or {}
        for target, keys in (("inputTokens", ("input_tokens", "prompt_tokens")), ("outputTokens", ("output_tokens", "completion_tokens"))):
            value = usage.get(keys[0], usage.get(keys[1]))
            call[target] = value if type(value) is int and value >= 0 else None
        call["status"] = "RETURNED"

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self.calls[str(run_id)].update(
            status="ERROR", errorType=type(error).__name__, providerFailure=isinstance(error, APIError)
        )


def usage_summary(calls: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "calls": len(calls), "responses": sum(call["status"] == "RETURNED" for call in calls),
        "failedCalls": sum(call["status"] == "ERROR" for call in calls),
        "inputTokens": sum(call["inputTokens"] or 0 for call in calls),
        "outputTokens": sum(call["outputTokens"] or 0 for call in calls),
        "complete": all(call["inputTokens"] is not None and call["outputTokens"] is not None for call in calls),
        "missingUsageCalls": sum(call["inputTokens"] is None or call["outputTokens"] is None for call in calls),
    }


async def prepare_document(case: dict[str, Any], manifest_path: Path) -> dict[str, Any]:
    path = manifest_path.parent / case["path"]
    payload = path.read_bytes()
    request = DocumentUploadRequest(
        sourceType=case["sourceType"], fileName=path.name, mediaType=MEDIA_TYPES[case["sourceType"]],
        sizeBytes=len(payload), sha256=hashlib.sha256(payload).hexdigest(),
    )
    document = await get_object_store().put_document(payload, request)
    return document.model_dump(mode="json")


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()).hexdigest()


def _code_metadata() -> dict[str, Any]:
    paths = sorted([*ROOT.glob("src/**/*.py"), *ROOT.glob("scripts/*.py"), ROOT / "uv.lock", ROOT / "pyproject.toml"])
    hashes = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
    return {
        "gitCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip()),
        "codeHash": _digest(hashes),
    }


def summarize(cases: list[dict[str, Any]]) -> dict[str, Any]:
    positive = [case for case in cases if case["expectedError"] is None]
    scores = [case["score"] for case in positive]
    buckets: dict[str, dict[str, list[dict[str, Any]]]] = {
        "sourceType": defaultdict(list), "answerMode": defaultdict(list), "tag": defaultdict(list),
    }
    for case in cases:
        buckets["sourceType"][case["sourceType"]].append(case["score"])
        for tag in case["tags"]:
            buckets["tag"][tag].append(case["score"])
        for mode in {row["answerMode"] for row in case["score"]["questions"]}:
            rows = [row for row in case["score"]["questions"] if row["answerMode"] == mode]
            buckets["answerMode"][mode].append(question_counts(rows))
    metrics = quality_metrics(scores)
    reasons = [f"BELOW_TARGET:{key}" for key, value in metrics.items() if value is not None and value < 90]
    reasons.extend(f"OUTCOME_MISMATCH:{case['id']}:{case['repetition']}" for case in cases if not case["outcomeMatched"])
    for case in cases:
        score = case["score"]
        if score["inventedAnswers"]:
            reasons.append(f"INVENTED_ANSWER:{case['id']}:{case['repetition']}")
        if case["critical"] and (
            any(row["differences"] for row in score["questions"])
            or any(score.get(kind) and (score[kind]["missing"] or score[kind]["extra"]) for kind in ("groups", "visuals"))
        ):
            reasons.append(f"CRITICAL_CASE_FAILED:{case['id']}:{case['repetition']}")
    blocked = any(case["blocked"] for case in cases)
    calls = [call for case in cases for call in case["modelCalls"]]
    latency = {}
    for label, subset in (
        ("all", cases), ("success", [c for c in cases if c["status"] == "SUCCEEDED"]),
        ("failure", [c for c in cases if c["status"] != "SUCCEEDED"]),
    ):
        values = [c["latencyMs"] for c in subset]
        latency[label] = {"count": len(values), "p50Ms": percentile(values, 50), "p95Ms": percentile(values, 95)}
    return {
        "status": "BLOCKED" if blocked else "FAILED" if reasons else "PASSED",
        "gateReasons": reasons, "documentParser": metrics,
        "outcomes": dict(Counter(case["status"] for case in cases)),
        "slices": {kind: {name: quality_metrics(items) for name, items in sorted(groups.items())} for kind, groups in buckets.items()},
        "latency": latency, "modelUsage": usage_summary(calls),
    }


async def run_evaluation(manifest_path: Path, repetitions: int = 1, case_ids: list[str] | None = None) -> dict[str, Any]:
    if repetitions < 1:
        raise ValueError("repetitions must be positive")
    manifest = load_manifest(manifest_path)
    selected = set(case_ids or [case["id"] for case in manifest["cases"]])
    if selected - {case["id"] for case in manifest["cases"]}:
        raise ValueError("unknown case id")
    cases = [case for case in manifest["cases"] if case["id"] in selected]
    report: dict[str, Any] = {
        "schemaVersion": 2, "kind": "evaluation", "runId": str(uuid4()),
        "generatedAt": datetime.now(UTC).isoformat(), "environment": "local-real-services",
        "scorerVersion": SCORER_VERSION, "repetitions": repetitions,
        "caseIds": [case["id"] for case in cases],
        "datasetHash": _digest({"cases": cases, "files": {case["id"]: hashlib.sha256((manifest_path.parent / case["path"]).read_bytes()).hexdigest() for case in cases}}),
        **_code_metadata(), "models": None, "settings": None, "promptHash": None,
        "cases": [],
    }
    try:
        config = load()
    except ValueError:
        report.update(status="BLOCKED", gateReasons=["CONFIGURATION_ERROR"])
        return report
    from practiq_ai.graphs.document import SYSTEM_PROMPT, build_document_graph
    from practiq_ai.graphs.vision import DESCRIBE_PROMPT, OCR_PROMPT

    report["models"] = {"provider": config.provider, "text": config.text_model, "vision": config.vision_model}
    report["settings"] = {name: getattr(config, name) for name in SETTING_NAMES}
    report["promptHash"] = _digest([SYSTEM_PROMPT, OCR_PROMPT, DESCRIBE_PROMPT])
    graph = build_document_graph(InMemorySaver())
    for repetition in range(1, repetitions + 1):
        for case in cases:
            observer = EvaluationUsage()
            started = time.perf_counter()
            status, result, processing, error = "ERROR", {}, None, None
            runnable_config = cast(RunnableConfig, {
                "configurable": {"thread_id": str(uuid4())}, "run_id": uuid4(), "callbacks": [observer],
            })
            invoked = False
            try:
                reference = await prepare_document(case, manifest_path)
                invoked = True
                output = await graph.ainvoke({"document": reference}, runnable_config)
                result = DocumentParseResult.model_validate(output["result"]).model_dump(mode="json")
                processing = DocumentProcessing.model_validate(output["processing"]).model_dump(mode="json")
                status = output["status"]
            except Exception as exc:  # noqa: BLE001 - retain unexpected per-case failures in the report
                error = _error(exc)
                if isinstance(exc, httpx.HTTPError):
                    error["code"] = "UPLOAD_UNAVAILABLE"
                if invoked:
                    state = (await graph.aget_state(runnable_config)).values
                    chunks = state.get("chunkResults", [])
                    failures = [*state.get("failures", []), *[
                        {"stage": "document_parse", "index": chunk["index"], "code": chunk["failureCode"] or "OUTPUT_INVALID", "retryable": True}
                        for chunk in chunks if chunk["parsed"] is None
                    ]]
                    processing = DocumentProcessing.model_validate({
                        "chunks": {"total": len(state.get("chunkRefs", [])), "succeeded": sum(chunk["parsed"] is not None for chunk in chunks)},
                        "visuals": {"total": state.get("visualTotal", 0), "succeeded": len(state.get("visionResults", [])), "skipped": state.get("visualSkipped", 0)},
                        "truncated": bool(state.get("truncated")), "failures": failures,
                    }).model_dump(mode="json")
            score = score_result(case, result)
            expected_error = case["expectedError"]
            outcome_matched = (
                error is not None and all(error[key] == value for key, value in expected_error.items())
                if expected_error else error is None and status == "SUCCEEDED"
            )
            failure_codes = {item["code"] for item in (processing or {}).get("failures", [])}
            blocked = bool((error and error["code"] in BLOCKING_CODES) or failure_codes.intersection(BLOCKING_CODES))
            report["cases"].append({
                "id": case["id"], "sourceType": case["sourceType"], "tags": case["tags"],
                "critical": case["critical"], "repetition": repetition, "status": status,
                "latencyMs": (time.perf_counter() - started) * 1_000,
                "expectedError": expected_error, "outcomeMatched": outcome_matched,
                "blocked": blocked, "error": error, "processing": processing,
                "score": score, "modelCalls": list(observer.calls.values()),
            })
            print(f"{case['id']} [{repetition}/{repetitions}]: {status}" + (f" {error['code']}" if error else ""), flush=True)
    report.update(summarize(report["cases"]))
    return report


def _validate_comparable(report: dict[str, Any]) -> None:
    if not isinstance(report, dict) or report.get("schemaVersion") != 2 or report.get("kind") != "evaluation" or report.get("environment") != "local-real-services":
        raise ValueError("INCOMPATIBLE_REPORT")
    if report.get("status") not in {"PASSED", "FAILED"}:
        raise ValueError("INCOMPLETE_REPORT")
    if type(report["repetitions"]) is not int or report["repetitions"] < 3:
        raise ValueError("THREE_REPETITIONS_REQUIRED")
    ids = report["caseIds"]
    if not ids or len(set(ids)) != len(ids):
        raise ValueError("INVALID_CASE_IDS")
    expected = Counter((case_id, n) for case_id in ids for n in range(1, report["repetitions"] + 1))
    if Counter((case["id"], case["repetition"]) for case in report["cases"]) != expected:
        raise ValueError("INCOMPLETE_CASES")
    if not re.fullmatch(r"[0-9a-f]{64}", report["datasetHash"]):
        raise ValueError("INVALID_DATASET_HASH")
    if not isinstance(report["scorerVersion"], str) or not report["scorerVersion"]:
        raise ValueError("INVALID_SCORER_VERSION")
    recomputed = summarize(report["cases"])
    if recomputed["documentParser"] != report["documentParser"] or recomputed["status"] == "BLOCKED":
        raise ValueError("INCONSISTENT_REPORT")
    for key in METRICS:
        value = report["documentParser"][key]
        if value is not None and (type(value) not in (float, int) or not isfinite(value) or not 0 <= value <= 100):
            raise ValueError("INVALID_METRIC")
    if report["status"] == "PASSED" and recomputed["status"] != "PASSED":
        raise ValueError("INCONSISTENT_GATE")


def compare_reports(baseline: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"status": "BLOCKED", "gateReasons": [], "metricDeltas": {}}
    try:
        _validate_comparable(baseline)
        _validate_comparable(candidate)
        if baseline["status"] != "PASSED":
            raise ValueError("BASELINE_NOT_PASSED")
        for key in ("datasetHash", "scorerVersion", "repetitions", "caseIds"):
            if baseline[key] != candidate[key]:
                raise ValueError(f"INCOMPATIBLE_{key}")
        deltas = {}
        for key in METRICS:
            before, after = baseline["documentParser"][key], candidate["documentParser"][key]
            if (before is None) != (after is None):
                raise ValueError("INCOMPATIBLE_METRIC_ANNOTATIONS")
            deltas[key] = after - before if before is not None else None
        regressions = [f"REGRESSION:{key}" for key, delta in deltas.items() if delta is not None and delta < 0]
        before_cases = {(c["id"], c["repetition"]): c for c in baseline["cases"]}
        result.update(
            status="FAILED" if candidate["status"] == "FAILED" or regressions else "PASSED",
            gateReasons=[*candidate["gateReasons"], *regressions], metricDeltas=deltas,
            baselineRunId=baseline["runId"], candidateRunId=candidate["runId"],
            changes={key: {"baseline": baseline[key], "candidate": candidate[key]} for key in ("gitCommit", "codeHash", "promptHash", "models", "settings") if baseline[key] != candidate[key]},
            caseDeltas=[{
                "id": c["id"], "repetition": c["repetition"],
                "baselineOutcomeMatched": before_cases[c["id"], c["repetition"]]["outcomeMatched"],
                "candidateOutcomeMatched": c["outcomeMatched"],
                "baselineScore": {k: v for k, v in before_cases[c["id"], c["repetition"]]["score"].items() if type(v) is int},
                "candidateScore": {k: v for k, v in c["score"].items() if type(v) is int},
            } for c in candidate["cases"]],
        )
    except (ValueError, KeyError, TypeError, IndexError) as exc:
        result["gateReasons"] = [str(exc) if isinstance(exc, ValueError) else "MALFORMED_REPORT"]
    return result


def ensure_public_report(value: Any) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key.replace("_", "").casefold() in FORBIDDEN_REPORT_KEYS:
                raise ValueError(f"report contains forbidden field: {key}")
            ensure_public_report(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            ensure_public_report(item)


def _display(value: Any) -> str:
    if value is None:
        return "N/A"
    if isinstance(value, float):
        return f"{value:.2f}"
    return str(value).replace("|", "\\|").replace("\n", " ").replace("<", "&lt;")


def render_markdown(report: dict[str, Any]) -> str:
    lines = ["# document_parser 评测", "", f"状态：**{report['status']}**", "", "## 质量指标", "", "| 指标 | 数值 |", "|---|---:|"]
    lines.extend(f"| {key} | {_display(value)} |" for key, value in report.get("documentParser", {}).items())
    if "modelUsage" in report:
        lines.extend(["", "## 调用与耗时", "", "| 统计 | 数值 |", "|---|---:|"])
        lines.extend(f"| {key} | {_display(value)} |" for key, value in report["modelUsage"].items())
        for kind, values in report["latency"].items():
            lines.extend(f"| {kind}.{key} | {_display(value)} |" for key, value in values.items())
    lines.extend(["", "## 门禁原因", "", *[f"- {_display(reason)}" for reason in report.get("gateReasons", [])]])
    for kind, groups in report.get("slices", {}).items():
        lines.extend(["", f"## 分桶：{kind}", "", "| 分组 | " + " | ".join(METRICS) + " |", "|---|" + "---:|" * len(METRICS)])
        lines.extend("| " + _display(name) + " | " + " | ".join(_display(metrics[key]) for key in METRICS) + " |" for name, metrics in groups.items())
    lines.extend(["", "## 逐次案例", "", "| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |", "|---|---:|---|---|---:|---|"])
    for case in report.get("cases", []):
        differences = [f"q{row['expectedIndex']}: {','.join(row['differences'])}" for row in case["score"]["questions"] if row["differences"]]
        differences.extend(kind for kind in ("groups", "visuals") if case["score"].get(kind) and (case["score"][kind]["missing"] or case["score"][kind]["extra"]))
        if case["error"]:
            differences.append(case["error"]["code"])
        lines.append(f"| {case['id']} | {case['repetition']} | {case['status']} | {case['outcomeMatched']} | {_display(case['latencyMs'])} | {_display('; '.join(differences))} |")
    comparison = report.get("comparison", {})
    if comparison:
        lines.extend(["", "## 基线变化（百分点）", "", "| 指标 | 变化 |", "|---|---:|"])
        lines.extend(f"| {key} | {_display(value)} |" for key, value in comparison.get("metricDeltas", {}).items())
    lines.extend(["", "Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。", "完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。", ""])
    return "\n".join(lines)


def write_report(report: dict[str, Any], output: Path | None = None) -> Path:
    ensure_public_report(report)
    output = output if output is not None else ROOT / "reports" / "evaluations" / str(UUID(report["runId"])) / "report.json"
    markdown = output.with_suffix(".md")
    if output.suffix != ".json" or output.exists() or markdown.exists():
        raise ValueError("output must be a new .json path with no existing Markdown sibling")
    encoded = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    rendered = render_markdown(report)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as stream:
        stream.write(encoded)
    with markdown.open("x", encoding="utf-8") as stream:
        stream.write(rendered)
    return output


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "evals" / "cases.json")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--case", action="append", dest="case_ids")
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--compare", nargs=2, type=Path, metavar=("BASELINE", "CANDIDATE"))
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args(argv)
    if args.repetitions < 1:
        parser.error("--repetitions must be positive")
    if args.compare and (args.baseline or args.case_ids or args.repetitions != 1 or args.validate_only):
        parser.error("--compare cannot be combined with evaluation options")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.validate_only:
            manifest = load_manifest(args.manifest)
            print(f"Validated {len(manifest['cases'])} cases")
            return 0
        if args.compare:
            baseline, candidate = [json.loads(path.read_text(encoding="utf-8")) for path in args.compare]
            comparison = compare_reports(baseline, candidate)
            report = {
                "schemaVersion": 2, "kind": "comparison", "runId": str(uuid4()),
                "generatedAt": datetime.now(UTC).isoformat(), **comparison, "comparison": comparison,
            }
        else:
            report = asyncio.run(run_evaluation(args.manifest, args.repetitions, args.case_ids))
            if args.baseline:
                try:
                    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
                    comparison = compare_reports(baseline, report)
                except (OSError, ValueError):
                    comparison = {"status": "BLOCKED", "gateReasons": ["BASELINE_UNREADABLE"]}
                report["comparison"] = comparison
                report["status"] = comparison["status"]
                report["gateReasons"] = list(dict.fromkeys([*report["gateReasons"], *comparison["gateReasons"]]))
        output = write_report(report, args.output)
    except (OSError, ValueError) as exc:
        print(f"BLOCKED: {type(exc).__name__}; check manifest, input reports and output path")
        return 2
    print(f"{report['status']}: {output}")
    return {"PASSED": 0, "FAILED": 1, "BLOCKED": 2}[report["status"]]


if __name__ == "__main__":
    raise SystemExit(main())
