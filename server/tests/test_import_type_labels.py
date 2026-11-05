"""Missing model type labels require correction without rewriting saved imports."""

from copy import deepcopy
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import HumanMessage
from pydantic import ValidationError

from practiq_ai import llm
from practiq_ai.contracts import DocumentQuality, QuestionSource
from practiq_ai.execution import namespace
from practiq_ai.graphs import document
from practiq_ai.graphs.chunking import finalize_question_ids
from practiq_ai.unit_results import UnitParseResult
from scripts.accept_workflow import EXPECTED, SOURCE
from tests.support import FakeModel, ocr_text_page, question, setup_graph


def png_reply(label=None):
    return {'questions': [{**question(stem), 'id': f'page:1:{index}',
        'answerMode': 'true_false', 'questionTypeId': label, 'answerPayload': {'value': answer},
        'sourceText': f'{index}. {stem}\nAnswer: {answer}'}
        for index, (stem, answer) in enumerate(EXPECTED, 1)], 'groups': [], 'figures': []}


@pytest.fixture
def ocr_context():
    values = [(document.CURRENT_UNIT, 'vision_parse:0'), (document.OCR_PAGE, ocr_text_page(SOURCE)),
              (document.OCR_TEXT, SOURCE), (document.OCR_FIGURES, [])]
    tokens = [(variable, variable.set(value)) for variable, value in values]
    try:
        yield
    finally:
        for variable, token in reversed(tokens):
            variable.reset(token)


async def test_png_missing_labels_enter_existing_correction_with_usage(monkeypatch, ocr_context):
    monkeypatch.setattr(llm, 'reserve_model_call', AsyncMock())
    missing, corrected = png_reply(), png_reply('True or false')
    saved = deepcopy(missing)
    model = FakeModel(responses=[missing, corrected])
    records = []
    result, usage, failure = await llm.structured_call(model, [HumanMessage(content=SOURCE)],
        document.OcrPageParseResult, 'vision_parse', call_records=records)
    assert result is not None and failure is None
    assert len(model.calls) == len(usage) == 2
    assert records[0]['validationCode'] == 'OUTPUT_INVALID'
    assert 'questionTypeId' in str(model.calls[1])
    assert all(q.questionTypeId == 'True or false' and 'questionTypeId' not in q.missingFields for q in result.questions)
    assert [q['answerPayload'] for q in result.model_dump()['questions']] == [{'value': answer} for _, answer in EXPECTED]
    assert all(item.inputTokens == 10 and item.outputTokens == 5 for item in usage)
    assert missing == saved


async def test_repeated_missing_labels_stop_without_silent_defaults(monkeypatch, ocr_context):
    monkeypatch.setattr(llm, 'reserve_model_call', AsyncMock())
    model = FakeModel(responses=[png_reply()] * 4)
    result, usage, failure = await llm.structured_call(model, [HumanMessage(content=SOURCE)],
        document.OcrPageParseResult, 'vision_parse')
    assert result is None and failure == 'OUTPUT_STALLED'
    assert len(model.calls) == len(usage) == 2


async def test_type_label_correction_persists_failed_usage_and_spends_existing_budget(monkeypatch):
    missing, corrected = png_reply(), png_reply('True or false')
    for reply in (missing, corrected):
        reply.pop('figures')
    graph, receipts, _, reference, model = setup_graph(monkeypatch, [missing, corrected], parts=[SOURCE])
    state = await graph.ainvoke({'document': reference})
    assert len(model.calls) == len(state['usage']) == 2
    assert all(q['questionTypeId'] == 'True or false' for q in state['result']['questions'])
    records = await receipts.asearch(namespace('thread-1', 'calls'))
    assert len(records) == 2
    assert sorted(record.value['validation'] for record in records) == ['failed', 'passed']
    assert all(record.value['usageStatus'] == 'known' for record in records)
    budgets = await receipts.asearch(namespace('thread-1', 'budget'))
    assert sum(item.value['spent'] for item in budgets) == 2


