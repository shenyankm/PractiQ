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


@pytest.mark.parametrize('source_line_available', [False, True])
def test_flattened_ocr_heading_retains_questions_for_review_without_expanding_the_title(source_line_available):
    question = {"id": "page:2:1", "answerMode": "matching", "stem": "Match words and numbers (one-to-one)",
                "sourceText": "Matching — Match words and numbers (one-to-one)Left: 0. One; 1. Two. Right: 0. 1; 1. 2.",
                "confidence": 1, "needsReview": False}
    token = execution.CURRENT_UNIT.set("vision_parse:1:0")
    ocr_token = document.OCR_TEXT.set(question['sourceText'] if source_line_available else None)
    try:
        parsed = document.ChunkParseResult.model_validate({"questions": [question]})
        assert parsed.questions[0].stem == question["stem"]
        assert parsed.questions[0].sourceText == question["sourceText"]
        assert parsed.questions[0].needsReview
    finally:
        document.OCR_TEXT.reset(ocr_token)
        execution.CURRENT_UNIT.reset(token)
    token = execution.CURRENT_UNIT.set("document_parse:0:0")
    try:
        with pytest.raises(ValidationError, match="printed exercise title"):
            document.ChunkParseResult.model_validate({"questions": [question]})
    finally:
        execution.CURRENT_UNIT.reset(token)


@pytest.mark.parametrize('only_reading', [False, True])
@pytest.mark.parametrize('route', ['document_parse', 'vision_parse'])
async def test_explicit_dash_titles_are_corrected_together_without_generic_replacements(monkeypatch, only_reading, route):
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
    token = execution.CURRENT_UNIT.set(f'{route}:0:0')
    ocr_token = document.OCR_TEXT.set('\n'.join(q['sourceText'] for q in correct))
    try:
        parsed, usage, failure = await llm.structured_call(
            model, [HumanMessage(content='Preserve every printed exercise title')],
            document.ChunkParseResult, route)
    finally:
        document.OCR_TEXT.reset(ocr_token)
        execution.CURRENT_UNIT.reset(token)
    assert parsed is not None and failure is None and len(usage) == len(model.calls) == 2
    assert [q.stem for q in parsed.questions] == [title for _, _, title in headings]
    assert all(title in model.calls[1][-1].content for _, _, title in headings)


@pytest.mark.parametrize('kind,mode,label', [('listening', 'listening', 'Listening'),
                                             ('paragraph_matching', 'matching', 'Paragraph matching')])
@pytest.mark.parametrize('proven', [False, True])
def test_ocr_colon_titles_require_a_trusted_complete_line(kind, mode, label, proven):
    quote = f'{label}: A printed title'
    question = {'stem': quote, 'answerMode': mode, 'questionKind': kind, 'sourceText': quote}
    unit_token = execution.CURRENT_UNIT.set('vision_parse:0:0')
    text_token = document.OCR_TEXT.set(quote if proven else 'Other source text')
    try:
        if proven:
            with pytest.raises(ValidationError, match='printed exercise title'):
                document.ChunkParseResult.model_validate({'questions': [question]})
            question['stem'] = 'A printed title'
        parsed = document.ChunkParseResult.model_validate({'questions': [question]})
        assert parsed.questions[0].stem == question['stem']
    finally:
        document.OCR_TEXT.reset(text_token)
        execution.CURRENT_UNIT.reset(unit_token)


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


async def test_flattened_ocr_grammar_title_is_corrected_from_verbatim_passage(monkeypatch):
    correct = source_gap()
    quote = 'Grammar fill: Finish the statement Birds (2) ____ south.'
    correct[0]['sourceText'] = quote
    wrong = deepcopy(correct)
    wrong[0]['stem'] = 'Finish the statement Birds (2) ____ south.'
    model = FakeModel(responses=[{'questions': wrong}, {'questions': correct}])
    monkeypatch.setattr(llm, 'reserve_model_call', AsyncMock())
    unit_token = execution.CURRENT_UNIT.set('vision_parse:0:0')
    text_token = document.OCR_TEXT.set(quote)
    try:
        parsed, usage, failure = await llm.structured_call(model, [HumanMessage(content=quote)], document.ChunkParseResult, 'vision_parse')
    finally:
        document.OCR_TEXT.reset(text_token)
        execution.CURRENT_UNIT.reset(unit_token)
    assert failure is None and parsed is not None
    assert parsed.questions[0].stem == 'Finish the statement'
    assert len(usage) == len(model.calls) == 2


