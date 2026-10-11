"""Source-bound collaboration, bounded repairs, receipts and saved provenance."""

import asyncio
import json
from copy import deepcopy
from uuid import uuid4

import pytest
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.runtime import Runtime

from practiq_ai import execution, llm
from practiq_ai.config import load
from practiq_ai.contracts import ArtifactReference, ModelCallUsage
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document, review
from tests.support import (
    FakeModel,
    make_image,
    parsed,
    question,
    run_config,
    setup_graph,
)


def issue(**changes):
    return {"questionIndex": 0, "code": "stem", "evidence": "First", "instruction": "Keep the literal stem", "repairable": True, **changes}


async def collaborate(responses, *, original=None, source_text="First", schema=document.ChunkParseResult):
    model = FakeModel(responses=responses)
    original = schema.model_validate(original or parsed())
    result, usage, audit = await review.review_extraction(
        model, [SystemMessage(content="Extract faithfully"), HumanMessage(content=source_text or "PRIMARY image")],
        original, schema, source_text=source_text, runtime=Runtime(),
    )
    return result, usage, audit, model


async def test_review_is_independent_and_does_not_clear_existing_flags():
    original = parsed()
    original["questions"][0]["missingFields"] = ["media"]
    result, usage, audit, model = await collaborate([{"issues": []}], original=original)
    assert result.questions[0].needsReview and "media" in result.questions[0].missingFields
    assert audit["status"] == "no_discrepancy" and audit["original"]["questions"][0]["stem"] == "First"
    assert [call.callKind for call in usage] == ["import_review"]
    assert model.calls[0][0].content == review.REVIEW_PROMPT
    assert "Extract faithfully" not in str(model.calls[0])
    assert "PRIMARY" in review.REVIEW_PROMPT and "Never solve" in review.REVIEW_PROMPT


async def test_one_repair_requires_clean_recheck_and_keeps_original_and_flags():
    corrected = parsed("Corrected")
    corrected["questions"][0]["sourceText"] = "First"
    original = parsed()
    original["questions"][0]["missingFields"] = ["media"]
    result, usage, audit, model = await collaborate([{"issues": [issue()]}, corrected, {"issues": []}], original=original)
    assert result.questions[0].stem == "Corrected" and result.questions[0].needsReview
    assert "media" in result.questions[0].missingFields
    assert audit["status"] == "repaired" and audit["original"]["questions"][0]["stem"] == "First"
    assert audit["proposed"]["questions"][0]["stem"] == "Corrected"
    assert [call.callKind for call in usage] == ["import_review", "import_repair", "import_recheck"]
    assert len(model.calls) == 3


@pytest.mark.parametrize("change", [
    {"questionIndex": 5}, {"evidence": "invented quote"}, {"evidence": " "},
    {"instruction": " "}, {"code": "uncertain", "repairable": True},
    {"questionIndex": None}, {"code": "missing_question"},
])
async def test_invalid_review_is_unreviewed_and_never_triggers_repair(change):
    result, usage, audit, model = await collaborate([{"issues": [issue(**change)]}])
    assert audit["status"] == "unreviewed" and audit["failureCode"] == "OUTPUT_INVALID"
    assert audit["rejectedReport"] and result.questions[0].needsReview
    assert len(model.calls) == len(usage) == 1


async def test_uncertain_source_is_not_solved_or_repaired():
    result, _, audit, model = await collaborate([{"issues": [issue(code="uncertain", repairable=False)]}])
    assert audit["status"] == "issues" and result.questions[0].answerPayload is None
    assert len(model.calls) == 1


@pytest.mark.parametrize("damage", ["drop", "id", "parent", "source"])
async def test_repair_cannot_drop_or_reidentify_existing_questions(damage):
    corrected = parsed()
    if damage == "drop":
        corrected["questions"] = []
    elif damage == "id":
        corrected["questions"][0]["id"] = "new-id"
    elif damage == "parent":
        corrected["questions"][0]["parentId"] = "another-parent"
    else:
        corrected["questions"][0]["sourceText"] = "another question"
    result, _, audit, model = await collaborate([{"issues": [issue()]}, corrected])
    assert audit["status"] == "repair_rejected" and audit["failureCode"] == "OUTPUT_INVALID"
    assert result.questions[0].stem == "First" and result.questions[0].id is None
    assert len(model.calls) == 2


