"""Mixed exercise layouts must not become exact one-record sources."""

from copy import deepcopy
from typing import cast
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import HumanMessage
from langgraph.runtime import Runtime
from pydantic import ValidationError

from practiq_ai import execution, llm
from practiq_ai.graphs import document
from practiq_ai.graphs.chunking import split_chunk_plan
from tests.support import FakeModel, MemoryStore, source, source_presence_hints

SOURCE = (
    'Reading comprehension — Morning\nArticle: The sky is blue.\n'
    '1. True or false: The sky is blue. Answer: True.\n\n'
    'Ordering — Arrange the morning\nItems: 0. Wake; 1. Eat. Answer order: 0, 1.\n'
)


@pytest.mark.parametrize('text', [
    SOURCE,
    'Reading comprehension —\nArticle: Birds travel south.\n1. True or false: Birds travel south. Answer: True.\n',
    'Reading comprehension —\r\nArticle: Birds travel south.\r\n1. True or false: Birds travel south. Answer: True.\r\n',
    SOURCE.replace('\n', '\r\n'),
    '1. Short answer: First\nReference answer: A\n\nShort answer: Second\nReference answer: B',
    '1. Short answer: First\nReference answer: A\n\nMatching - Match\nLeft: 0. One. Right: 0. 1.',
])
def test_mixed_numbered_and_unnumbered_exercises_disable_exact_count_and_ids(text):
    spans, header, counts = split_chunk_plan(text)
    assert spans == [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0}]
    assert counts == [None] and header is None
    assert source_presence_hints(text) is None


async def test_complete_mixed_extraction_is_not_corrected_to_one_question(monkeypatch):
    files, reference = source(SOURCE)
    questions = [
        {'id': 'fragment:1:reading', 'stem': 'Morning', 'answerMode': 'reading',
         'passage': [{'partType': 'text', 'textValue': 'The sky is blue.'}]},
        {'id': 'fragment:1:1', 'parentId': 'fragment:1:reading', 'stem': 'The sky is blue.',
         'answerMode': 'true_false', 'answerPayload': {'value': True}},
        {'id': 'fragment:1:ordering', 'stem': 'Arrange the morning', 'answerMode': 'ordering',
         'items': [{'id': 0, 'content': 'Wake'}, {'id': 1, 'content': 'Eat'}],
         'answerPayload': {'order': [0, 1]}},
    ]
    model = FakeModel(responses=[{'questions': questions}])
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setenv('AI_IMPORT_REVIEW', 'false')
    artifact = {key: value for key, value in reference.items() if key not in {'sourceType', 'fileName'}}
    prepared = await document._assemble({'document': reference, 'textRef': artifact})
    assert prepared['chunkNodeCounts'] == [None] and prepared['chunkPresence'] == [None]
    work = document._dispatch_chunks(cast(document.DocumentState, {'document': reference, **prepared}))
    assert isinstance(work, list)
    result = await document._chunk(work[0].arg, Runtime(store=MemoryStore()))
    parsed = result['chunkResults'][0]['parsed']
    assert parsed is not None and len(parsed['questions']) == 3
    assert len(model.calls) == len(result['usage']) == 1
    assert result['usage'][0]['inputTokens'] == 10 and result['usage'][0]['outputTokens'] == 5
    assert [q['answerPayload'] for q in parsed['questions']] == [None, {'value': True}, {'order': [0, 1]}]


def source_gap(kind="grammar_fill"):
    questions = [{'id': 'fragment:1:parent', 'stem': 'Finish the statement', 'answerMode': 'gap_fill',
             'questionKind': 'grammar_fill',
             'sourceText': 'Grammar fill: Finish the statement\nBirds (2) ____ south.\n2. Hint: fly',
             'passage': [{'partType': 'text', 'textValue': 'Birds '},
                         {'partType': 'blank', 'questionId': 'fragment:1:2'},
                         {'partType': 'text', 'textValue': ' south.'}]},
            {'id': 'fragment:1:2', 'parentId': 'fragment:1:parent', 'stem': 'Hint: fly',
             'answerMode': 'fill_blank', 'blankCount': 1, 'sourceText': '2. Hint: fly',
             'answerPayload': {'answers': ['fly']}}]
    if kind == 'sentence_selection':
        questions[0].update(questionKind=kind, answerMode='word_bank',
                            options=[{'label': 'A', 'content': 'fly'}])
        questions[0]['sourceText'] = questions[0]['sourceText'].replace('Grammar fill:', 'Sentence selection:')
        questions[1].update(answerMode='choice', choiceVariant='single', blankCount=None,
                            optionSourceId='fragment:1:parent', answerPayload={'correct': ['A']})
    return questions


