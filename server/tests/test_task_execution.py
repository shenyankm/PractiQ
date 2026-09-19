import asyncio
from collections import Counter
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from practiq_ai import execution, llm
from practiq_ai.contracts import FailedUnit, RetryUnits
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document
from tests.support import (
    FakeModel,
    local_graph,
    make_image,
    parsed,
    run_config,
    setup_graph,
)


@pytest.mark.parametrize("all_failed", [False, True])
async def test_retry_failed_units_preserves_successes_and_replaces_failures(monkeypatch, all_failed):
    graph, _, _, reference, model = setup_graph(monkeypatch, [parsed()] * 4, parts=["a", "b"])
    calls = Counter()
    failed = True
    original = document._chunk

    async def chunk(state, runtime):
        calls[state["index"]] += 1
        if failed and (all_failed or state["index"] == 1):
            return {"chunkResults": [{"index": state["index"], "parsed": None, "failureCode": "OUTPUT_INVALID"}], "usage": []}
        return await original(state, runtime)

    monkeypatch.setattr(document, "_chunk", chunk)
    graph = local_graph(InMemorySaver())
    config = run_config()
    if all_failed:
        with pytest.raises(DocumentProcessingError, match="All document fragments"):
            await graph.ainvoke({"document": reference}, config)
        with pytest.raises(DocumentProcessingError, match="All document fragments"):
            await graph.ainvoke(None, config)
    else:
        result = await graph.ainvoke({"document": reference}, config)
        assert result["status"] == "PARTIAL"
        assert (await graph.ainvoke(None, config))["status"] == "PARTIAL"
    assert calls == Counter({0: 1, 1: 1})
    failed = False
    retry = {"requestId": str(uuid4()), "units": []}
    output = await graph.ainvoke({"document": reference, "retry": retry}, config)
    assert output["status"] == "SUCCEEDED"
    assert output["processing"]["failures"] == []
    assert calls == Counter({0: 2 if all_failed else 1, 1: 2})
    assert len(output["usage"]) == len(model.calls)
    with pytest.raises(DocumentProcessingError, match="Retry already applied"):
        await graph.ainvoke({"document": reference, "retry": retry}, config)


async def test_pause_between_attempts_reuses_corrections_and_budget(monkeypatch):
    graph, store, _, reference, model = setup_graph(monkeypatch, [{"questions": [{"stem": "", "confidence": -i}]} for i in range(1, 5)])
    original = llm.structured_attempt
    config = run_config()
    once = True

    async def attempt(*args, **kwargs):
        nonlocal once
        result = await original(*args, **kwargs)
        if once:
            once = False
            await store.aput(execution.namespace("thread-1", "pause"), str(config.get("run_id")), {"requested": True})
        return result

    monkeypatch.setattr(llm, "structured_attempt", attempt)
    result = await graph.ainvoke({"document": reference}, config)
    assert result["__interrupt__"]
    assert len(model.calls) == 1
    resume = Command(resume={item.id: {"action": "resume"} for item in result["__interrupt__"]})
    with pytest.raises(DocumentProcessingError, match="All document fragments"):
        await graph.ainvoke(resume, {**config, "run_id": uuid4()})
    assert len(model.calls) == 4
    assert "failed validation" in model.calls[1][-1].text
    state = await graph.aget_state(config)
    assert len(state.values["usage"]) == 4
    records = await store.asearch(execution.namespace("thread-1", "calls"))
    assert len(records) == 4
    assert all(item.value["status"] == "completed" for item in records)