@pytest.mark.parametrize("key", ["groups", "figures"])
@pytest.mark.parametrize("damage", ["drop", "retarget", "content", "append"])
async def test_repair_preserves_unrelated_groups_and_figures(key, damage):
    original = {**parsed(), "figures": []}
    original["questions"].append(question("Second"))
    entry = {"title": "Material", "questionIndexes": [0]}
    if key == "figures":
        entry = {"description": "Material", "bbox": [0.1, 0.1, 0.8, 0.8], "questionIndexes": [0]}
    original[key] = [entry]
    corrected = deepcopy(original)
    if damage == "drop":
        corrected[key] = []
    elif damage == "retarget":
        corrected[key][0]["questionIndexes"] = [1]
    elif damage == "content":
        corrected[key][0]["title" if key == "groups" else "description"] = "Changed material"
    else:
        corrected[key].append({**entry, "questionIndexes": [1]})
    result, _, audit, model = await collaborate([{"issues": [issue()]}, corrected], original=original, schema=document.PageParseResult)
    assert audit["status"] == "repair_rejected" and audit["failureCode"] == "OUTPUT_INVALID"
    assert result.model_dump(mode="json")[key] == audit["original"][key]
    assert len(model.calls) == 2


@pytest.mark.parametrize("owners,accepted", [([0], True), ([0, 1], False), ([], False)])
async def test_association_repair_requires_findings_for_all_material_owners(owners, accepted):
    original = parsed()
    original["questions"].append(question("Second"))
    original["groups"] = [{"title": "Material", "questionIndexes": owners}]
    corrected = deepcopy(original)
    corrected["groups"][0]["title"] = "Corrected material"
    result, _, audit, model = await collaborate([
        {"issues": [issue(code="association")]}, corrected, {"issues": []},
    ], original=original)
    assert audit["status"] == ("repaired" if accepted else "repair_rejected")
    assert result.groups[0].title == ("Corrected material" if accepted else "Material")
    assert len(model.calls) == (3 if accepted else 2)


async def test_repair_cannot_append_questions_without_a_missing_question_finding():
    corrected = parsed()
    corrected["questions"].append(question("Second"))
    result, _, audit, model = await collaborate([{"issues": [issue()]}, corrected])
    assert audit["status"] == "repair_rejected" and len(result.questions) == 1
    assert len(model.calls) == 2


@pytest.mark.parametrize("index", [0, 1])
@pytest.mark.parametrize("field,value", [
    ("answerPayload", {"text": "Unsupported answer"}), ("analysis", "Unsupported analysis"),
    ("sourceScore", 2.0), ("scoringRubric", "Unsupported rubric"), ("scoreSourceText", "2 points"),
    ("options", [{"label": "A", "content": "Changed A"}, {"label": "B", "content": "Changed B"}]),
])
async def test_stem_finding_cannot_modify_other_fields_or_questions(index, field, value):
    original = parsed()
    original["questions"].append(question("Second"))
    if field == "options":
        original["questions"][index]["answerMode"] = "choice"
        original["questions"][index]["options"] = [{"label": "A", "content": "A"}, {"label": "B", "content": "B"}]
    corrected = deepcopy(original)
    corrected["questions"][index][field] = value
    result, _, audit, model = await collaborate([{"issues": [issue()]}, corrected, {"issues": []}], original=original)
    assert audit["status"] == "repair_rejected" and audit["failureCode"] == "OUTPUT_INVALID"
    assert result.model_dump(mode="json")["questions"][index][field] == audit["original"]["questions"][index][field]
    assert len(model.calls) == 2


async def test_stem_finding_cannot_rewrite_another_question_stem():
    original = parsed()
    original["questions"].append(question("Second"))
    corrected = deepcopy(original)
    corrected["questions"][1]["stem"] = "Unreported change"
    result, _, audit, _ = await collaborate([{"issues": [issue()]}, corrected], original=original)
    assert audit["status"] == "repair_rejected" and result.questions[1].stem == "Second"