async def test_missing_label_correction_cannot_exceed_task_budget(monkeypatch):
    monkeypatch.setenv('AI_TASK_MAX_MODEL_CALLS', '1')
    missing = png_reply()
    missing.pop('figures')
    graph, receipts, _, reference, model = setup_graph(monkeypatch, [missing], parts=[SOURCE])
    state = await graph.ainvoke({'document': reference})
    assert len(model.calls) == len(state['usage']) == 1
    assert not state['result']['questions']
    assert any(item['code'] == 'MODEL_BUDGET_EXCEEDED' for item in state['processing']['failures'])
    budgets = await receipts.asearch(namespace('thread-1', 'budget'))
    assert sum(item.value['spent'] for item in budgets) == 1


@pytest.mark.parametrize('unit', ['document_parse:0', 'vision_parse:0'])
@pytest.mark.parametrize('label', [None, '', '   '])
def test_new_extracts_with_known_modes_require_labels(unit, label):
    token = document.CURRENT_UNIT.set(unit)
    try:
        with pytest.raises(ValidationError, match='questionTypeId'):
            document.ChunkParseResult.model_validate({'questions': [{**question('Printed?'), 'questionTypeId': label}]},
                context={'requireTypeLabels': True})
    finally:
        document.CURRENT_UNIT.reset(token)


def test_unknown_modes_and_saved_missing_labels_remain_reviewable(ocr_context):
    incomplete = {**question('Unclear source'), 'questionTypeId': None}
    saved = UnitParseResult.model_validate({'questions': [incomplete]}).questions[0]
    assert saved.questionTypeId is None and 'questionTypeId' in saved.missingFields
    assert document.ChunkParseResult.model_validate({'questions': [incomplete]}).questions[0].questionTypeId is None
    unknown = document.OcrPageParseResult.model_validate({'questions': [{**incomplete, 'answerMode': None}]},
        context={'requireTypeLabels': True}).questions[0]
    assert unknown.answerMode is unknown.questionTypeId is None and unknown.needsReview


@pytest.mark.parametrize('label', ['判断题', 'True or false', 'true_false', 'Custom source label'])
def test_supplied_type_labels_are_not_replaced(ocr_context, label):
    parsed = document.OcrPageParseResult.model_validate(png_reply(label))
    assert all(q.questionTypeId == label for q in parsed.questions)


@pytest.mark.parametrize('stage,prefix', [('vision_parse', 'page'), ('document_parse', 'fragment')])
def test_continuation_can_keep_unknown_label_and_merge_original_type(stage, prefix):
    original = {'id': f'{prefix}:1:article', 'stem': 'Printed article', 'answerMode': 'reading',
                'questionTypeId': 'Source reading label', 'passage': [{'partType': 'text', 'textValue': 'First part.'}]}
    continued = {**original, 'questionTypeId': None, 'passage': [{'partType': 'text', 'textValue': 'Second part.'}]}
    start_token = document.CURRENT_UNIT.set(f'{stage}:0:0')
    try:
        with pytest.raises(ValidationError, match='questionTypeId'):
            document.ChunkParseResult.model_validate({'questions': [continued]}, context={'requireTypeLabels': True})
    finally:
        document.CURRENT_UNIT.reset(start_token)
    token = document.CURRENT_UNIT.set(f'{stage}:1:0')
    try:
        first = document.ChunkParseResult.model_validate({'questions': [original]}).questions[0]
        second = document.ChunkParseResult.model_validate({'questions': [continued]},
            context={'requireTypeLabels': True}).questions[0]
    finally:
        document.CURRENT_UNIT.reset(token)
    assert second.questionTypeId is None
    sources = [QuestionSource(questionIndex=i, stage=stage, unitIndex=i) for i in range(2)]
    merged = finalize_question_ids([first, second], [], [], sources, DocumentQuality())
    assert len(merged) == 1 and merged[0].questionTypeId == 'Source reading label'
    assert [block.textValue for block in merged[0].passage] == ['First part.', 'Second part.']