async def test_parallel_pause_stops_future_batches_and_resumes_all_interrupts(monkeypatch):
    graph, store, _, reference, model = setup_graph(monkeypatch, [parsed(str(i)) for i in range(4)], parts=["a", "b", "c", "d"])
    config = run_config()
    # Pause before either of the initial batch's model requests.
    original = document._chunk

    async def chunk(state, runtime):
        if str(runtime.execution_info.run_id) == str(config.get("run_id")):
            await store.aput(execution.namespace("thread-1", "pause"), str(config.get("run_id")), {"requested": True})
        return await original(state, runtime)

    monkeypatch.setattr(document, "_chunk", chunk)
    graph = local_graph(InMemorySaver(), store=store)
    result = await graph.ainvoke({"document": reference}, config)
    assert len(result["__interrupt__"]) == 2
    assert not model.calls
    result = await graph.ainvoke(Command(resume={item.id: {"action": "resume"} for item in result["__interrupt__"]}), {**config, "run_id": uuid4()})
    assert result["status"] == "SUCCEEDED"
    assert len(model.calls) == 4


@pytest.mark.parametrize("decision", ["accept_partial", "retry_failed"])
async def test_optional_review_and_decision(monkeypatch, decision):
    graph, _, _, reference, _ = setup_graph(monkeypatch, [], parts=["a", "b"])
    failed = True

    async def chunk(state, runtime):
        return {"chunkResults": [{"index": state["index"], "parsed": None if failed and state["index"] == 1 else parsed(str(state["index"])), "failureCode": "OUTPUT_INVALID"}], "usage": []}

    monkeypatch.setattr(document, "_chunk", chunk)
    graph = local_graph(InMemorySaver())
    config = run_config()
    result = await graph.ainvoke({"document": reference, "failurePolicy": "review"}, config)
    assert result["__interrupt__"][0].value["kind"] == "review"
    assert result["__interrupt__"][0].value["canAccept"]
    failed = False
    result = await graph.ainvoke(Command(resume={"action": decision, "requestId": str(uuid4()), "units": []}), config)
    assert result['__interrupt__'][0].value['qualityIssues']
    result = await graph.ainvoke(Command(resume={'action': 'accept_partial'}), config)
    assert '__interrupt__' not in result
    assert result["status"] == ("SUCCEEDED" if decision == "retry_failed" else "PARTIAL")


async def test_no_partial_acceptance_when_every_unit_failed(monkeypatch):
    graph, _, _, reference, _ = setup_graph(monkeypatch, [{"questions": [{"stem": ""}]}] * 4)
    config = run_config()
    result = await graph.ainvoke({"document": reference, "failurePolicy": "review"}, config)
    assert not result["__interrupt__"][0].value["canAccept"]
    with pytest.raises(DocumentProcessingError, match="No acceptable"):
        await graph.ainvoke(Command(resume={"action": "accept_partial"}), config)


async def test_model_result_survives_artifact_write_failure(monkeypatch):
    graph, store, files, reference, model = setup_graph(monkeypatch, [parsed()])
    vision_model = FakeModel(responses=[{**parsed(), "figures": [{"description": "Chart", "bbox": [0, 0, 1, 1]}]}])
    monkeypatch.setattr(document, "get_model", lambda *args: vision_model)
    monkeypatch.setattr(document, "extract", AsyncMock(side_effect=lambda *_: ExtractedDocument(text="", page_images=[make_image()])))
    original = files.put_artifact
    fail = True

    async def put(payload, **kwargs):
        if fail and kwargs["kind"].startswith("crop-"):
            raise OSError("storage offline")
        return await original(payload, **kwargs)

    monkeypatch.setattr(files, "put_artifact", put)
    config = run_config()
    with pytest.raises(OSError, match="storage offline"):
        await graph.ainvoke({"document": reference}, config)
    fail = False
    result = await graph.ainvoke(None, {**config, "run_id": uuid4()})
    assert result["status"] == "SUCCEEDED"
    assert len(vision_model.calls) == 1
    assert len(result["usage"]) == 1
    assert not model.calls
    assert len(await store.asearch(execution.namespace("thread-1", "calls"))) == 1


