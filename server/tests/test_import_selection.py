"""Explicit selection preserves relationships and immutable sources."""
from uuid import uuid4

import pytest
from pydantic import ValidationError

from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskCreate,
    DocumentTaskReparse,
    document_source_key,
)


def reference():
    return DocumentReference(objectKey=document_source_key('pdf', 'a' * 64), sha256='a' * 64,
                             sizeBytes=10, mediaType='application/pdf', sourceType='pdf')


def test_page_selection_contract_is_bounded_and_canonical():
    request = DocumentTaskCreate(requestId=uuid4(), document=reference(), pages=[3, 1, 3])
    assert request.pages == [1, 3]
    assert request.documentRole == 'questions'
    for pages in [[], [0], [-1], [True], [1.5]]:
        with pytest.raises(ValidationError):
            DocumentTaskCreate.model_validate({'requestId': str(uuid4()), 'document': reference().model_dump(), 'pages': pages})


def test_selective_reparse_requires_checkpoint_and_nonempty_source_units():
    request = DocumentTaskReparse.model_validate({'requestId': str(uuid4()), 'selection': {'checkpointId': 'cp', 'units': [{'stage': 'vision_parse', 'index': 2}]}})
    assert request.selection and request.selection.units[0].index == 2
    for selection in [{'checkpointId': 'cp', 'units': []}, {'units': [{'stage': 'vision_parse', 'index': 0}]}, {'checkpointId': 'cp', 'units': [{'stage': 'result', 'index': 0}]}]:
        with pytest.raises(ValidationError):
            DocumentTaskReparse.model_validate({'requestId': str(uuid4()), 'selection': selection})


def test_selection_keeps_original_page_and_tile_indexes():
    from practiq_ai.source_selection import active_indices, page_indices
    state = {'pages': [2], 'pageRefs': [{}, {}, {}], 'inputParts': [{'sourcePage': 0}, {'sourcePage': 1}, {'sourcePage': 1}]}
    assert page_indices(state) == [1, 2]
    assert active_indices({**state, 'selectedUnits': [{'stage': 'vision_parse', 'index': 2}]}, 'vision_parse') == [2]
    from practiq_ai.errors import DocumentProcessingError
    with pytest.raises(DocumentProcessingError):
        page_indices({**state, 'pages': [3]})


def test_selected_export_expands_material_dependencies_without_mutating_results():
    from copy import deepcopy

    from practiq_ai.bank_export import select_questions
    from practiq_ai.contracts import DocumentParseResult
    from tests.support import parsed
    base = parsed()['questions'][0]
    questions = [{**base, 'id': 'bank', 'stem': 'Material', 'answerMode': 'word_bank', 'answerPayload': None,
                  'options': [{'label': 'A', 'content': 'First'}, {'label': 'B', 'content': 'Second'}], 'passage': [{'partType': 'blank', 'questionId': 'one'}, {'partType': 'blank', 'questionId': 'two'}]},
                 {**base, 'id': 'one', 'parentId': 'bank', 'optionSourceId': 'bank', 'answerMode': 'choice', 'choiceVariant': 'single', 'options': [], 'answerPayload': {'correct': ['A']}},
                 {**base, 'id': 'two', 'parentId': 'bank', 'optionSourceId': 'bank', 'answerMode': 'choice', 'choiceVariant': 'single', 'options': [], 'answerPayload': {'correct': ['B']}},
                 {**base, 'id': 'unrelated', 'parentId': None}]
    result = DocumentParseResult.model_validate({**parsed(), 'questions': questions, 'groups': [{'title': 'Group', 'questionIds': ['one', 'two', 'unrelated']}], 'schemaVersion': 3, 'visualElements': [], 'warnings': [], 'confidenceScore': 80})
    before = deepcopy(result.model_dump(mode='json'))
    selected, indexes = select_questions(result, [1])
    assert indexes == [0, 1, 2]
    assert [q.id for q in selected.questions] == ['bank', 'one', 'two']
    assert selected.groups[0].questionIds == ['one', 'two']
    assert result.model_dump(mode='json') == before
    from practiq_ai.errors import DocumentProcessingError
    for values in [[], [-1], [4], [True]]:
        with pytest.raises(DocumentProcessingError):
            select_questions(result, values)


