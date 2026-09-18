import asyncio
import json
import os
import subprocess
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult, LLMResult
from pydantic import Field

from practiq_ai.contracts import (
    DocumentReference,
    DocumentUploadResponse,
    document_source_key,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from practiq_ai.graphs.chunking import split_into_chunks
from scripts import evaluate as ev
from tests.test_workflows import FakeObjectStore


def question(stem: str = "1. What is 2 + 2?") -> dict:
    return {
        "stem": stem, "answerMode": "choice",
        "options": [{"label": "A", "content": "3"}, {"label": "B", "content": "4"}],
        "answerPayload": {"correctOption": "B"},
    }


def gold_case() -> dict:
    return {
        "id": "sample", "sourceType": "text", "path": "source.txt",
        "tags": ["synthetic"], "critical": False,
        "expectedQuestions": [question()], "expectedError": None,
        "expectedGroups": None, "expectedVisualKinds": None,
    }


def case_record(case=None, result=None, status="SUCCEEDED", repetition=1, error=None, blocked=False) -> dict:
    case = case or gold_case()
    result = result if result is not None else {"questions": case["expectedQuestions"]}
    expected_error = case["expectedError"]
    return {
        "id": case["id"], "sourceType": case["sourceType"], "tags": case["tags"],
        "critical": case["critical"], "repetition": repetition, "status": status,
        "expectedError": expected_error,
        "outcomeMatched": (error is not None and all(error[k] == v for k, v in expected_error.items())) if expected_error else status == "SUCCEEDED" and error is None,
        "blocked": blocked, "latencyMs": 1.0, "error": error,
        "score": ev.score_result(case, result), "processing": None, "modelCalls": [],
    }


def report_with(records=None) -> dict:
    records = records if records is not None else [case_record(repetition=n) for n in (1, 2, 3)]
    return {
        "schemaVersion": 2, "kind": "evaluation", "environment": "local-real-services",
        "runId": str(uuid4()), "datasetHash": "a" * 64, "scorerVersion": ev.SCORER_VERSION,
        "repetitions": 3, "caseIds": ["sample"], "gitCommit": "a" * 40,
        "codeHash": "c" * 64, "promptHash": "b" * 64, "models": {}, "settings": {},
        "cases": records, **ev.summarize(records),
    }


def test_manifest_covers_formats_modes_and_every_fixture() -> None:
    manifest = ev.load_manifest(Path("evals/cases.json"))
    cases = manifest["cases"]
    assert {case["sourceType"] for case in cases} == ev.SOURCE_TYPES
    assert {q["answerMode"] for case in cases for q in case["expectedQuestions"]} == ev.ANSWER_MODES
    assert {"chinese", "no-source-answer", "long-stem", "repeated-stem", "chunk-boundary", "no-questions", "corrupt-input"} <= {tag for case in cases for tag in case["tags"]}
    assert {Path("evals", case["path"]).resolve() for case in cases} == {path.resolve() for path in Path("evals/fixtures").rglob("*") if path.is_file()}
    chunks = split_into_chunks(Path("evals/fixtures/text/text-multi-chunk.txt").read_text())
    assert len(chunks) > 1
    assert sum("Which color is named in record two?" in chunk for chunk in chunks) == 2
    duplicate = next(case for case in cases if case["id"] == "text-repeated-stem")
    assert duplicate["expectedQuestions"][0]["stem"] == duplicate["expectedQuestions"][1]["stem"]


@pytest.mark.parametrize("change", [
    lambda m: m["cases"].append(deepcopy(m["cases"][0])),
    lambda m: m["cases"][0].update(path="missing.txt"),
    lambda m: m["cases"][0].update(path="../outside.txt"),
    lambda m: m["cases"][0].update(extra=True),
    lambda m: m["cases"][0].update(expectedQuestions=[]),
    lambda m: m["cases"][0].update(expectedGroups=[{"title": "Bad", "questionIndexes": [10]}]),
    lambda m: m["cases"][0]["expectedQuestions"][0].update(answerPayload={"correctOption": "C"}),
    lambda m: m["cases"][0].update(tags=["x", "x"]),
    lambda m: m["cases"][0].update(expectedQuestions=[], expectedError={"code": "AI_PROVIDER_ERROR", "statusCode": 502}),
])
def test_manifest_rejects_invalid_cases(tmp_path, change) -> None:
    (tmp_path / "source.txt").write_text("source")
    (tmp_path.parent / "outside.txt").write_text("outside")
    manifest = {"schemaVersion": 2, "cases": [gold_case()]}
    change(manifest)
    path = tmp_path / "cases.json"
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        ev.load_manifest(path)


def test_manifest_allows_small_sets_but_not_escaping_symlinks(tmp_path) -> None:
    (tmp_path / "source.txt").write_text("source")
    path = tmp_path / "cases.json"
    path.write_text(json.dumps({"schemaVersion": 2, "cases": [gold_case()]}))
    assert len(ev.load_manifest(path)["cases"]) == 1
    outside = tmp_path.parent / "external-fixture.txt"
    outside.write_text("outside")
    (tmp_path / "source.txt").unlink()
    (tmp_path / "source.txt").symlink_to(outside)
    with pytest.raises(ValueError, match="inside evals"):
        ev.load_manifest(path)


def test_full_stems_aliases_and_repeated_occurrences() -> None:
    q = question("a" * 200 + " first")
    assert ev.score_document_case([q], [question("a" * 200 + " second")])["matched"] == 0
    q["stemAliases"] = ["Equivalent wording"]
    assert ev.score_document_case([q], [question("2. Equivalent wording")])["matched"] == 1
    assert ev.score_document_case([question()], [question("What is 2 + 2?")])["matched"] == 1
    # Chemistry and punctuation are not silently normalized away.
    assert ev.normalize_stem("Na") != ev.normalize_stem("NA")
    assert ev.normalize_stem("x+y") != ev.normalize_stem("x-y")
    second = deepcopy(question())
    second["answerPayload"] = {"correctOption": "A"}
    score = ev.score_document_case([question(), second], [question(), second, question()])
    assert (score["matched"], score["predicted"], score["answerCorrect"]) == (2, 3, 2)
    assert score["questions"][-1]["differences"] == ["extra"]
    reordered = ev.score_document_case([question(), second], [second, question()])
    assert reordered["answerCorrect"] == 0


def test_missing_questions_and_fields_use_gold_denominators() -> None:
    predicted = question()
    predicted.update(answerMode="short_answer", options=[], answerPayload={"text": "5"})
    score = ev.score_document_case([question(), question("another")], [predicted])
    metrics = ev.quality_metrics([score])
    assert metrics["questionRecall"] == 50
    assert metrics["answerModeAccuracy"] == metrics["optionsAccuracy"] == metrics["parsedAnswerAccuracy"] == 0
    assert score["questions"][0]["differences"] == ["answerMode", "options", "answerPayload"]
    assert score["questions"][1]["differences"] == ["missing"]
    assert ev.quality_metrics([])["parsedAnswerAccuracy"] is None
    assert ev.percent(1, 3) == pytest.approx(100 / 3)


def test_missing_source_answer_is_a_hard_failure() -> None:
    case = gold_case()
    case["expectedQuestions"][0]["answerPayload"] = None
    predicted = {"questions": [question()]}
    record = case_record(case, predicted)
    report = ev.summarize([record])
    assert record["score"]["inventedAnswers"] == 1
    assert "INVENTED_ANSWER:sample:1" in report["gateReasons"]
    assert report["status"] == "FAILED"
    assert ev.summarize([case_record(case)])["status"] == "PASSED"


def test_group_membership_and_visual_multisets() -> None:
    case = gold_case()
    case["expectedQuestions"].append(question("another"))
    case["expectedGroups"] = [{"title": "Group", "questionIndexes": [0, 1]}]
    case["expectedVisualKinds"] = ["diagram", "diagram"]
    result = {"questions": case["expectedQuestions"], "groups": [{"title": "Group", "questionIndexes": [0]}], "visualElements": [{"kind": "diagram"}]}
    metrics = ev.quality_metrics([ev.score_result(case, result)])
    assert metrics["groupF1"] == 0
    assert metrics["visualF1"] == pytest.approx(200 / 3)
    result["groups"][0]["questionIndexes"] = [0, 1]
    result["visualElements"].append({"kind": "diagram"})
    assert ev.quality_metrics([ev.score_result(case, result)])["groupF1"] == 100
    assert ev.quality_metrics([ev.score_result(case, result)])["visualF1"] == 100
    case["expectedVisualKinds"] = []
    assert ev.quality_metrics([ev.score_result(case, result)])["visualF1"] == 0
    case["expectedVisualKinds"] = None
    assert ev.quality_metrics([ev.score_result(case, result)])["visualF1"] is None


def test_status_error_and_critical_gates() -> None:
    partial = case_record(status="PARTIAL")
    assert ev.summarize([partial])["status"] == "FAILED"
    assert ev.summarize([partial])["latency"]["failure"]["p95Ms"] == 1
    case = gold_case()
    case.update(expectedQuestions=[], expectedError={"code": "NO_QUESTIONS_FOUND", "statusCode": 422}, critical=True)
    assert ev.summarize([case_record(case, status="ERROR", error=case["expectedError"])])["status"] == "PASSED"
    wrong = {"code": "NO_QUESTIONS_FOUND", "statusCode": 502}
    assert ev.summarize([case_record(case, status="ERROR", error=wrong)])["status"] == "FAILED"
    assert ev.summarize([case_record(status="ERROR", blocked=True)])["status"] == "BLOCKED"
    case = gold_case()
    case["critical"] = True
    record = case_record(case, {"questions": []})
    assert "CRITICAL_CASE_FAILED:sample:1" in ev.summarize([record])["gateReasons"]


def test_usage_records_missing_metadata_errors_and_returned_tokens() -> None:
    observer = ev.EvaluationUsage()
    ids = [uuid4() for _ in range(3)]
    for run_id in ids:
        observer.on_chat_model_start({}, [], run_id=run_id, metadata={"langgraph_node": "chunk"})
    raw = AIMessage(content="", usage_metadata={"input_tokens": 10, "output_tokens": 3, "total_tokens": 13})
    observer.on_llm_end(LLMResult(generations=[[ChatGeneration(message=raw)]]), run_id=ids[0])
    observer.on_llm_end(LLMResult(generations=[[ChatGeneration(message=AIMessage(content=""))]]), run_id=ids[1])
    observer.on_llm_error(RuntimeError("secret must not appear"), run_id=ids[2])
    usage = ev.usage_summary(list(observer.calls.values()))
    assert usage == {"calls": 3, "responses": 2, "failedCalls": 1, "inputTokens": 10, "outputTokens": 3, "complete": False, "missingUsageCalls": 2}
    assert "secret must not appear" not in json.dumps(observer.calls)


def test_comparison_detects_tiny_unrounded_regression() -> None:
    baseline = report_with()
    assert ev.compare_reports(baseline, deepcopy(baseline))["status"] == "PASSED"
    # A one-in-10001 decline must not disappear after display rounding.
    for case in baseline["cases"]:
        case["score"].update(expected=10001, predicted=10001, matched=10001, modeCorrect=10001, optionsExpected=10001, optionsCorrect=10001, answerCorrect=10001)
    baseline.update(ev.summarize(baseline["cases"]))
    candidate = deepcopy(baseline)
    for case in candidate["cases"]:
        case["score"]["answerCorrect"] -= 1
    candidate.update(ev.summarize(candidate["cases"]))
    result = ev.compare_reports(baseline, candidate)
    assert result["status"] == "FAILED"
    assert result["metricDeltas"]["parsedAnswerAccuracy"] < 0
    assert "REGRESSION:parsedAnswerAccuracy" in result["gateReasons"]


@pytest.mark.parametrize("change", [
    lambda r: r.update(schemaVersion=1),
    lambda r: r.update(status="BLOCKED"),
    lambda r: r.update(status="FAILED"),
    lambda r: r.update(datasetHash="b" * 64),
    lambda r: r.update(scorerVersion="other"),
    lambda r: r.update(repetitions=1),
    lambda r: r["cases"].pop(),
    lambda r: r["documentParser"].update(questionRecall=float("nan")),
    lambda r: r.pop("datasetHash"),
])
def test_invalid_or_incomparable_baselines_are_blocked(change) -> None:
    candidate = report_with()
    baseline = deepcopy(candidate)
    change(baseline)
    assert ev.compare_reports(baseline, candidate)["status"] == "BLOCKED"


class CallbackModel(BaseChatModel):
    responses: list[Any]
    tool_name: str = ""
    calls: int = 0
    captured: list[Any] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "evaluation-fake"

    def bind_tools(self, tools, **kwargs):
        self.tool_name = tools[0].__name__
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.calls += 1
        self.captured.append(messages)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        message = AIMessage(content="", tool_calls=[{"name": self.tool_name, "args": item, "id": str(uuid4()), "type": "tool_call"}], usage_metadata={"input_tokens": 10, "output_tokens": 3, "total_tokens": 13})
        return ChatResult(generations=[ChatGeneration(message=message)])


class EvaluationStore(FakeObjectStore):
    async def put_document(self, payload, request):
        return (await self.prepare_document(request)).document

    async def prepare_document(self, request):
        return DocumentUploadResponse(document=DocumentReference(
            objectKey=document_source_key(request.sourceType, request.sha256), sha256=request.sha256,
            mediaType=request.mediaType, sizeBytes=request.sizeBytes, sourceType=request.sourceType,
            fileName=request.fileName,
        ), upload=None)


def setup_runner(tmp_path, monkeypatch, responses):
    payload = b"1. What is 2 + 2?\nA. 3\nB. 4\nAnswer: B\n"
    import hashlib
    digest = hashlib.sha256(payload).hexdigest()
    (tmp_path / "source.txt").write_bytes(payload)
    path = tmp_path / "cases.json"
    path.write_text(json.dumps({"schemaVersion": 2, "cases": [gold_case()]}))
    store = EvaluationStore({document_source_key("text", digest): payload})
    model = CallbackModel(responses=responses)
    monkeypatch.setattr(ev, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_model", lambda: model)
    return path, model


def model_result() -> dict:
    return {"questions": [{**question(), "questionTypeId": "choice", "confidence": 0.9, "needsReview": False, "contentBlocks": [{"partType": "text", "textValue": "question"}]}], "groups": []}


def test_real_graph_runner_with_fake_model_and_store(tmp_path, monkeypatch) -> None:
    path, model = setup_runner(tmp_path, monkeypatch, [model_result()] * 3)
    report = asyncio.run(ev.run_evaluation(path, repetitions=3))
    assert report["status"] == "PASSED"
    assert model.calls == 3
    assert report["modelUsage"]["calls"] == 3
    assert report["modelUsage"]["inputTokens"] == 30
    assert report["modelUsage"]["complete"] is True
    assert report["documentParser"]["parsedAnswerAccuracy"] == 100
    assert report["slices"]["answerMode"]["choice"]["parsedAnswerAccuracy"] == 100
    assert ev.compare_reports(report, report)["status"] == "PASSED"
    encoded = json.dumps(report)
    assert "test-key" not in encoded and "objectKey" not in encoded
    # Input bytes, annotations and selection participate in dataset identity.
    (tmp_path / "source.txt").write_bytes(b"changed")
    later = asyncio.run(ev.run_evaluation(path))
    assert later["datasetHash"] != report["datasetHash"]


def test_runner_preserves_usage_before_later_failure(tmp_path, monkeypatch) -> None:
    path, model = setup_runner(tmp_path, monkeypatch, [{"questions": [{"invalid": True}], "groups": []}, RuntimeError("provider secret")])
    report = asyncio.run(ev.run_evaluation(path))
    assert model.calls == 2
    assert report["status"] == "BLOCKED"
    assert report["modelUsage"]["responses"] == 1
    assert report["modelUsage"]["inputTokens"] == 10
    assert report["modelUsage"]["complete"] is False
    assert "provider secret" not in json.dumps(report)
    assert report["latency"]["failure"]["count"] == 1


def test_runner_handles_expected_error_and_unexpected_error(tmp_path, monkeypatch) -> None:
    path, _ = setup_runner(tmp_path, monkeypatch, [])
    data = json.loads(path.read_text())
    data["cases"][0].update(expectedQuestions=[], expectedError={"code": "NO_QUESTIONS_FOUND", "statusCode": 422})
    path.write_text(json.dumps(data))

    async def reject(*args):
        raise DocumentProcessingError(422, "no questions", "NO_QUESTIONS_FOUND")

    monkeypatch.setattr(ev, "prepare_document", reject)
    assert asyncio.run(ev.run_evaluation(path))["status"] == "PASSED"

    async def bug(*args):
        raise RuntimeError("a bug, not external unavailability")

    monkeypatch.setattr(ev, "prepare_document", bug)
    assert asyncio.run(ev.run_evaluation(path))["status"] == "FAILED"
    monkeypatch.setattr(ev, "load", lambda: (_ for _ in ()).throw(ValueError("missing credential")))
    blocked = asyncio.run(ev.run_evaluation(path))
    assert blocked["status"] == "BLOCKED"
    assert blocked["gateReasons"] == ["CONFIGURATION_ERROR"]


def test_cli_comparison_and_manifest_validation_without_credentials(tmp_path) -> None:
    baseline = report_with()
    paths = [tmp_path / "base.json", tmp_path / "candidate.json"]
    for path in paths:
        path.write_text(json.dumps(baseline))
    environment = {key: value for key, value in os.environ.items() if not key.startswith(("AI_", "LLM_", "LANGSMITH_", "LANGGRAPH_")) and key != "N_JOBS_PER_WORKER"}
    output = tmp_path / "comparison.json"
    command = [sys.executable, str(ev.ROOT / "scripts/evaluate.py")]
    run = subprocess.run([*command, "--compare", *map(str, paths), "--output", str(output)], env=environment, capture_output=True, text=True, check=False)
    assert run.returncode == 0, run.stderr + run.stdout
    assert json.loads(output.read_text())["status"] == "PASSED"
    assert output.with_suffix(".md").is_file()
    run = subprocess.run([*command, "--validate-only"], env=environment, capture_output=True, text=True, check=False)
    assert run.returncode == 0, run.stderr + run.stdout


def test_cli_exit_codes_and_preservation(tmp_path, monkeypatch) -> None:
    async def run(*args):
        return report_with([case_record(status="PARTIAL", repetition=n) for n in (1, 2, 3)])

    monkeypatch.setattr(ev, "run_evaluation", run)
    output = tmp_path / "failed.json"
    assert ev.main(["--output", str(output)]) == 1
    original = output.read_bytes()
    assert ev.main(["--output", str(output)]) == 2
    assert output.read_bytes() == original
    blocked = tmp_path / "blocked.json"
    assert ev.main(["--baseline", str(tmp_path / "missing.json"), "--output", str(blocked)]) == 2
    assert json.loads(blocked.read_text())["cases"]
    with pytest.raises(SystemExit):
        ev.parse_args(["--repetitions", "0"])


def test_public_report_and_markdown(tmp_path) -> None:
    report = report_with()
    assert "N/A" in ev.render_markdown(report)
    for key in ("databaseUrl", "api_key", "objectKey", "headers"):
        with pytest.raises(ValueError, match="forbidden"):
            ev.ensure_public_report({"nested": [{key: "secret"}]})
    output = ev.write_report(report, tmp_path / "report.json")
    assert json.loads(output.read_text())["runId"] == report["runId"]
    assert "逐次案例" in output.with_suffix(".md").read_text()


def test_manual_answer_aliases_are_typed_and_cannot_invent_answers() -> None:
    q = {"stem": "Chemical formula?", "answerMode": "fill_blank", "options": [], "answerPayload": {"answers": ["H2O"]}, "answerAliases": [{"answers": [r"H_2O"]}]}
    ev.GoldQuestion.model_validate(q)
    predicted = {**q, "answerPayload": {"answers": [r"H_2O"]}}
    assert ev.score_document_case([q], [predicted])["answerCorrect"] == 1
    with pytest.raises(ValueError, match="missing source answers"):
        ev.GoldQuestion.model_validate({**q, "answerPayload": None})
    with pytest.raises(ValueError):
        ev.GoldQuestion.model_validate({**q, "answerAliases": [{"text": "H2O"}]})
    case = gold_case()
    case["expectedQuestions"].append({**question("different"), "stemAliases": [question()["stem"]]})
    with pytest.raises(ValueError, match="ambiguous"):
        ev.GoldCase.model_validate(case)


@pytest.mark.parametrize("invalid_after_retry", [False, True])
def test_exhausted_retries_preserve_actual_failure_stage(tmp_path, monkeypatch, invalid_after_retry) -> None:
    import httpx2
    from openai import APITimeoutError

    from practiq_ai import llm

    error = APITimeoutError(request=httpx2.Request("POST", "https://example.invalid"))
    invalid = {"questions": [{"invalid": True}], "groups": []}
    responses = [error, *([invalid] * 3 if invalid_after_retry else [error] * 3)]
    path, model = setup_runner(tmp_path, monkeypatch, responses)
    monkeypatch.setattr(llm, "_retry_delay", lambda attempt: 0)
    report = asyncio.run(ev.run_evaluation(path))
    assert model.calls == (3 if invalid_after_retry else 4)
    expected = "OUTPUT_STALLED" if invalid_after_retry else "AI_PROVIDER_UNAVAILABLE"
    assert report["cases"][0]["processing"]["failures"][0]["code"] == expected
    assert report["status"] == ("FAILED" if invalid_after_retry else "BLOCKED")
    assert report["modelUsage"]["inputTokens"] == (20 if invalid_after_retry else 0)


def test_partial_runner_keeps_processing_failures(tmp_path, monkeypatch) -> None:
    path, _ = setup_runner(tmp_path, monkeypatch, [model_result()])
    original = document._merge

    async def partial(state):
        output = await original(state)
        output["status"] = "PARTIAL"
        output["processing"]["failures"] = [{"stage": "visual_crop", "index": 0, "code": "CROP_FAILED", "retryable": False}]
        return output

    monkeypatch.setattr(document, "_merge", partial)
    report = asyncio.run(ev.run_evaluation(path))
    assert report["status"] == "FAILED"
    assert report["outcomes"] == {"PARTIAL": 1}
    assert report["cases"][0]["processing"]["failures"][0]["code"] == "CROP_FAILED"
    assert report["documentParser"]["parsedAnswerAccuracy"] == 100


def test_malformed_reports_are_blocked() -> None:
    assert ev.compare_reports(cast(Any, []), report_with())["status"] == "BLOCKED"
    assert ev.compare_reports(report_with(), cast(Any, None))["status"] == "BLOCKED"


def test_nullable_draft_fields_are_scored_without_breaking_report(tmp_path):
    draft = {**question('Unmatched draft'), 'stem': None, 'answerMode': None, 'options': [], 'answerPayload': None}
    record = case_record()
    record['score'] = ev.score_result(gold_case(), {'questions': [question(), draft], 'groups': [], 'visualElements': []})
    report = report_with([record])
    assert report['documentParser']['questionPrecision'] == 50
    assert report['slices']['answerMode']['unknown']['questionPrecision'] == 0
    assert record['score']['questions'][-1]['answerMode'] is None
    path = ev.write_report(report, tmp_path / 'report.json')
    assert path.is_file()


def test_no_source_answers_checks_rewritten_and_extra_questions():
    case = {**gold_case(), "sourceHasNoAnswers": True}
    case["expectedQuestions"][0]["answerPayload"] = None
    output = {"questions": [question("Rewritten stem"), question("Invented extra")], "groups": [], "visualElements": []}
    score = ev.score_result(case, output)
    assert score["inventedAnswers"] == 2
    assert score["unverifiedQuestions"] == 2
    record = case_record(case, output)
    report = ev.summarize([record])
    assert report["status"] == "FAILED" and not record["qualityPassed"]
    assert any(reason.startswith("INVENTED_ANSWER:") for reason in report["gateReasons"])
    with pytest.raises(ValueError, match="forbids gold answers"):
        ev.GoldCase.model_validate({**gold_case(), "sourceHasNoAnswers": True})


def test_quality_reliability_counts_documents_and_expected_rejections_separately():
    records = [case_record(repetition=n) for n in (1, 2, 3)]
    records[1]["score"] = ev.score_result(gold_case(), {"questions": []})
    rejected = {**gold_case(), "id": "rejected", "expectedQuestions": [], "expectedError": {"code": "NO_QUESTIONS_FOUND", "statusCode": 422}}
    records.append(case_record(rejected, status="ERROR", error={"code": "NO_QUESTIONS_FOUND", "statusCode": 422}))
    report = ev.summarize(records)
    metrics = report["reliability"]
    assert metrics["normalTrials"] == 3 and metrics["rejectionTrials"] == 1
    assert metrics["executionSuccessRate"] == 100
    assert metrics["qualityPassRate"] == pytest.approx(200 / 3)
    assert metrics["anyRepetitionPassRate"] == 100 and metrics["allRepetitionsPassRate"] == 0
    assert metrics["expectedRejectionRate"] == 100
    assert report["latency"]["failure"]["count"] == 0
    assert ev.summarize([case_record()])["reliability"]["allRepetitionsPassRate"] is None


def test_expected_missing_answer_and_review_are_valid_quality():
    gold = {**question(), "answerPayload": None, "expectedMissingFields": ["answerPayload"], "expectedNeedsReview": True}
    actual = {**question(), "answerPayload": None, "missingFields": ["answerPayload"], "needsReview": True}
    assert not ev.score_document_case([gold], [actual])["questions"][0]["differences"]
    actual["needsReview"] = False
    assert "needsReview" in ev.score_document_case([gold], [actual])["questions"][0]["differences"]


def test_visual_page_is_part_of_identity():
    case = {**gold_case(), "expectedVisuals": [{"kind": "diagram", "page": 0}]}
    predicted = {"questions": [question()], "visualElements": [{"kind": "diagram", "page": 1}]}
    assert ev.quality_metrics([ev.score_result(case, predicted)])["visualF1"] == 0
    predicted["visualElements"][0]["page"] = 0
    assert ev.quality_metrics([ev.score_result(case, predicted)])["visualF1"] == 100


async def test_visual_artifact_reads_verify_checksums_and_decode(monkeypatch):
    from tests.test_workflows import make_image

    store = FakeObjectStore({})
    ref = await store.put_artifact(make_image(), source_sha256="a" * 64, kind="crop", index=0, media_type="image/png")
    monkeypatch.setattr(ev, "get_object_store", lambda: store)
    result = {"visualElements": [{"imageRef": ref.model_dump(mode="json")} ]}
    assert (await ev.check_visual_artifacts(result))[0]["passed"]
    store.blobs[ref.objectKey] = b"x" * ref.sizeBytes
    assert (await ev.check_visual_artifacts(result))[0]["code"] == "DOCUMENT_CHECKSUM_MISMATCH"
    bad = await store.put_artifact(b"not an image", source_sha256="b" * 64, kind="crop", index=0, media_type="image/png")
    result["visualElements"] = [{"imageRef": bad.model_dump(mode="json")}, {}]
    assert [item["code"] for item in await ev.check_visual_artifacts(result)] == ["VISUAL_ARTIFACT_INVALID", "VISUAL_ARTIFACT_MISSING"]


def test_trajectory_ignores_parallel_completion_order_and_rejects_wrong_route():
    events: list[dict[str, Any]] = [{"event": "stage", "stage": stage, "outcome": "success"} for stage in ("prepare", "assemble")]
    events.extend({"event": "model_start", "callKey": str(index), "kind": "document_parse", "schema": "ChunkParseResult", "unitKey": f"document_parse:{index}:0", "attempt": 1} for index in (1, 0))
    events.extend({"event": "model_call", "callKey": str(index), "validation": "passed"} for index in (0, 1))
    assert ev.score_trajectory(gold_case(), events, [], 4)["passed"]
    events[2]["schema"] = "PageParseResult"
    events[3]["attempt"] = 5
    score = ev.score_trajectory(gold_case(), events, [], 1)
    assert {"WRONG_ROUTE_OR_SCHEMA", "UNIT_ATTEMPT_LIMIT", "MODEL_CALL_LIMIT"} <= set(score["reasons"])
    assert "MISSING_PREREQUISITE" in ev.score_trajectory(gold_case(), events[2:], [], 4)["reasons"]
    page = {"event": "page_context", "primaryPage": 1, "contextPages": [0, 3]}
    assert "INVALID_PAGE_CONTEXT" in ev.score_trajectory(gold_case(), [page], [{"callKey": "missing"}], 4)["reasons"]


@pytest.mark.parametrize("failure", ["timeout", "rate_limit"])
def test_transient_probe_recovers_with_trace(tmp_path, monkeypatch, failure):
    import httpx2
    from openai import APITimeoutError, RateLimitError

    from practiq_ai import llm

    request = httpx2.Request("POST", "https://example.invalid")
    error = APITimeoutError(request=request) if failure == "timeout" else RateLimitError("SECRET_EXCEPTION", response=httpx2.Response(429, request=request), body=None)
    path, model = setup_runner(tmp_path, monkeypatch, [error, model_result()])
    monkeypatch.setattr(llm, "_retry_delay", lambda _: 0)
    report = asyncio.run(ev.run_evaluation(path))
    assert report["status"] == "PASSED" and model.calls == 2
    case = report["cases"][0]
    assert case["qualityPassed"] and case["trajectory"]["passed"]
    assert case["trajectory"]["validatedResponses"] == 1
    assert [c["validation"] for c in case["modelCalls"]] == ["not_run", "passed"]
    assert any(e.get("decision") == "retry" for e in case["trajectory"]["events"])
    assert report["efficiency"]["inputTokensPerQualityDocument"] is None
    assert report["efficiency"]["costPerQualityDocument"] is None
    assert report["modelUsage"]["missingUsageCalls"] == 1
    assert "SECRET_EXCEPTION" not in json.dumps(report)


def test_failed_validation_is_distinct_from_returned_response(tmp_path, monkeypatch):
    path, _ = setup_runner(tmp_path, monkeypatch, [{"invalid": True}, model_result()])
    report = asyncio.run(ev.run_evaluation(path))
    assert report["status"] == "PASSED"
    assert [c["status"] for c in report["cases"][0]["modelCalls"]] == ["RETURNED", "RETURNED"]
    assert [c["validation"] for c in report["cases"][0]["modelCalls"]] == ["failed", "passed"]
    assert report["efficiency"]["inputTokensPerQualityDocument"] == 20
    assert report["stageLatency"]["chunk"]["count"] == 1


def test_probe_reports_block_missing_skipped_or_stale_evidence(tmp_path):
    from xml.etree import ElementTree as ET

    root = ET.Element("testsuites")
    suite = ET.SubElement(root, "testsuite")
    prop = ET.SubElement(ET.SubElement(suite, "properties"), "property", name="practiqProbeFingerprint", value=ev.probe_fingerprint())
    for modules in ev.PROBE_TESTS.values():
        for module, names in modules.items():
            for name in names:
                ET.SubElement(suite, "testcase", classname=f"tests.{module}", name=name)
    path = tmp_path / "probes.xml"
    def save():
        ET.ElementTree(root).write(path)
    save()
    assert ev.score_probes(path)["status"] == "PASSED"
    assert ev.main(["--probes", str(path), "--output", str(tmp_path / "probes.json")]) == 0
    testcase = suite.findall("testcase")[0]
    failure = ET.SubElement(testcase, "failure")
    save()
    assert ev.score_probes(path)["status"] == "FAILED"
    testcase.remove(failure)
    ET.SubElement(testcase, "skipped")
    save()
    assert ev.score_probes(path)["status"] == "BLOCKED"
    suite.remove(testcase)
    prop.set("value", "old")
    save()
    assert "PROBE_FINGERPRINT_MISMATCH" in ev.score_probes(path)["gateReasons"]


def test_sensitive_strings_and_old_scorers_cannot_be_published_or_compared():
    for text in ("data:image/png;base64,PRIVATE", "https://example.invalid/file?x-oss-signature=PRIVATE", "Bearer PRIVATE_TOKEN"):
        with pytest.raises(ValueError, match="credential-bearing"):
            ev.ensure_public_report({"description": text})
    old = report_with()
    old["scorerVersion"] = "2.0.0"
    assert ev.compare_reports(old, report_with())["status"] == "BLOCKED"