async def test_retry_page_preserves_successes_without_text_model_or_chunks(monkeypatch):
    graph, _, _, reference, model = setup_graph(monkeypatch, [])
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(document, "extract", AsyncMock(side_effect=lambda *_: ExtractedDocument(text="", page_images=[make_image(), make_image()])))
    calls = Counter()
    fail = True

    async def page_call(_model, messages, schema, call_kind, *, runtime=None):
        index = 0 if "PRIMARY page 1" in messages[-1].content else 1
        calls[index] += 1
        if fail and index == 1:
            return None, [], "OUTPUT_INVALID"
        return schema.model_validate(parsed(str(index))), [], None

    monkeypatch.setattr(document, "structured_call", page_call)
    config = run_config()
    output = await graph.ainvoke({"document": reference}, config)
    assert output["status"] == "PARTIAL"
    fail = False
    output = await graph.ainvoke({"document": reference, "retry": {"requestId": str(uuid4())}}, config)
    assert calls == Counter({0: 1, 1: 2})
    assert not model.calls
    assert output["processing"]["chunks"]["total"] == 0
    assert [item["stem"] for item in output["result"]["questions"]] == ["0", "1"]
    assert output["status"] == "SUCCEEDED"


async def test_expired_and_changed_execution_rejected_before_io(monkeypatch):
    graph, _, _, reference, model = setup_graph(monkeypatch, [parsed()])
    config = run_config()
    version = execution.new_execution()
    version["signature"]["code"] = "old"
    await graph.aupdate_state(config, {"document": reference, "execution": version}, as_node="load_context")
    with pytest.raises(DocumentProcessingError) as error:
        await graph.ainvoke(None, config)
    assert error.value.code == "EXECUTION_VERSION_MISMATCH"
    assert not model.calls
    version = execution.new_execution()
    version["expiresAt"] = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    with pytest.raises(DocumentProcessingError) as error:
        execution.validate_execution(version)
    assert error.value.code == "TASK_EXPIRED"


def test_unit_reducer_and_retry_validation():
    old = [{"index": 1, "round": 2, "parsed": "new"}]
    assert execution.merge_records(old, [{"index": 1, "round": 1, "parsed": "old"}]) == old
    assert execution.merge_records(old, old) == old
    with pytest.raises(DocumentProcessingError, match="Select existing"):
        document._retry_update({"document": {}}, RetryUnits(requestId=uuid4()))


async def test_maximum_batch_count_does_not_hit_default_recursion_limit(monkeypatch):
    graph, _, _, reference, _ = setup_graph(monkeypatch, [], parts=[str(i) for i in range(100)])
    active, peak = 0, 0

    async def chunk(state, runtime):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0)
        active -= 1
        return {"chunkResults": [{"index": state["index"], "parsed": parsed(str(state["index"])), "failureCode": None}]}

    monkeypatch.setattr(document, "_chunk", chunk)
    graph = local_graph(InMemorySaver())
    output = await graph.ainvoke({"document": reference}, run_config())
    assert output["processing"]["chunks"]["succeeded"] == 100
    assert peak <= document.load().graph_max_concurrency


async def test_store_failure_stops_model_calls(monkeypatch):
    graph, store, _, reference, model = setup_graph(monkeypatch, [parsed()])

    async def unavailable(*args, **kwargs):
        raise OSError("offline")

    monkeypatch.setattr(store, "aget", unavailable)
    with pytest.raises(DocumentProcessingError) as error:
        await graph.ainvoke({"document": reference}, run_config())
    assert error.value.code == "EXECUTION_STORE_UNAVAILABLE"
    assert not model.calls