@pytest.mark.parametrize("code,field,value", [
    ("stem", "stem", "Corrected"), ("options", "options", [{"label": "A", "content": "Corrected A"}, {"label": "B", "content": "Corrected B"}]),
    ("answer", "answerPayload", {"text": "Supplied answer"}), ("analysis", "analysis", "Supplied explanation"),
    ("association", "optionSourceId", "supplied-parent"),
])
async def test_source_evidenced_findings_can_correct_their_authorized_fields(code, field, value):
    original = parsed()
    if code in {"options", "association"}:
        original["questions"][0]["answerMode"] = "choice"
    corrected = deepcopy(original)
    corrected["questions"][0][field] = value
    result, _, audit, model = await collaborate([
        {"issues": [issue(code=code)]}, corrected, {"issues": []},
    ], original=original)
    assert audit["status"] == "repaired" and len(model.calls) == 3
    assert result.model_dump(mode="json")["questions"][0][field] == value


@pytest.mark.parametrize("value,accepted", [(None, True), ({"text": "Different unsupported answer"}, False)])
async def test_invented_content_finding_can_remove_but_not_replace_content(value, accepted):
    original = parsed()
    original["questions"][0]["answerPayload"] = {"text": "Invented answer"}
    corrected = deepcopy(original)
    corrected["questions"][0]["answerPayload"] = value
    result, _, audit, _ = await collaborate([
        {"issues": [issue(code="invented_content")]}, corrected, {"issues": []},
    ], original=original)
    assert audit["status"] == ("repaired" if accepted else "repair_rejected")
    assert result.model_dump(mode="json")["questions"][0]["answerPayload"] == (None if accepted else original["questions"][0]["answerPayload"])


async def test_missing_question_repair_without_added_content_remains_partial(monkeypatch):
    monkeypatch.setenv("AI_IMPORT_REVIEW", "true")
    graph, _, _, reference, model = setup_graph(monkeypatch, [
        parsed(), {"issues": [issue(questionIndex=None, code="missing_question", evidence="Second")]},
        parsed(), {"issues": []},
    ])
    result = await graph.ainvoke({"document": reference}, run_config())
    assert result["status"] == "PARTIAL" and "questions" in result["result"]["missingFields"]
    assert len(result["result"]["questions"]) == 1 and len(model.calls) == 3
    assert any("repair_rejected (OUTPUT_INVALID)" in warning for warning in result["result"]["warnings"])


@pytest.mark.parametrize("field,value", [("optionSourceId", "new-parent"), ("audioStartSeconds", 10)])
async def test_repair_cannot_rewire_question_relationships_without_association_finding(field, value):
    original = parsed()
    if field == "optionSourceId":
        original["questions"][0]["answerMode"] = "choice"
    else:
        original["questions"][0]["answerMode"] = "listening"
    corrected = deepcopy(original)
    corrected["questions"][0][field] = value
    result, _, audit, _ = await collaborate([{"issues": [issue()]}, corrected], original=original)
    assert audit["status"] == "repair_rejected"
    assert result.model_dump(mode="json")["questions"][0][field] == audit["original"]["questions"][0][field]


@pytest.mark.parametrize("field", ["passage", "contentBlocks", "answerBlock"])
async def test_repair_preserves_existing_question_material(field):
    original = parsed()
    if field == "passage":
        original["questions"][0]["answerMode"] = "reading"
        original["questions"][0][field] = [{"partType": "text", "textValue": "Shared material"}, {"partType": "blank", "questionId": "child"}]
    elif field == "contentBlocks":
        original["questions"][0][field].append({"partType": "table", "markdownValue": "| A | B |"})
    else:
        field = "contentBlocks"
        original["questions"][0][field].append({"partType": "text", "role": "answer", "textValue": "Supplied answer"})
    corrected = deepcopy(original)
    corrected["questions"][0][field] = []
    result, _, audit, _ = await collaborate([{"issues": [issue()]}, corrected], original=original)
    assert audit["status"] == "repair_rejected"
    assert result.model_dump(mode="json")["questions"][0][field] == audit["original"]["questions"][0][field]


async def test_disputed_repair_retains_original_without_a_second_repair():
    corrected = parsed("Wrong")
    corrected["questions"][0]["sourceText"] = "First"
    result, usage, audit, model = await collaborate([{"issues": [issue()]}, corrected, {"issues": [issue()]}])
    assert result.questions[0].stem == "First" and audit["status"] == "repair_rejected"
    assert len(model.calls) == len(usage) == 3 and len(audit["reports"]) == 2


