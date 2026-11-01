"""Tencent evidence fidelity and recovery, without remote provider calls."""

import json
from copy import deepcopy
from io import BytesIO
from typing import Any, cast
from unittest.mock import AsyncMock
from uuid import uuid4
from zipfile import ZipFile

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import ValidationError

from practiq_ai import tencent
from practiq_ai.config import load
from practiq_ai.contracts import ArtifactReference, ParsedQuestion, document_source_key
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document
from practiq_ai.graphs.source_context import source_context
from practiq_ai.tencent_bundle import decode_bundle
from tests.support import (
    FakeModel,
    MemoryStore,
    local_graph,
    make_image,
    ocr_text_page,
    question,
    run_config,
    source,
    tencent_provider,
)


async def merge_pages(monkeypatch, pages, questions, *, index=0, failure_policy='return_partial'):
    files, reference = source('Immutable synthetic PDF source')
    reference.update(sourceType='pdf', mediaType='application/pdf')
    refs = [(await files.put_artifact(json.dumps(page).encode(), source_sha256=reference['sha256'],
             kind='ocr-page', index=i, media_type='application/json')).model_dump() for i, page in enumerate(pages)]
    plans, incomplete = source_context(pages)
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    state = cast(document.DocumentState, {
        'document': reference, 'pageRefs': refs, 'ocrPageRefs': refs, 'visualTotal': len(pages),
        'contextPages': plans, 'contextIncomplete': incomplete, 'failurePolicy': failure_policy,
        'visionResults': [{'index': index, 'kind': 'page', 'artifact': refs[index],
                           'parsed': {'questions': questions}, 'visuals': []}],
    })
    return await document._merge(state, passive=True)


@pytest.mark.parametrize('answer_page', [1, 2, 7])
@pytest.mark.parametrize('failed_between', [False, True])
async def test_final_answer_proof_uses_the_same_bounded_source_links(monkeypatch, answer_page, failed_between):
    pages = [ocr_text_page('Other material') for _ in range(answer_page + 1)]
    pages[0] = ocr_text_page('17. Printed question?')
    pages[answer_page] = ocr_text_page('Answer key\n17. 4')
    if failed_between and answer_page > 1:
        pages[1] = {'failed': True}
    row = {**question('Printed question?'), 'id': 'page:1:17', 'answerPayload': {'text': '4'}}
    result = await merge_pages(monkeypatch, pages, [row])
    expected = None if failed_between and answer_page > 1 else {'text': '4'}
    assert result['result']['questions'][0]['answerPayload'] == expected


@pytest.fixture
def native_image_bundle():
    image = make_image()
    output = BytesIO()
    with ZipFile(output, 'w') as archive:
        archive.writestr('source_ocr_page0.json', json.dumps({'table_name': 'Sheet1', 'fields': [], 'rows': []}))
        archive.writestr('source_xml_full.xml', '<body><image id="p-9" page-numbers="0" src="images/figure.png"/></body>')
        archive.writestr('images/figure.png', image)
    return output.getvalue(), image


def test_native_table_retains_xml_linked_images_without_inventing_coordinates(native_image_bundle):
    page = decode_bundle(native_image_bundle[0], load(), page_count=1)[0]
    assert page['figures'] == [{'elementIndex': 9, 'kind': 'image', 'bbox': None, 'imageMember': 'images/figure.png'}]


@pytest.mark.parametrize('reorder_only', [False, True])
def test_context_preserves_coordinate_free_image_identity(reorder_only):
    source_token = document.OCR_FIGURES.set([{'elementIndex': index, 'bbox': None} for index in (9, 27)])
    try:
        rows = [{**question(stem), 'id': f'page:1:{index}'} for index, stem in enumerate(['First?', 'Second?'], 1)]
        figures = [{'elementIndex': index, 'description': 'Source image', 'extractedText': text if reorder_only else None,
                    'questionIndexes': [0 if reorder_only else owner]}
                   for owner, (index, text) in enumerate([(9, 'Left image'), (27, 'Right image')])]
        primary = document.OcrPageParseResult.model_validate({'questions': rows, 'figures': figures})
        primary_token = document.PRIMARY_PAGE.set(primary._validated_page)
        try:
            if reorder_only:
                enriched = document.OcrPageParseResult.model_validate({'questions': rows, 'figures': list(reversed(figures))})
                assert [figure.elementIndex for figure in enriched.figures] == [9, 27]
                assert {figure.elementIndex: figure.extractedText for figure in enriched.figures} == {9: 'Left image', 27: 'Right image'}
                assert '_figure_ids' not in enriched._validated_page.model_dump()
            else:
                swapped = [{**figure, 'questionIndexes': [1 - figure['questionIndexes'][0]]} for figure in figures]
                with pytest.raises(ValidationError, match='PRIMARY figure'):
                    document.OcrPageParseResult.model_validate({'questions': rows, 'figures': swapped})
        finally:
            document.PRIMARY_PAGE.reset(primary_token)
    finally:
        document.OCR_FIGURES.reset(source_token)