async def test_unknown_provider_usage_is_not_recorded_as_zero(monkeypatch):
    import httpx2
    from openai import APIConnectionError

    failures = [APIConnectionError(request=httpx2.Request("POST", "https://example.invalid")) for _ in range(4)]
    graph, store, _, reference, model = setup_graph(monkeypatch, failures)
    monkeypatch.setattr(llm, "_retry_delay", lambda _: 0)
    with pytest.raises(DocumentProcessingError):
        await graph.ainvoke({"document": reference}, run_config())
    records = await store.asearch(execution.namespace("thread-1", "calls"))
    assert len(records) == len(model.calls) == 4
    assert all(item.value["status"] == "failed" and item.value["usageStatus"] == "unknown" and item.value["inputTokens"] is None for item in records)


async def test_crop_failure_requires_review_but_is_not_retryable(monkeypatch):
    graph, _, _, reference, model = setup_graph(monkeypatch, [
        {**parsed(), "figures": [{"description": "Chart", "bbox": [0, 0, 1, 1]}]},
    ])
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(document, "extract", AsyncMock(side_effect=lambda *_: ExtractedDocument(text="", page_images=[make_image()])))
    monkeypatch.setattr(document.vision, "crop_figure", lambda *_: None)
    config = run_config()
    output = await graph.ainvoke({"document": reference, "failurePolicy": "review"}, config)
    review = output["__interrupt__"][0].value
    assert review["stage"] == "result" and review["canAccept"]
    assert review["failures"][0]["code"] == "CROP_FAILED"
    assert not review["failures"][0]["retryable"]
    output = await graph.ainvoke(Command(resume={"action": "accept_partial"}), config)
    assert output["status"] == "PARTIAL" and len(model.calls) == 1


async def test_identical_questions_on_different_pages_are_preserved(monkeypatch):
    graph, _, files, reference, model = setup_graph(monkeypatch, [parsed("Repeated"), parsed("Repeated")])
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(document, "extract", AsyncMock(side_effect=lambda *_: ExtractedDocument(text="", page_images=[make_image(), make_image()])))
    result = await graph.ainvoke({"document": reference}, run_config())
    assert [q["stem"] for q in result["result"]["questions"]] == ["Repeated", "Repeated"]
    assert len(model.calls) == 2
    assert set(files.put_kinds) == {"page"}


async def test_recovery_provider_uses_real_model_http_protocol(tmp_path):
    import httpx2
    from langchain_core.messages import HumanMessage
    from langchain_openai import ChatOpenAI
    from pydantic import SecretStr

    from scripts.recovery_provider import app_for

    async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app_for(tmp_path / "calls.jsonl"))) as client:
        model = ChatOpenAI(model="synthetic-vision", api_key=SecretStr("test-key"), base_url="http://test/v1", http_async_client=client, max_retries=0)
        parsed_result, usage, failure = await llm.structured_call(model, [HumanMessage(content="test")], document.PageParseResult, "vision_parse")
    assert failure is None and parsed_result is not None
    assert parsed_result.figures and parsed_result.questions
    assert usage[0].inputTokens == 10 and usage[0].outputTokens == 5
    assert len((tmp_path / "calls.jsonl").read_text().splitlines()) == 1


async def test_maximum_pages_use_bounded_visual_batches(monkeypatch):
    graph, _, _, reference, model = setup_graph(monkeypatch, [])
    count = document.load().max_document_pages
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(document, "extract", AsyncMock(side_effect=lambda *_: ExtractedDocument(text="", page_images=[make_image()] * count)))
    active, peak, calls = 0, 0, 0

    async def page_call(_model, messages, schema, call_kind, *, runtime=None):
        nonlocal active, peak, calls
        active += 1
        peak = max(peak, active)
        calls += 1
        assert sum(isinstance(message.content, list) for message in messages) <= 3
        await asyncio.sleep(0)
        active -= 1
        return schema.model_validate(parsed()), [], None

    monkeypatch.setattr(document, "structured_call", page_call)
    result = await graph.ainvoke({"document": reference}, run_config())
    assert calls == result["processing"]["visuals"]["succeeded"] == count
    assert peak <= document.load().graph_max_concurrency
    assert result["processing"]["chunks"]["total"] == 0