@pytest.mark.parametrize('label,mode,cue', [
    ('Reading comprehension', 'reading', 'Article: A source passage.'),
    ('Word bank', 'word_bank', 'Bank: A. one B. two. Passage: value [1].'),
    ('Cloze', 'cloze', 'Passage: value [1].'),
    ('Grammar fill', 'gap_fill', 'Birds (1) ____ south. Hint: fly'),
    ('Listening', 'listening', 'Transcript: A source transcript.'),
])
def test_ocr_explicit_composite_material_cannot_be_flattened_to_an_answered_record(label, mode, cue):
    token = execution.CURRENT_UNIT.set('vision_parse:0:0')
    text_token = document.OCR_TEXT.set(f'# {label}: Title\n{cue}')
    try:
        with pytest.raises(ValidationError, match=f'separate {mode} parent'):
            document.ChunkParseResult.model_validate({'questions': [{'stem': 'Title', 'answerMode': 'short_answer', 'answerPayload': {'text': 'one'}}]})
    finally:
        document.OCR_TEXT.reset(text_token)
        execution.CURRENT_UNIT.reset(token)


def test_native_worksheet_name_is_a_group_and_column_header_is_not_a_section():
    token = execution.CURRENT_UNIT.set('vision_parse:0:0')
    page_token = document.OCR_PAGE.set({'format': 'table', 'elements': [{'table_info': {
        'table_name': 'Science', 'fields': [{'formatted_field_name': 'Question'}]}}]})
    value = {'questions': [{'stem': 'A fact?', 'answerMode': 'short_answer'}],
             'groups': [{'title': 'Science', 'questionIndexes': [0]}]}
    try:
        assert document.ChunkParseResult.model_validate(value).groups[0].title == 'Science'
        for groups in [[], [{'title': 'Science', 'questionIndexes': []}],
                       [*value['groups'], {'title': 'Question', 'questionIndexes': [0]}]]:
            with pytest.raises(ValidationError, match='worksheet|column headers'):
                document.ChunkParseResult.model_validate({**value, 'groups': groups})
    finally:
        document.OCR_PAGE.reset(page_token)
        execution.CURRENT_UNIT.reset(token)


@pytest.mark.parametrize('stem,quote', [
    ('Fill in the blank: 6 × 7 = ____.', '1. Fill in the blank: $6 \\times 7 = $ ____.\nAnswer: 42'),
    ('True or false: A fact.', '1. True or false: A fact. Answer: True.'),
    ('Word bank — A title', 'Word bank — A title | Passage: value [1].'),
])
def test_printed_type_prefix_cannot_leak_into_a_new_stem(stem, quote):
    token = execution.CURRENT_UNIT.set('vision_parse:0:0')
    try:
        with pytest.raises(ValidationError, match='type prefix from stem'):
            document.ChunkParseResult.model_validate({'questions': [{'stem': stem, 'sourceText': quote, 'answerMode': 'short_answer'}]})
    finally:
        execution.CURRENT_UNIT.reset(token)


@pytest.mark.parametrize('mode,label,title', [
    ('reading', 'Reading comprehension —', 'An actual title'),
    ('word_bank', 'Word bank —', 'An actual title'),
    ('cloze', 'Cloze —', 'An actual title'),
    ('listening', 'Listening:', 'An actual title'),
])
def test_unique_trusted_ocr_title_does_not_depend_on_models_audit_quote(mode, label, title):
    token = execution.CURRENT_UNIT.set('vision_parse:0:0')
    text_token = document.OCR_TEXT.set(f'# {label} {title}')
    value = {'answerMode': mode, 'sourceText': 'Only material, no heading', 'stem': 'Article'}
    try:
        with pytest.raises(ValidationError, match='printed exercise title'):
            document.ChunkParseResult.model_validate({'questions': [value]})
        parsed = document.ChunkParseResult.model_validate({'questions': [{**value, 'stem': title}]})
        assert parsed.questions[0].stem == title
    finally:
        document.OCR_TEXT.reset(text_token)
        execution.CURRENT_UNIT.reset(token)