@pytest.mark.parametrize("stage", ["import_review", "import_repair", "import_recheck"])
async def test_call_failures_preserve_original_usage_and_review_flags(monkeypatch, stage):
    calls = []
    async def call(model, messages, schema, kind, **kwargs):
        calls.append(kind)
        usage = [ModelCallUsage(callKey=uuid4(), modelId="fake", inputTokens=10, outputTokens=5, callKind=kind)]
        if kind == stage:
            return None, usage, "MODEL_BUDGET_EXCEEDED"
        value = {"issues": [issue()]} if schema is review.ReviewReport else parsed()
        return schema.model_validate(value), usage, None
    monkeypatch.setattr(review, "structured_call", call)
    result, usage, audit, _ = await collaborate([])
    assert audit["failureCode"] == "MODEL_BUDGET_EXCEEDED" and result.questions[0].needsReview
    assert result.questions[0].stem == "First"
    assert [item.callKind for item in usage] == calls
    assert audit["status"] == ("unreviewed" if stage == "import_review" else "issues" if stage == "import_repair" else "repair_rejected")


async def test_review_does_not_swallow_store_failures_or_cancellation(monkeypatch):
    async def fail(*args, **kwargs):
        raise DocumentProcessingError(503, "Store unavailable", "EXECUTION_STORE_UNAVAILABLE")
    monkeypatch.setattr(review, "structured_call", fail)
    with pytest.raises(DocumentProcessingError, match="Store unavailable"):
        await collaborate([])
    async def cancel(*args, **kwargs):
        raise asyncio.CancelledError
    monkeypatch.setattr(review, "structured_call", cancel)
    with pytest.raises(asyncio.CancelledError):
        await collaborate([])


@pytest.mark.parametrize("code", ["EXECUTION_STORE_REQUIRED", "RUN_DEADLINE_EXCEEDED", "INVALID_CONTROL", "EXECUTION_VERSION_MISMATCH", "TASK_EXPIRED", "STALE_CHECKPOINT", "REQUEST_CONFLICT", "CONTROL_ALREADY_EXECUTED"])
async def test_review_propagates_execution_and_control_errors(monkeypatch, code):
    async def fail(*args, **kwargs):
        raise DocumentProcessingError(409, "Stop review", code)
    monkeypatch.setattr(review, "structured_call", fail)
    with pytest.raises(DocumentProcessingError) as error:
        await collaborate([])
    assert error.value.code == code


@pytest.mark.parametrize("stage", ["import_review", "import_repair", "import_recheck"])
@pytest.mark.parametrize("code", ["AI_USAGE_MISSING", "AI_USAGE_INVALID"])
async def test_accounting_errors_preserve_extraction_unknown_receipt_and_replay(monkeypatch, stage, code):
    monkeypatch.setenv("AI_IMPORT_REVIEW", "true")
    corrected = parsed("Corrected")
    corrected["questions"][0]["sourceText"] = "First"
    graph, store, files, reference, model = setup_graph(monkeypatch, [
        parsed(), {"issues": [issue()]}, corrected, {"issues": []},
    ])
    account = llm.usage_from_response
    def usage(model, raw, kind, runtime, attempt):
        if kind == stage:
            raise DocumentProcessingError(502, "Unknown model usage", code)
        return account(model, raw, kind, runtime, attempt)
    monkeypatch.setattr(llm, "usage_from_response", usage)
    put = files.put_artifact
    fail_write = True
    async def write(payload, **kwargs):
        if fail_write and kwargs["kind"] == "unit-result":
            raise OSError("Synthetic audit write failure")
        return await put(payload, **kwargs)
    monkeypatch.setattr(files, "put_artifact", write)
    config = run_config()
    with pytest.raises(OSError, match="Synthetic audit write failure"):
        await graph.ainvoke({"document": reference}, config)
    calls = len(model.calls)
    fail_write = False
    result = await graph.ainvoke(None, {**config, "run_id": uuid4()})
    assert result["status"] == "SUCCEEDED" and len(model.calls) == calls
    assert result["result"]["questions"][0]["stem"] == "First"
    assert result["result"]["questions"][0]["needsReview"]
    assert any(code in warning for warning in result["result"]["warnings"])
    receipts = await store.asearch(execution.namespace("thread-1", "calls"))
    unknown = [receipt.value for receipt in receipts if receipt.value["callKind"] == stage]
    assert len(unknown) == 1 and unknown[0]["usageStatus"] == "unknown" and unknown[0]["error"] == code
    assert len(result["usage"]) == calls - 1