@pytest.mark.parametrize('kind', ['grammar_fill', 'sentence_selection'])
@pytest.mark.parametrize('defect', ['prefix', 'generic_title', 'gap_number'])
async def test_source_grounded_parent_errors_use_paid_correction(monkeypatch, defect, kind):
    correct = source_gap(kind)
    wrong = deepcopy(correct)
    if defect == 'prefix':
        wrong[0]['stem'] = kind.replace('_', ' ') + ': Finish the statement'
    elif defect == 'generic_title':
        wrong[0]['stem'] = kind.replace('_', ' ')
    else:
        wrong[0]['passage'][0]['textValue'] = 'Birds (2) '
    saved = deepcopy(wrong)
    model = FakeModel(responses=[{'questions': wrong}, {'questions': correct}])
    monkeypatch.setattr(llm, 'reserve_model_call', AsyncMock())
    token = execution.CURRENT_UNIT.set('document_parse:0:0')
    try:
        parsed, usage, failure = await llm.structured_call(
            model, [HumanMessage(content=correct[0]['sourceText'])], document.ChunkParseResult, 'document_parse')
    finally:
        execution.CURRENT_UNIT.reset(token)
    assert parsed is not None and failure is None
    assert parsed.questions[0].stem == 'Finish the statement'
    assert parsed.questions[0].passage[0].textValue == 'Birds '
    assert len(model.calls) == len(usage) == 2
    assert all((item.inputTokens, item.outputTokens) == (10, 5) for item in usage)
    assert wrong == saved


def test_source_parent_checks_preserve_history_and_unproven_numbered_text():
    questions = source_gap()
    questions[0]['stem'] = 'Grammar fill: Finish the statement'
    assert document.ChunkParseResult.model_validate({'questions': questions}).questions[0].stem == questions[0]['stem']
    questions[0]['stem'] = 'Finish the statement'
    questions[0]['passage'][0]['textValue'] = 'Use rule (2) '
    token = execution.CURRENT_UNIT.set('document_parse:0:0')
    try:
        parsed = document.ChunkParseResult.model_validate({'questions': questions})
        assert parsed.questions[0].passage[0].textValue == 'Use rule (2) '
        bad = deepcopy(questions)
        bad[0]['stem'] = 'Grammar fill'
        with pytest.raises(ValidationError, match='printed exercise title'):
            document.ChunkParseResult.model_validate({'questions': bad})
    finally:
        execution.CURRENT_UNIT.reset(token)


def test_flattened_ocr_heading_retains_questions_for_review_without_expanding_the_title():
    question = {"id": "page:2:1", "answerMode": "matching", "stem": "Match words and numbers (one-to-one)",
                "sourceText": "Matching — Match words and numbers (one-to-one)Left: 0. One; 1. Two. Right: 0. 1; 1. 2.",
                "confidence": 1, "needsReview": False}
    token = execution.CURRENT_UNIT.set("vision_parse:1:0")
    try:
        parsed = document.ChunkParseResult.model_validate({"questions": [question]})
        assert parsed.questions[0].stem == question["stem"]
        assert parsed.questions[0].sourceText == question["sourceText"]
        assert parsed.questions[0].needsReview
    finally:
        execution.CURRENT_UNIT.reset(token)
    token = execution.CURRENT_UNIT.set("document_parse:0:0")
    try:
        with pytest.raises(ValidationError, match="printed exercise title"):
            document.ChunkParseResult.model_validate({"questions": [question]})
    finally:
        execution.CURRENT_UNIT.reset(token)