@pytest.mark.usefixtures('disposable_databases')
async def test_selective_reparse_reuses_evidence_and_preserves_original_and_receipts(monkeypatch):
    from practiq_ai import task_api
    from practiq_ai.errors import DocumentProcessingError
    from tests.db_support import setup_api
    from tests.support import parsed
    service, source, model = await setup_api(monkeypatch, [parsed(), parsed()])
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(source)))
    await service.wait_idle()
    before = await task_api.get_task(receipt['threadId'])
    selection = {'checkpointId': before['checkpointId'], 'units': [{'stage': 'document_parse', 'index': 0}]}
    request = DocumentTaskReparse.model_validate({'requestId': str(uuid4()), 'selection': selection})
    new = await task_api.reparse_task(receipt['threadId'], request)
    await service.wait_idle()
    assert await task_api.reparse_task(receipt['threadId'], request) == new
    after = await task_api.get_task(new['threadId'])
    assert after['parentThreadId'] == receipt['threadId'] and after['state'] == 'COMPLETED'
    assert after['result']['questions'] and len(model.calls) == 2
    old = await task_api.get_task(receipt['threadId'])
    assert old['result'] == before['result'] and old['usage'] == before['usage']
    assert after["parserJobs"] == [] and before["parserJobs"]
    invalid = DocumentTaskReparse.model_validate({'requestId': str(uuid4()), 'selection': {**selection, 'checkpointId': 'stale'}})
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.reparse_task(receipt['threadId'], invalid)
    assert error.value.code == 'STALE_CHECKPOINT'
    await task_api.delete_task(receipt['threadId'])
    assert await task_api.reparse_task(receipt['threadId'], request) == new
    assert request.selection is not None
    changed = request.model_copy(update={'selection': request.selection.model_copy(update={'checkpointId': 'changed'})})
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.reparse_task(receipt['threadId'], changed)
    assert error.value.code == 'REQUEST_CONFLICT'


def test_answer_suggestions_keep_ambiguity_and_existing_answers_visible():
    from practiq_ai.answer_matching import associated_question, match_answers
    from practiq_ai.contracts import DocumentParseResult, ParsedQuestion
    from tests.support import parsed
    base = {**parsed(), 'schemaVersion': 3, 'visualElements': [], 'warnings': [], 'confidenceScore': 80}
    target = DocumentParseResult.model_validate({**base, 'questions': [
        {'id': 'one', 'stem': '1. First', 'answerMode': 'short_answer'},
        {'id': 'two', 'stem': '2. Second', 'answerMode': 'short_answer', 'answerPayload': {'text': 'Supplied'}},
        {'id': 'three', 'stem': '3. Third', 'answerMode': 'short_answer'},
        {'id': 'four', 'stem': 'No printed number', 'answerMode': 'short_answer'}]})
    answers = DocumentParseResult.model_validate({**base, 'questions': [
        {'id': 'answer-one', 'stem': '1', 'answerMode': 'short_answer', 'answerPayload': {'text': 'First answer'}, 'sourceText': '1: First answer'},
        {'id': 'answer-three', 'stem': '3', 'answerMode': 'short_answer', 'answerPayload': {'text': 'Third answer'}},
        {'id': 'answer-three-other', 'stem': '3', 'answerMode': 'short_answer', 'answerPayload': {'text': 'Other section third'}}]})
    matches = match_answers(target, answers)
    assert [m.status for m in matches] == ['unique', 'has_answer', 'ambiguous', 'unmatched']
    assert matches[0].candidates == [0] and matches[2].candidates == [1, 2]
    associated = associated_question(target.questions[0], answers.questions[0])
    assert associated.answerPayload and associated.sourceText == target.questions[0].sourceText
    assert target.questions[0].answerPayload is None
    from practiq_ai.errors import DocumentProcessingError
    with pytest.raises(DocumentProcessingError):
        associated_question(target.questions[0], ParsedQuestion(stem='Missing answer'))