def test_ocr_matching_title_and_policy_stop_at_verified_item_boundary():
    token = execution.CURRENT_UNIT.set('vision_parse:0:0')
    text_token = document.OCR_TEXT.set('Matching — Pair values (one-to-one)Left: 0. A. Right: 0. 1.')
    value = {'stem': 'Pair values', 'answerMode': 'matching', 'items': [
        {'id': 0, 'side': 'left', 'content': 'A'}, {'id': 0, 'side': 'right', 'content': '1'}]}
    try:
        with pytest.raises(ValidationError, match='printed exercise title'):
            document.ChunkParseResult.model_validate({'questions': [value]})
        value['stem'] = 'Pair values (one-to-one)'
        with pytest.raises(ValidationError, match='explicit.*matching policy'):
            document.ChunkParseResult.model_validate({'questions': [value]})
        value['matchingVariant'] = 'one_to_one'
        assert document.ChunkParseResult.model_validate({'questions': [value]}).questions[0].matchingVariant == 'one_to_one'
    finally:
        document.OCR_TEXT.reset(text_token)
        execution.CURRENT_UNIT.reset(token)


def test_native_ocr_cell_text_uses_xml_without_formatted_header_aliases():
    page = {'format': 'table', 'elements': [{'layout_xml': '<table><tr><td>Listening: A source title</td></tr><tr><td>Section: Part A</td></tr></table>',
        'table_info': {'fields': [{'formatted_field_name': 'Listening:_A_source_title'}]}}]}
    assert document._ocr_source_lines(page) == ['Listening: A source title', 'Section: Part A']


@pytest.mark.parametrize('middle,tail,valid', [('. Grass is ', '.', True), (' Grass is ', '.', False), ('. Grass is ', '', False)])
def test_ocr_passage_punctuation_uses_unique_source_word_and_blank_positions(middle, tail, valid):
    question = document.ParsedQuestion.model_validate({'stem': 'Title', 'answerMode': 'word_bank', 'passage': [
        {'partType': 'text', 'textValue': 'Snow is '}, {'partType': 'blank', 'questionId': 'a'},
        {'partType': 'text', 'textValue': middle}, {'partType': 'blank', 'questionId': 'b'},
        *([{'partType': 'text', 'textValue': tail}] if tail else [])]})
    token = document.OCR_TEXT.set('Snow is [1]. Grass is [2]. Answers: 1 A; 2 B.')
    try:
        assert document._passage_punctuation_matches_source(question) is valid
    finally:
        document.OCR_TEXT.reset(token)


@pytest.mark.parametrize('source', ['Unrelated material', 'aba[1]aba[2]aba', '\ue000 aba[1]aba'])
def test_unproven_or_ambiguous_passage_positions_do_not_force_punctuation(source):
    question = document.ParsedQuestion.model_validate({'stem': 'Title', 'answerMode': 'word_bank', 'passage': [
        {'partType': 'text', 'textValue': 'aba'}, {'partType': 'blank', 'questionId': 'a'},
        {'partType': 'text', 'textValue': '?aba'}]})
    token = document.OCR_TEXT.set(source)
    try:
        assert document._passage_punctuation_matches_source(question)
    finally:
        document.OCR_TEXT.reset(token)


def test_numbered_grammar_hint_stays_on_its_child_and_sentence_stays_on_parent():
    correct = source_gap()
    wrong = deepcopy(correct)
    wrong[1]['stem'] = 'Birds ____ south. Hint: fly'
    unit_token = execution.CURRENT_UNIT.set('vision_parse:0:0')
    text_token = document.OCR_TEXT.set(correct[0]['sourceText'])
    try:
        with pytest.raises(ValidationError, match='numbered Hint: line'):
            document.ChunkParseResult.model_validate({'questions': wrong})
        assert document.ChunkParseResult.model_validate({'questions': correct}).questions[1].stem == 'Hint: fly'
    finally:
        document.OCR_TEXT.reset(text_token)
        execution.CURRENT_UNIT.reset(unit_token)