@pytest.mark.parametrize('review', [False, True])
@pytest.mark.parametrize('pages', [False, True])
async def test_retry_limits_shared_by_native_input_and_review(monkeypatch, review, pages):
    graph, store, _files, reference, _model = setup_graph(monkeypatch, [], parts=['First', 'Second'])
    calls = Counter()

    async def unit(state, runtime):
        calls[state['index']] += 1
        if pages:
            if state['index'] == 1:
                return document._unit_failure('vision_parse', 1, 'OUTPUT_STALLED', [])
            return {'visionResults': [{'kind': 'page', 'index': 0, 'artifact': state['artifact'], 'parsed': parsed('First'), 'visuals': []}]}
        return {'chunkResults': [{'index': state['index'], 'parsed': parsed('First') if state['index'] == 0 else None, 'failureCode': 'OUTPUT_STALLED'}]}

    monkeypatch.setattr(document, '_vision' if pages else '_chunk', unit)
    if pages:
        monkeypatch.setattr(document, 'extract', AsyncMock(side_effect=lambda *_: ExtractedDocument(text='', page_images=[make_image(), make_image()])))
    graph = local_graph(InMemorySaver(), store=store)
    config = run_config()
    result = await graph.ainvoke({'document': reference, 'failurePolicy': 'review' if review else 'return_partial'}, config)
    stage = 'vision_parse' if pages else 'document_parse'
    for expected in (1, 0):
        request = {'requestId': str(uuid4()), 'units': [{'stage': stage, 'index': 1}]}
        result = await graph.ainvoke(Command(resume={'action': 'retry_failed', **request}) if review else {'document': reference, 'retry': request}, config)
        state = (await graph.aget_state(config)).values
        failure = document.unit_failures(state)[0]
        assert failure['retriesRemaining'] == expected
        assert failure['retryable'] == bool(expected)
        assert state['retryCounts'] == {f'{stage}:1': 2 - expected}
    assert calls == Counter({0: 1, 1: 3})
    request = {'requestId': str(uuid4()), 'units': [{'stage': stage, 'index': 1}]}
    if review:
        result = await graph.ainvoke(Command(resume={'action': 'accept_partial'}), config)
    assert result['status'] == 'PARTIAL'
    with pytest.raises(DocumentProcessingError) as error:
        await graph.ainvoke({'document': reference, 'retry': request}, config)
    assert error.value.code == 'RETRY_LIMIT_EXCEEDED'
    assert calls == Counter({0: 1, 1: 3})


def test_retry_selection_is_atomic_and_counts_only_selected_units():
    state: document.DocumentState = {'document': {}, 'retryCounts': {'document_parse:0': 2}, 'chunkResults': [
        {'index': i, 'parsed': None, 'failureCode': 'OUTPUT_INVALID'} for i in range(3)
    ]}
    with pytest.raises(DocumentProcessingError) as error:
        document._retry_update(state, RetryUnits(requestId=uuid4(), units=[FailedUnit(stage='document_parse', index=i) for i in (0, 1)]))
    assert error.value.code == 'RETRY_LIMIT_EXCEEDED'
    assert state['retryCounts'] == {'document_parse:0': 2}
    result = document._retry_update(state, RetryUnits(requestId=uuid4()))
    assert result['retryCounts'] == {'document_parse:0': 2, 'document_parse:1': 1, 'document_parse:2': 1}
    assert result['chunkResults'].value == [state['chunkResults'][0]]
    selected = document._retry_update(state, RetryUnits(requestId=uuid4(), units=[FailedUnit(stage='document_parse', index=2)]))
    assert selected['retryCounts'] == {'document_parse:0': 2, 'document_parse:2': 1}