@pytest.mark.usefixtures('disposable_databases')
async def test_answer_association_requires_confirmation_and_preserves_source_evidence(monkeypatch):
    from practiq_ai import task_api
    from practiq_ai.answer_matching import associated_question
    from practiq_ai.contracts import DocumentCorrectionSave
    from practiq_ai.errors import DocumentProcessingError
    from tests.db_support import setup_api
    from tests.support import parsed
    source_answer = parsed()
    source_answer['questions'][0].update(stem='1. First', answerMode='short_answer', answerPayload={'text': 'Source answer'}, sourceText='1. First\nAnswer: Source answer')
    questions = parsed()
    questions['questions'][0].update(stem='1. First', answerMode='short_answer', answerPayload=None)
    service, source, model = await setup_api(monkeypatch, [questions, source_answer])
    target = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(source)))
    await service.wait_idle()
    from tests.support import FakeObjectStore
    from tests.support import source as input_source
    files, answer_reference = input_source('1. First\nAnswer: Source answer')
    target_files = task_api.get_object_store()
    assert isinstance(target_files, FakeObjectStore)
    target_files.blobs.update(files.blobs)
    answer = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(answer_reference), documentRole='answers'))
    await service.wait_idle()
    before = await task_api.get_task_model(target['threadId'])
    answer_detail = await task_api.get_task_model(answer['threadId'])
    assert before.result and before.checkpointId and answer_detail.result and answer_detail.checkpointId
    matches = await task_api.answer_matches(target['threadId'], answer_detail.threadId, before.checkpointId)
    assert matches.matches[0].status == 'unique' and len(model.calls) == 2, [(q.stem, q.sourceText, q.answerPayload) for q in [*before.result.questions, *answer_detail.result.questions]]
    selected = {'taskId': answer_detail.threadId, 'checkpointId': answer_detail.checkpointId, 'questionIndex': 0}
    from practiq_ai.contracts import DocumentAnswerSource
    proposal = await task_api.answer_proposal(target['threadId'], before.checkpointId, 0, DocumentAnswerSource.model_validate(selected))
    value = associated_question(before.result.questions[0], answer_detail.result.questions[0])
    assert proposal.question.model_dump()["answerPayload"] == value.model_dump()["answerPayload"] and not proposal.corrections.edits and len(model.calls) == 2
    request = DocumentCorrectionSave.model_validate({'requestId': str(uuid4()), 'checkpointId': before.checkpointId, 'expectedRevision': None,
                         'questionIndex': 0, 'question': value.model_dump(), 'answerSource': selected})
    saved = await task_api.save_correction(target['threadId'], request)
    assert saved.edits[0].answerEvidence and saved.edits[0].answerEvidence.sourceSha256 == answer_reference['sha256']
    assert await task_api.save_correction(target['threadId'], request) == saved
    second = request.model_copy(update={'requestId': uuid4(), 'expectedRevision': request.requestId})
    with pytest.raises(DocumentProcessingError) as error:
        await task_api.save_correction(target['threadId'], second)
    assert error.value.code == 'ANSWER_REPLACEMENT_REQUIRED'
    assert (await task_api.get_task_model(target['threadId'])).result == before.result
    assert len(model.calls) == 2

    # Unrelated manual edits keep the supplied answer's proof; changing the answer clears it.
    import json
    from zipfile import ZipFile
    manual = DocumentCorrectionSave.model_validate({'requestId': str(uuid4()), 'checkpointId': before.checkpointId,
        'expectedRevision': str(request.requestId), 'questionIndex': 0,
        'question': {**saved.edits[0].question.model_dump(), 'stem': '1. Revised question wording'}})
    await task_api.save_correction(target['threadId'], manual)
    with await task_api.export_task(target['threadId'], before.checkpointId, revision_id=manual.requestId, question_indexes=[0]) as payload, ZipFile(payload) as archive:
        exported = json.loads(archive.read('questions.json'))['result']
        assert exported['questions'][0]['answerPayload'] == {'text': 'Source answer'}
        assert any(answer_reference['sha256'] in warning and 'Source answer' in warning for warning in exported['warnings'])
    changed = manual.model_copy(update={'requestId': uuid4(), 'expectedRevision': manual.requestId,
        'question': manual.question.model_copy(update={'answerPayload': {'text': 'Manual replacement'}})})
    await task_api.save_correction(target['threadId'], changed)
    with await task_api.export_task(target['threadId'], before.checkpointId, revision_id=changed.requestId) as payload, ZipFile(payload) as archive:
        assert not any(answer_reference['sha256'] in warning for warning in json.loads(archive.read('questions.json'))['result']['warnings'])
    assert len(model.calls) == 2