async def test_raised_review_error_preserves_preceding_known_usage(monkeypatch):
    known = ModelCallUsage(callKey=uuid4(), modelId="fake", inputTokens=10, outputTokens=5, callKind="import_review")
    async def fail(*args, **kwargs):
        raise DocumentProcessingError(502, "Unknown usage on correction", "AI_USAGE_MISSING", [known])
    monkeypatch.setattr(review, "structured_call", fail)
    result, usage, audit, _ = await collaborate([])
    assert usage == [known] and audit["failureCode"] == "AI_USAGE_MISSING" and result.questions[0].stem == "First"


async def test_review_can_append_a_source_evidenced_missing_question():
    corrected = parsed()
    corrected["questions"].append(question("Second"))
    corrected["groups"].append({"title": "New question material", "questionIndexes": [1]})
    result, _, audit, _ = await collaborate([
        {"issues": [issue(questionIndex=None, code="missing_question", evidence="Second")]},
        corrected, {"issues": []},
    ], source_text="First\nSecond")
    assert len(result.questions) == 2 and audit["status"] == "repaired" and not audit["missingQuestions"]
    assert result.groups[0].questionIndexes == [1]


async def test_graph_persists_audit_outside_checkpoint_and_reuses_successes(monkeypatch):
    monkeypatch.setenv("AI_IMPORT_REVIEW", "true")
    graph, store, files, reference, model = setup_graph(monkeypatch, [parsed(), {"issues": []}])
    config = run_config()
    result = await graph.ainvoke({"document": reference}, config)
    assert result["status"] == "SUCCEEDED" and len(model.calls) == 2
    assert [item["callKind"] for item in result["usage"]] == ["document_parse", "import_review"]
    state = (await graph.aget_state(config)).values
    unit = state["chunkResults"][0]
    assert unit["parsed"] == {"questionCount": 1} and "original" not in unit["agentReview"]
    audit = json.loads(await files.get_verified(ArtifactReference.model_validate(unit["resultRef"])))
    assert audit["agentReview"]["original"]["questions"][0]["stem"] == "First"
    assert state["reservedCalls"] == 16
    assert any("no_discrepancy" in warning for warning in result["result"]["warnings"])
    await graph.ainvoke(None, {**config, "run_id": uuid4()})
    assert len(model.calls) == 2
    receipts = await store.asearch(execution.namespace("thread-1", "calls"))
    assert len(receipts) == 2


@pytest.mark.parametrize("accepted", [True, False])
async def test_saved_result_reports_addressed_findings_or_disputed_recheck(monkeypatch, accepted):
    monkeypatch.setenv("AI_IMPORT_REVIEW", "true")
    initial = issue(instruction="Restore the supplied stem")
    disputed = issue(code="analysis", evidence="Second", instruction="Keep the supplied explanation")
    corrected = parsed("Corrected")
    corrected["questions"][0]["sourceText"] = "First"
    graph, _, _, reference, model = setup_graph(monkeypatch, [
        parsed(), {"issues": [initial]}, corrected, {"issues": [] if accepted else [disputed]},
    ])
    config = run_config()
    result = await graph.ainvoke({"document": reference}, config)
    expected, excluded = (initial, disputed) if accepted else (disputed, initial)
    warning = next(value for value in result["result"]["warnings"] if value.startswith("AI source review"))
    assert ("repaired" if accepted else "repair_rejected") in warning
    assert f"{expected['code']}: {expected['instruction']} (source: {expected['evidence']})" in warning
    assert excluded["instruction"] not in warning
    assert result["result"]["questions"][0]["stem"] == ("Corrected" if accepted else "First")
    state = (await graph.aget_state(config)).values
    loaded = await document.load_unit_result(state["chunkResults"][0], reference["sha256"])
    assert loaded["agentReview"]["reports"][0]["issues"] == [initial]
    assert loaded["agentReview"]["reports"][1]["issues"] == ([] if accepted else [disputed])
    saved = await graph.ainvoke(None, {**config, "run_id": uuid4()})
    assert warning in saved["result"]["warnings"] and len(model.calls) == 4