async def test_pause_after_retry_checkpoint_does_not_spend_another_round(monkeypatch):
    graph, store, _, reference, model = setup_graph(monkeypatch, [{'questions': [{'stem': ''}]}] * 2 + [parsed()])
    config = run_config()
    with pytest.raises(DocumentProcessingError):
        await graph.ainvoke({'document': reference}, config)
    original_gate = document._gate

    async def pause_after_admission(state, *, phase):
        if state.get('retryCounts') and phase == 'chunk':
            await store.aput(execution.namespace('thread-1', 'pause'), str(config.get('run_id')), {'requested': True})
        return await original_gate(state, phase=phase)

    monkeypatch.setattr(document, '_gate', pause_after_admission)
    assert isinstance(graph.checkpointer, InMemorySaver)
    graph = local_graph(graph.checkpointer, store=store)
    request = {'requestId': str(uuid4())}
    result = await graph.ainvoke({'document': reference, 'retry': request}, config)
    assert result['__interrupt__'] and len(model.calls) == 2
    state = (await graph.aget_state(config)).values
    assert state['retryCounts'] == {'document_parse:0': 1}
    result = await graph.ainvoke(Command(resume={i.id: {'action': 'resume'} for i in result['__interrupt__']}), {**config, 'run_id': uuid4()})
    assert result['status'] == 'SUCCEEDED' and len(model.calls) == 3
    assert (await graph.aget_state(config)).values['retryCounts'] == {'document_parse:0': 1}
    with pytest.raises(DocumentProcessingError, match='already applied'):
        await graph.ainvoke({'document': reference, 'retry': request}, {**config, 'run_id': uuid4()})
    assert len(model.calls) == 3


async def test_stalled_correction_is_restored_across_pause(monkeypatch):
    graph, store, _, reference, model = setup_graph(monkeypatch, [{'questions': [{'stem': ''}]}] * 4)
    original = llm.structured_attempt
    config = run_config()
    once = True

    async def attempt(*args, **kwargs):
        nonlocal once
        result = await original(*args, **kwargs)
        if once:
            once = False
            await store.aput(execution.namespace('thread-1', 'pause'), str(config.get('run_id')), {'requested': True})
        return result

    monkeypatch.setattr(llm, 'structured_attempt', attempt)
    output = await graph.ainvoke({'document': reference}, config)
    with pytest.raises(DocumentProcessingError):
        await graph.ainvoke(Command(resume={i.id: {'action': 'resume'} for i in output['__interrupt__']}), {**config, 'run_id': uuid4()})
    state = (await graph.aget_state(config)).values
    assert document.unit_failures(state)[0]['code'] == 'OUTPUT_STALLED'
    assert len(model.calls) == len(state['usage']) == 2


async def test_quality_flags_are_visible_without_blocking_default_policy(monkeypatch):
    graph, _, _, reference, model = setup_graph(monkeypatch, [parsed('Absent from source')])
    output = await graph.ainvoke({'document': reference}, run_config())
    assert '__interrupt__' not in output and output['status'] == 'SUCCEEDED'
    assert output['processing']['quality']['reviewRequired']
    assert output['processing']['quality']['reviewQuestionCount'] == 1
    assert 'SOURCE_TEXT_NOT_FOUND' in {i['code'] for i in output['processing']['quality']['issues']}
    assert output['processing']['questionSources'] == [{'questionIndex': 0, 'stage': 'document_parse', 'unitIndex': 0, 'excelSource': None}]
    assert len(model.calls) == 1


async def test_recovery_provider_invalid_calls_survive_provider_restart(tmp_path):
    import httpx2
    from langchain_core.messages import HumanMessage
    from langchain_openai import ChatOpenAI
    from pydantic import SecretStr

    from scripts.recovery_provider import app_for

    log = tmp_path / 'calls.jsonl'
    with pytest.raises(ValueError, match='nonnegative'):
        app_for(log, -1)
    for attempt in range(2):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app_for(log, invalid_responses=2))) as client:
            model = ChatOpenAI(model='synthetic', api_key=SecretStr('test'), base_url='http://test/v1', http_async_client=client, max_retries=0)
            result, usage, failure = await llm.structured_call(model, [HumanMessage(content='test')], document.PageParseResult, 'vision_parse')
            if attempt == 0:
                assert result is None and failure == 'OUTPUT_STALLED' and len(usage) == 2
            else:
                assert result is not None and failure is None and len(usage) == 1
            calls = (await client.get('http://test/calls')).json()
            assert len(calls) == 2 + attempt
    assert len(log.read_text().splitlines()) == 3