async def test_native_table_image_survives_prepare_structuring_and_final_merge(monkeypatch, native_image_bundle):
    files, reference = source('Synthetic Office container')
    files.blobs[(key := document_source_key('docx', reference['sha256']))] = files.blobs.pop(reference['objectKey'])
    reference.update(sourceType='docx', mediaType='application/vnd.openxmlformats-officedocument.wordprocessingml.document', objectKey=key)
    monkeypatch.setattr(document.ObjectStore, '_validate_office', lambda *_: None)
    response = {'questions': [{**question('Printed question?'), 'id': 'page:1:1'}],
                'groups': [{'title': 'Sheet1', 'questionIndexes': [0]}],
                'figures': [{'elementIndex': 9, 'questionIndexes': [0], 'description': 'Source diagram'}]}
    invalid = deepcopy(response)
    invalid['figures'][0]['bbox'] = [0, 0, 1, 1]
    model = FakeModel(responses=[invalid, response])
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    calls = tencent_provider(monkeypatch, [{}])
    monkeypatch.setattr(tencent, 'download_result', AsyncMock(return_value=native_image_bundle[0]))
    result = await local_graph().ainvoke({'document': reference})
    visual = result['result']['visualElements'][0]
    assert visual['bbox'] is None and visual['questionIds'] == ['q0']
    assert await files.get_verified(ArtifactReference.model_validate(visual['imageRef'])) == native_image_bundle[1]
    assert len(model.calls) == 2 and len(calls) == 2
    assert result['result']['questions'][0]['needsReview']


@pytest.fixture
def ocr_validation():
    def validate(text, questions, extra_elements=()):
        page = {**ocr_text_page(text), 'page': 0, 'figures': []}
        page['elements'].extend(extra_elements)
        page_token = document.OCR_PAGE.set(page)
        text_token = document.OCR_TEXT.set(text)
        figure_token = document.OCR_FIGURES.set([])
        try:
            return document.OcrPageParseResult.model_validate({'questions': questions, 'figures': []})
        finally:
            document.OCR_FIGURES.reset(figure_token)
            document.OCR_TEXT.reset(text_token)
            document.OCR_PAGE.reset(page_token)
    return validate


def test_ordinary_ocr_question_omission_enters_output_correction(ocr_validation):
    first = {**question('First question?'), 'id': 'page:1:1'}
    with pytest.raises(ValidationError, match='source question'):
        ocr_validation('1. First question?\n2. Second question?', [first])


def test_ordinary_ocr_question_order_follows_source_positions(ocr_validation):
    rows = [{**question(stem), 'id': f'page:1:{number}'} for number, stem in
            [(2, 'First question?'), (1, 'Second question?')]]
    text = '2. First question?\n1. Second question?'
    assert [q.stem for q in ocr_validation(text, rows).questions] == ['First question?', 'Second question?']
    with pytest.raises(ValidationError, match='reading order'):
        ocr_validation(text, list(reversed(rows)))


def test_ordinary_ocr_questions_cannot_collapse_repeated_wording(ocr_validation):
    first = {**question('Repeated question?'), 'id': 'page:1:1'}
    with pytest.raises(ValidationError, match='separate record'):
        ocr_validation('1. Repeated question?\n2. Repeated question?', [first])


def test_unnumbered_questions_and_reused_numbers_keep_literal_source_order(ocr_validation):
    rows = [question('First question?'), question('Second question?')]
    for text in ['First question?\nSecond question?', '1. First question?\n1. Second question?']:
        ocr_validation(text, rows)
        with pytest.raises(ValidationError, match='reading order'):
            ocr_validation(text, list(reversed(rows)))


def test_numbered_passage_material_and_answer_keys_are_not_extra_questions(ocr_validation):
    row = {**question('Choose a line?'), 'id': 'page:1:3', 'answerMode': 'reading', 'questionKind': 'reading',
           'passage': [{'partType': 'text', 'textValue': '1. Who are you?\n2. Where are you?'}]}
    assert len(ocr_validation('1. Who are you?\n2. Where are you?\n3. Choose a line?\nAnswer key\n1. A\n2. B', [row]).questions) == 1
    assert ocr_validation('Answer key\n1. Where are you?', []).questions == []


def test_numbered_writing_material_does_not_invent_new_questions(ocr_validation):
    row = {**question('Write an essay'), 'questionKind': 'writing', 'contentBlocks': [
        {'partType': 'text', 'role': 'material', 'textValue': '1. Who are you?\n2. Where are you?'},
    ]}
    assert len(ocr_validation('Write an essay\n1. Who are you?\n2. Where are you?', [row]).questions) == 1


def test_ambiguous_numbered_statements_remain_reviewable(ocr_validation):
    row = {**question('Describe the process'), 'id': 'page:1:1', 'needsReview': False}
    parsed = ocr_validation('1. Describe the process\n2. Further context without question cues', [row])
    assert parsed.questions[0].needsReview