def test_answer_only_evidence_requires_a_literal_numbered_record_and_exact_answer():
    from practiq_ai.contracts import ParsedQuestion
    from practiq_ai.graphs.answer_evidence import retain_source_answers
    question = ParsedQuestion(stem='1', answerMode='short_answer', answerPayload={'text': 'Source answer'}, sourceText='1. Source answer')
    assert retain_source_answers([question], '1. Source answer\n2. Other answer', [], answer_sheet=True) == []
    assert question.answerPayload is not None
    for text, answer in [('1. Fabricated', 'Fabricated'), ('1. Source answer', 'Fabricated')]:
        invalid = ParsedQuestion(stem='1', answerMode='short_answer', answerPayload={'text': answer}, sourceText=text)
        assert retain_source_answers([invalid], '1. Source answer', [], answer_sheet=True)
        assert invalid.answerPayload is None


def test_selection_preserves_a_full_warning_inventory():
    from practiq_ai.bank_export import select_questions
    from practiq_ai.contracts import DocumentParseResult
    from tests.support import parsed
    result = DocumentParseResult.model_validate({**parsed(), 'questions': [{**parsed()['questions'][0], 'id': 'one'}], 'schemaVersion': 3, 'visualElements': [], 'warnings': [f'Warning {i}' for i in range(1000)], 'confidenceScore': 80})
    selected, _ = select_questions(result, [0])
    assert len(selected.warnings) == 1000 and all(f'Warning {i}' in selected.warnings[i] for i in range(1000))
    assert result.warnings[-1] == 'Warning 999'


def test_plain_answer_labels_are_validated_against_target_options():
    from practiq_ai.answer_matching import associated_question
    from practiq_ai.contracts import DocumentParseResult, ParsedQuestion
    from practiq_ai.corrections import validate_edit
    from practiq_ai.errors import DocumentProcessingError
    target = ParsedQuestion.model_validate({'id': 'one', 'stem': '1. Choose', 'answerMode': 'choice', 'choiceVariant': 'single', 'options': [{'label': 'A', 'content': 'First'}, {'label': 'B', 'content': 'Second'}]})
    tree = DocumentParseResult(questions=[target], schemaVersion=3, groups=[], visualElements=[], warnings=[], confidenceScore=80)
    supplied = ParsedQuestion(stem='1', answerMode='short_answer', answerPayload={'text': 'B'}, sourceText='1. B')
    proposed = validate_edit(target, associated_question(target, supplied), tree, 0)
    assert proposed.model_dump()['answerPayload'] == {'correct': ['B']}
    assert target.answerPayload is None and proposed.sourceText == target.sourceText
    invalid = supplied.model_copy(update={'answerPayload': {'text': 'C'}})
    with pytest.raises(DocumentProcessingError):
        validate_edit(target, associated_question(target, invalid), tree, 0)


@pytest.mark.parametrize(('mode', 'text', 'extra', 'expected'), [
    ('true_false', 'False', {}, {'value': False}),
    ('fill_blank', 'source phrase', {'blankCount': 1}, {'answers': ['source phrase']}),
    ('ordering', '1, 0', {}, {'order': [1, 0]}),
    ('matching', '0=1;1=0', {}, {'matches': [{'left': 0, 'right': 1}, {'left': 1, 'right': 0}]}),
    ('true_false', 'unclear', {}, {'text': 'unclear'}),
])
def test_literal_answer_conversion_does_not_solve_or_invent_labels(mode, text, extra, expected):
    from practiq_ai.answer_matching import associated_question
    from practiq_ai.contracts import ParsedQuestion
    target = ParsedQuestion.model_validate({'stem': '1. Target', 'answerMode': mode, **extra})
    source = ParsedQuestion(stem='1', answerMode='short_answer', answerPayload={'text': text})
    assert associated_question(target, source).model_dump()['answerPayload'] == expected
    assert target.answerPayload is None