async def test_exhausted_review_budget_keeps_extract_but_never_claims_review_success(monkeypatch):
    monkeypatch.setenv("AI_IMPORT_REVIEW", "true")
    monkeypatch.setenv("AI_TASK_MAX_MODEL_CALLS", "1")
    graph, _, _, reference, model = setup_graph(monkeypatch, [parsed()])
    result = await graph.ainvoke({"document": reference}, run_config())
    assert len(model.calls) == 1 and result["result"]["questions"][0]["needsReview"]
    assert any("unreviewed (MODEL_BUDGET_EXCEEDED)" in warning for warning in result["result"]["warnings"])


async def test_unresolved_missing_question_is_partial_with_source_warning(monkeypatch):
    monkeypatch.setenv("AI_IMPORT_REVIEW", "true")
    graph, _, _, reference, model = setup_graph(monkeypatch, [parsed(), {"issues": [issue(
        questionIndex=None, code="missing_question", evidence="Second", repairable=False,
    )]}])
    result = await graph.ainvoke({"document": reference}, run_config())
    assert result["status"] == "PARTIAL" and "questions" in result["result"]["missingFields"]
    assert any("missing_question" in warning and "Second" in warning for warning in result["result"]["warnings"])
    assert len(model.calls) == 2


async def test_visual_extraction_gets_independent_source_review(monkeypatch):
    monkeypatch.setenv("AI_IMPORT_REVIEW", "true")
    model = FakeModel(responses=[{**parsed(), "figures": []}, {"issues": []}])
    monkeypatch.setattr(document, "get_model", lambda: model)
    async def image(*args, **kwargs):
        return make_image(), "data:image/png;base64,synthetic"
    monkeypatch.setattr(document, "_page_image", image)
    monkeypatch.setattr(document, "get_object_store", lambda: object())
    artifact = ArtifactReference(objectKey="page.png", sha256="a" * 64, mediaType="image/png", sizeBytes=1)
    result = await document._vision({"kind": "page", "index": 0, "artifact": artifact.model_dump(mode="json")}, Runtime())
    assert result["visionResults"][0]["agentReview"]["status"] == "no_discrepancy"
    assert [item["callKind"] for item in result["usage"]] == ["vision_parse", "import_review"]
    assert any(isinstance(message.content, list) for message in model.calls[1])


async def test_unit_storage_failure_replays_durable_extraction_and_review_receipts(monkeypatch):
    monkeypatch.setenv("AI_IMPORT_REVIEW", "true")
    graph, _, files, reference, model = setup_graph(monkeypatch, [parsed(), {"issues": []}])
    put = files.put_artifact
    fail = True
    async def write(payload, **kwargs):
        if fail and kwargs["kind"] == "unit-result":
            raise OSError("Synthetic audit write failure")
        return await put(payload, **kwargs)
    monkeypatch.setattr(files, "put_artifact", write)
    config = run_config()
    with pytest.raises(OSError, match="Synthetic audit write failure"):
        await graph.ainvoke({"document": reference}, config)
    assert len(model.calls) == 2
    fail = False
    result = await graph.ainvoke(None, {**config, "run_id": uuid4()})
    assert result["status"] == "SUCCEEDED" and len(model.calls) == 2
    assert len(result["usage"]) == 2
    unit = (await graph.aget_state(config)).values["chunkResults"][0]
    loaded = await document.load_unit_result(unit, reference["sha256"])
    assert loaded["agentReview"]["status"] == "no_discrepancy"


@pytest.mark.parametrize("value,enabled", [("true", True), ("false", False), (" TRUE ", True)])
def test_review_setting_is_trusted_and_validated(monkeypatch, value, enabled):
    monkeypatch.setenv("AI_IMPORT_REVIEW", value)
    monkeypatch.setenv("AI_READ_ONLY", "1")
    assert load().import_review is enabled
    monkeypatch.setenv("AI_IMPORT_REVIEW", "1")
    with pytest.raises(ValueError, match="AI_IMPORT_REVIEW"):
        load()