@pytest.mark.parametrize('code', ['SOURCE_TEXT_NOT_FOUND', 'AMBIGUOUS_OVERLAP', 'OVERLAP_CONFLICT', 'MISSING_FIELDS', 'NEEDS_REVIEW'])
@pytest.mark.parametrize('policy', ['review', 'return_partial'])
async def test_quality_review_preserves_results_and_only_blocks_source_issues(monkeypatch, code, policy):
    graph, _, _, reference, model = setup_graph(monkeypatch, [parsed()])
    original = document._merge
    quality = {'reviewRequired': True, 'reviewQuestionCount': 1, 'issues': [{'questionIndex': 0, 'code': code}]}

    async def merge(state):
        result = await original(state)
        result['processing']['quality'] = quality
        return result

    monkeypatch.setattr(document, '_merge', merge)
    graph = local_graph(InMemorySaver())
    config = run_config()
    result = await graph.ainvoke({'document': reference, 'failurePolicy': policy}, config)
    blocked = policy == 'review' and code not in {'MISSING_FIELDS', 'NEEDS_REVIEW'}
    assert bool(result.get('__interrupt__')) == blocked
    if blocked:
        interruption = result['__interrupt__'][0].value
        assert interruption == {'kind': 'review', 'stage': 'result', 'failures': [],
                                'qualityIssues': quality['issues'], 'canAccept': True}
        saved = (await graph.aget_state(config)).values
        result = await graph.ainvoke(Command(resume={'action': 'accept_partial'}), config)
        assert result['result'] == saved['result']
    assert result['status'] == 'SUCCEEDED'
    assert result['processing']['quality'] == quality
    assert len(model.calls) == 1


async def test_truncated_attempt_replay_preserves_reason_usage_and_budget(monkeypatch):
    from langchain_core.messages import AIMessage

    graph, store, _, reference, _ = setup_graph(monkeypatch, [])
    calls = []
    class Runner:
        async def ainvoke(self, messages, config=None):
            calls.append(messages)
            return {'raw': AIMessage(content='{"questions":', response_metadata={'finish_reason': 'length'},
                                    usage_metadata={'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15}),
                    'parsed': None, 'parsing_error': ValueError('truncated')}
    monkeypatch.setattr(llm, 'structured_output', lambda *_: Runner())
    original = llm.structured_attempt
    config = run_config()
    async def attempt(*args, **kwargs):
        result = await original(*args, **kwargs)
        if len(calls) == 1:
            await store.aput(execution.namespace('thread-1', 'pause'), str(config.get('run_id')), {'requested': True})
        return result
    monkeypatch.setattr(llm, 'structured_attempt', attempt)
    result = await graph.ainvoke({'document': reference}, config)
    assert result['__interrupt__'] and len(calls) == 1
    with pytest.raises(DocumentProcessingError, match='All document fragments'):
        await graph.ainvoke(Command(resume={'action': 'resume'}), {**config, 'run_id': uuid4()})
    state = (await graph.aget_state(config)).values
    assert len(calls) == len(state['usage']) == 2
    failure = document.unit_failures(state)[0]
    assert failure['code'] == 'OUTPUT_TRUNCATED' and not failure['retryable']
    assert failure['retriesRemaining'] == 0
    records = await store.asearch(execution.namespace('thread-1', 'calls'))
    assert len(records) == 2 and all(item.value['validationCode'] == 'OUTPUT_TRUNCATED' for item in records)