def test_single_printed_title_does_not_assign_a_second_unheaded_parent():
    unit_token = execution.CURRENT_UNIT.set('vision_parse:0:0')
    text_token = document.OCR_TEXT.set('Reading comprehension — First title\nOther material')
    questions = [{'stem': 'First title', 'answerMode': 'reading'}, {'stem': 'Other source prompt', 'answerMode': 'reading'}]
    try:
        assert [q.stem for q in document.ChunkParseResult.model_validate({'questions': questions}).questions] == ['First title', 'Other source prompt']
    finally:
        document.OCR_TEXT.reset(text_token)
        execution.CURRENT_UNIT.reset(unit_token)


@pytest.mark.parametrize('stem,valid', [
    (r'$6 \times 7 = $ ____.', False),
    (r'$8 \div 2 =$ ____', False),
    ('6 × 7 = ____.', True),
    (r'$6 \times 7 = ____.$', True),
    (r'\(6 \times 7 = ____.\)', True),
    ('$5 = ____ dollars.', True),
    (r'Price $6 \times 7 = $ ____ dollars.', True),
])
@pytest.mark.parametrize('unit', [None, 'vision_parse:0:0'])
def test_ocr_equation_prefix_does_not_leave_its_blank_outside_math(stem, valid, unit):
    token = execution.CURRENT_UNIT.set(unit)
    try:
        value = {'questions': [{'stem': stem, 'answerMode': 'fill_blank'}]}
        if valid or unit is None:
            parsed = document.ChunkParseResult.model_validate(value).questions[0]
            assert parsed.stem == stem and parsed.answerPayload is None
        else:
            with pytest.raises(ValidationError, match='complete unsolved equation'):
                document.ChunkParseResult.model_validate(value)
    finally:
        execution.CURRENT_UNIT.reset(token)


@pytest.mark.parametrize('stem,valid', [('Which city? A. Town', False), ('Which city?', True), ("Is 'A. Town' printed?", True)])
def test_choice_stem_does_not_repeat_the_first_option_after_question_mark(stem, valid):
    token = execution.CURRENT_UNIT.set('vision_parse:0:0')
    text_token = document.OCR_TEXT.set('1. Which city?\nA. Town\nB. Village\nAnswer: A')
    value = {'stem': stem, 'answerMode': 'choice', 'options': [
        {'label': 'A', 'content': 'Town'}, {'label': 'B', 'content': 'Village'}]}
    try:
        if valid:
            assert document.ChunkParseResult.model_validate({'questions': [value]}).questions[0].stem == stem
        else:
            with pytest.raises(ValidationError, match='Keep the option in options'):
                document.ChunkParseResult.model_validate({'questions': [value]})
    finally:
        document.OCR_TEXT.reset(text_token)
        execution.CURRENT_UNIT.reset(token)


@pytest.mark.parametrize('mode', ['word_bank', 'cloze'])
def test_gap_children_do_not_duplicate_parent_markers_and_sentence_punctuation(mode):
    options = [{'label': 'A', 'content': 'white'}, {'label': 'B', 'content': 'green'}]
    parent = {'id': 'page:1:parent', 'stem': 'Title', 'answerMode': mode,
        'options': options if mode == 'word_bank' else [], 'passage': [
        {'partType': 'text', 'textValue': 'Snow is '}, {'partType': 'blank', 'questionId': 'page:1:1'},
        {'partType': 'text', 'textValue': '. Grass is '}, {'partType': 'blank', 'questionId': 'page:1:2'},
        {'partType': 'text', 'textValue': '.'}]}
    children = [{'id': f'page:1:{index}', 'parentId': parent['id'], 'stem': stem,
        'answerMode': 'choice', 'choiceVariant': 'single', 'options': [] if mode == 'word_bank' else options,
        'optionSourceId': parent['id'] if mode == 'word_bank' else None}
        for index, stem in enumerate(['Snow is [1].', 'Grass is [2].'], 1)]
    token = execution.CURRENT_UNIT.set('vision_parse:0:0')
    text_token = document.OCR_TEXT.set('Snow is [1]. Grass is [2].')
    try:
        with pytest.raises(ValidationError, match='child already owns a parent passage blank'):
            document.ChunkParseResult.model_validate({'questions': [parent, *children]})
        for child, stem in zip(children, ['Snow is', 'Grass is'], strict=True):
            child['stem'] = stem
        assert len(document.ChunkParseResult.model_validate({'questions': [parent, *children]}).questions) == 3
    finally:
        document.OCR_TEXT.reset(text_token)
        execution.CURRENT_UNIT.reset(token)