@pytest.mark.parametrize('formula', [r'\frac{a}{b}', r'\sqrt{x}', r'x_i^2', r'\int_0^1 x dx'])
def test_missing_formulas_are_flagged_even_when_the_model_omits_the_quote(ocr_validation, formula):
    row = {**question('Compute the expression?'), 'id': 'page:1:1'}
    with pytest.raises(ValidationError, match='formula'):
        ocr_validation(f'1. Compute the expression? Given ${formula}$.', [row])
    row['contentBlocks'].append({'partType': 'formula', 'latexValue': formula})
    assert ocr_validation(f'1. Compute the expression? Given ${formula}$.', [row]).questions[0].contentBlocks[-1].latexValue == formula


@pytest.mark.parametrize('formula', [r'\frac{a}{b}', r'\sqrt{x}', r'x_i^2'])
def test_portable_formula_review_checks_more_than_integrals(formula):
    row = ParsedQuestion.model_validate({**question('Compute'), 'sourceText': f'Given ${formula}$'})
    parsed = document.ChunkParseResult.model_validate({'questions': [row.model_dump()]}).questions[0]
    assert parsed.needsReview and 'material' in parsed.missingFields


@pytest.mark.parametrize('delimiters', [('$', '$'), ('$$', '$$'), (r'\(', r'\)'), (r'\[', r'\]')])
def test_formula_delimiters_preserve_literal_math(ocr_validation, delimiters):
    formula = r'\sqrt{x}+\frac{1}{2}'
    row = {**question('Compute?'), 'id': 'page:1:1', 'contentBlocks': [{'partType': 'formula', 'latexValue': formula}]}
    ocr_validation(f'1. Compute? {delimiters[0]}{formula}{delimiters[1]}', [row])


def test_nested_tencent_formula_is_checked_without_model_source_text(ocr_validation):
    row = {**question('Compute?'), 'id': 'page:1:1'}
    elements = [{'formula_info': {'content': r'\sqrt{x}'}}]
    with pytest.raises(ValidationError, match='formula'):
        ocr_validation('1. Compute?', [row], elements)
    row['contentBlocks'].append({'partType': 'formula', 'latexValue': r'\sqrt{x}'})
    ocr_validation('1. Compute?', [row], elements)


def test_matrix_cell_boundaries_are_part_of_formula_fidelity(ocr_validation):
    formula = r'\begin{matrix}1&23\\4&5\end{matrix}'
    changed = r'\begin{matrix}12&3\\4&5\end{matrix}'
    row = {**question('Compute?'), 'id': 'page:1:1', 'contentBlocks': [{'partType': 'formula', 'latexValue': changed}]}
    with pytest.raises(ValidationError, match='formula'):
        ocr_validation(f'1. Compute? $${formula}$$', [row])


def test_escaped_dollar_inside_math_does_not_bypass_formula_validation(ocr_validation):
    formula = r'a+\$b'
    row = {**question('Compute?'), 'id': 'page:1:1', 'contentBlocks': [{'partType': 'formula', 'latexValue': 'b'}]}
    with pytest.raises(ValidationError, match='formula'):
        ocr_validation(f'1. Compute? ${formula}$', [row])
    row['contentBlocks'][0]['latexValue'] = formula
    ocr_validation(f'1. Compute? ${formula}$', [row])


async def test_semantic_failure_can_retry_saved_ocr_without_submitting_tencent_again(monkeypatch):
    files, reference = source('Synthetic PDF source')
    files.blobs[(key := document_source_key('pdf', reference['sha256']))] = files.blobs.pop(reference['objectKey'])
    reference.update(sourceType='pdf', mediaType='application/pdf', objectKey=key)
    rows = [{**question(stem), 'id': f'page:1:{index}'} for index, stem in enumerate(['First question?', 'Second question?'], 1)]
    invalid = {'questions': rows[:1], 'figures': []}
    model = FakeModel(responses=[invalid, invalid])
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(text='', page_images=[make_image()])))
    calls = tencent_provider(monkeypatch, [ocr_text_page('1. First question?\n2. Second question?')])
    graph = local_graph(InMemorySaver(), store=MemoryStore())
    result = await graph.ainvoke({'document': reference}, run_config())
    assert result['status'] == 'PARTIAL' and not result['result']['questions']
    assert result['processing']['failures'][0]['code'] == 'OUTPUT_STALLED'
    model.responses.append({'questions': rows, 'figures': []})
    retried = await graph.ainvoke({'document': reference, 'retry': {'requestId': str(uuid4()), 'units': []}}, run_config())
    assert [q['stem'] for q in retried['result']['questions']] == ['First question?', 'Second question?']
    assert len(calls) == 2 and len(model.calls) == 3


async def test_review_policy_pauses_for_semantic_quality_flags(monkeypatch):
    interrupts: list[dict[str, Any]] = []
    def accept(payload):
        interrupts.append(deepcopy(payload))
        return {'action': 'accept_partial'}
    monkeypatch.setattr(document, 'interrupt', accept)
    state = cast(document.DocumentState, {'failurePolicy': 'review', 'result': {'questions': [{}]},
        'processing': {'quality': {'issues': [{'questionIndex': 0, 'code': 'NEEDS_REVIEW'}]}}})
    assert (await document._review(state, phase='result'))['nextStage'] == 'finish'
    assert len(interrupts) == 1 and interrupts[0]['qualityIssues'][0]['code'] == 'NEEDS_REVIEW'