@pytest.mark.parametrize('only_reading', [False, True])
async def test_explicit_dash_titles_are_corrected_together_without_generic_replacements(monkeypatch, only_reading):
    headings = [('reading', 'Reading comprehension', 'Identify the season'),
                ('word_bank', 'Word bank', 'Select words'), ('cloze', 'Cloze', 'Complete the story'),
                ('ordering', 'Ordering', 'Arrange these events'), ('matching', 'Matching', 'Link the items')]
    if only_reading:
        headings = headings[:1]
    correct = [{'id': f'fragment:1:{mode}', 'answerMode': mode, 'stem': title,
                'sourceText': f'{label} — {title}'} for mode, label, title in headings]
    wrong = deepcopy(correct)
    for question, (_, label, _) in zip(wrong, headings, strict=True):
        question['stem'] = f'{label} — {question["stem"]}' if label == 'Reading comprehension' else label
    model = FakeModel(responses=[{'questions': wrong}, {'questions': correct}])
    monkeypatch.setattr(llm, 'reserve_model_call', AsyncMock())
    token = execution.CURRENT_UNIT.set('document_parse:0:0')
    try:
        parsed, usage, failure = await llm.structured_call(
            model, [HumanMessage(content='Preserve every printed exercise title')],
            document.ChunkParseResult, 'document_parse')
    finally:
        execution.CURRENT_UNIT.reset(token)
    assert parsed is not None and failure is None and len(usage) == len(model.calls) == 2
    assert [q.stem for q in parsed.questions] == [title for _, _, title in headings]
    assert all(title in model.calls[1][-1].content for _, _, title in headings)


def test_inline_reading_text_is_not_mistaken_for_a_dash_separated_title():
    token = execution.CURRENT_UNIT.set('document_parse:0:0')
    try:
        result = document.ChunkParseResult.model_validate({'questions': [{
            'id': 'fragment:1:reading', 'answerMode': 'reading', 'stem': 'Reading',
            'sourceText': 'Reading: Birds fly south.',
            'passage': [{'partType': 'text', 'textValue': 'Birds fly south.'}]}]})
        assert result.questions[0].stem == 'Reading'
    finally:
        execution.CURRENT_UNIT.reset(token)


def test_listening_audit_reference_does_not_override_the_question_prompt():
    token = execution.CURRENT_UNIT.set('document_parse:0:0')
    try:
        result = document.ChunkParseResult.model_validate({'questions': [{
            'id': 'fragment:1:audio', 'answerMode': 'listening', 'questionKind': 'listening',
            'stem': 'Listen and choose', 'sourceText': 'Listening — chimes'}]})
        assert result.questions[0].stem == 'Listen and choose'
        assert result.questions[0].sourceText == 'Listening — chimes'
    finally:
        execution.CURRENT_UNIT.reset(token)


def test_brief_reading_reference_is_not_a_reading_comprehension_title():
    token = execution.CURRENT_UNIT.set('document_parse:0:0')
    try:
        parsed = document.ChunkParseResult.model_validate({'questions': [{
            'id': 'fragment:1:reading', 'answerMode': 'reading', 'stem': 'Read the passage',
            'sourceText': 'Reading — audit reference'}]})
        assert parsed.questions[0].stem == 'Read the passage'
    finally:
        execution.CURRENT_UNIT.reset(token)


@pytest.mark.parametrize('mode,label', [('reading', 'Reading comprehension'), ('word_bank', 'Word bank')])
def test_empty_heading_does_not_turn_the_next_material_line_into_a_title(mode, label):
    token = execution.CURRENT_UNIT.set('document_parse:0:0')
    try:
        parsed = document.ChunkParseResult.model_validate({'questions': [{
            'id': 'fragment:1:parent', 'answerMode': mode, 'stem': None,
            'sourceText': f'{label} —\nMaterial only, no printed title'}]})
        assert parsed.questions[0].stem is None
    finally:
        execution.CURRENT_UNIT.reset(token)