@pytest.mark.parametrize(('stem', 'source', 'expected'), [
    ('3.5 kg of material is used.', '1. 3.5 kg of material is used.', '1'),
    ('2024: consider the population.', '2. 2024: consider the population.', '2'),
    ('3.5 kg of material is used.', None, None),
    ('Unnumbered wording', '3. Third question', '3'),
])
def test_printed_number_prefers_original_source_and_rejects_decimal_wording(stem, source, expected):
    from practiq_ai.answer_matching import printed_number
    from practiq_ai.contracts import ParsedQuestion
    assert printed_number(ParsedQuestion(stem=stem, sourceText=source)) == expected


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('action', ['pause', 'interrupt'])
async def test_cold_resume_of_selected_reparse_retains_prepared_evidence_after_parent_deletion(monkeypatch, action):
    from unittest.mock import AsyncMock

    from practiq_ai import messaging, task_api
    from practiq_ai.contracts import DocumentTaskControl
    from tests.db_support import setup_api
    from tests.support import parsed
    service, source, model = await setup_api(monkeypatch, [parsed(), parsed()])
    parent = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(source)))
    await service.wait_idle()
    original = await task_api.get_task(parent['threadId'])
    publish = messaging.publish
    monkeypatch.setattr(messaging, 'publish', AsyncMock())
    child = await task_api.reparse_task(parent['threadId'], DocumentTaskReparse.model_validate({'requestId': str(uuid4()),
        'selection': {'checkpointId': original['checkpointId'], 'units': [{'stage': 'document_parse', 'index': 0}]}}))
    await task_api.control_task(child['threadId'], DocumentTaskControl(requestId=uuid4(), action=action, runId=child['runId']))
    await service.wait_idle()
    _, snapshot, _ = await task_api._read_task(service, child['threadId'])
    assert not snapshot.values and len(model.calls) == 1
    await task_api.delete_task(parent['threadId'])
    paused = await task_api.get_task(child['threadId'])
    monkeypatch.setattr(messaging, 'publish', publish)
    resumed = await task_api.control_task(child['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=paused['checkpointId']))
    assert await task_api.control_task(child['threadId'], DocumentTaskControl(requestId=resumed['requestId'], action='resume', checkpointId=paused['checkpointId'])) == resumed
    await service.wait_idle()
    after = await task_api.get_task(child['threadId'])
    assert after['state'] == 'COMPLETED' and not after['parserJobs'] and len(model.calls) == 2


@pytest.mark.parametrize('record', ['1: B', '第1题：B', '1）B', '1. B', '第 001 题：B'])
def test_answer_sheet_proof_uses_the_same_numbering_as_matching(record):
    from practiq_ai.answer_matching import printed_number
    from practiq_ai.contracts import ParsedQuestion
    from practiq_ai.graphs.answer_evidence import retain_source_answers
    quote = record + '\nAnalysis: Literal reason'
    primary = 'Reference answers\n' + quote + '\n2. C\nAnalysis: Other reason'
    question = ParsedQuestion(stem='1', answerMode='short_answer', answerPayload={'text': 'B'}, analysis='Literal reason', sourceText=quote)
    assert printed_number(question) == '1'
    assert retain_source_answers([question], primary, [], answer_sheet=True) == []
    assert question.model_dump()['answerPayload'] == {'text': 'B'} and question.analysis == 'Literal reason'
    for text, answer in [(quote.replace('Literal reason', 'Invented reason'), 'B'), (quote, 'C')]:
        invalid = ParsedQuestion(stem='1', answerMode='short_answer', answerPayload={'text': answer}, sourceText=text)
        assert retain_source_answers([invalid], primary, [], answer_sheet=True)
        assert invalid.answerPayload is None


def test_answer_sheet_quote_cannot_borrow_an_answer_from_context_only():
    from practiq_ai.contracts import ParsedQuestion
    from practiq_ai.graphs.answer_evidence import retain_source_answers
    question = ParsedQuestion(stem='1', answerMode='short_answer', answerPayload={'text': 'B'}, sourceText='1.')
    assert retain_source_answers([question], '1.', ['Answers\n1. B'], answer_sheet=True)
    assert question.answerPayload is None
