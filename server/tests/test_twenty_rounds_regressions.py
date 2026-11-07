"""Behavior and ownership of derived objects at the measured CPU boundaries."""

from io import BytesIO
from uuid import UUID
from zipfile import ZipFile

import pytest

from practiq_ai.answer_matching import match_answers
from practiq_ai.contracts import (
    DocumentCorrections,
    DocumentParseResult,
    DocumentQuestionCorrection,
    ParsedQuestion,
)
from practiq_ai.corrections import corrected_result
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs.ocr_validation import _formula_source, question_issues
from practiq_ai.json_repair import repair_json, unique_json_object
from practiq_ai.source_selection import active_indices, page_indices
from practiq_ai.tencent_bundle import _bbox, _image_members, evidence_text
from practiq_ai.unit_results import missing_formulas


def question(identifier='q1', **values):
    return ParsedQuestion(id=identifier, stem='Printed prompt?', sourceText='1. Printed prompt?',
                          answerMode='short_answer', **values)


def result(questions):
    return DocumentParseResult(schemaVersion=3, questions=questions, groups=[], visualElements=[], warnings=[], confidenceScore=80)


def test_page_filter_preserves_original_tile_order_and_rejects_missing_original_pages():
    state = {'pageRefs': [{}, {}, {}, {}], 'inputParts': [{'sourcePage': page} for page in (0, 1, 1, 2)], 'pages': [3, 2, 2]}
    assert page_indices(state) == [1, 2, 3]
    assert state['pages'] == [3, 2, 2]
    with pytest.raises(DocumentProcessingError) as error:
        page_indices({**state, 'pages': [4]})
    assert error.value.code == 'SOURCE_SELECTION_INVALID'


def test_sparse_chunk_selection_keeps_source_order_deduplicates_and_excludes_other_stages():
    state = {'chunkRefs': [None] * 10, 'selectedUnits': [
        {'stage': 'document_parse', 'index': index} for index in (9, 2, 2, -1, 10)
    ] + [{'stage': 'vision_parse', 'index': 1}]}
    assert active_indices(state, 'document_parse') == [2, 9]
    assert active_indices({**state, 'selectedUnits': []}, 'document_parse') == []
    assert active_indices({'chunkRefs': [None] * 3}, 'document_parse') == [0, 1, 2]


def test_answer_matching_preserves_ambiguous_printed_numbers_and_supplied_false_values():
    target = result([question('q1'), question('q2'), question('q3', answerPayload={'text': '0'}),
                     ParsedQuestion(id='q4', stem='Supplied false', sourceText='3. Supplied false',
                                    answerMode='true_false', answerPayload={'value': False})])
    target.questions[2].sourceText = '2. A supplied zero'
    answers = result([question('answer1', answerPayload={'text': 'A'}), question('answer2', answerPayload={'text': 'B'})])
    initial = target.model_dump(mode='json')
    matches = match_answers(target, answers)
    assert [(item.questionIndex, item.candidates, item.status) for item in matches] == [
        (0, [0, 1], 'ambiguous'), (1, [0, 1], 'ambiguous'), (2, [], 'has_answer'), (3, [], 'has_answer'),
    ]
    assert target.model_dump(mode='json') == initial


def test_correction_replay_stops_at_revision_and_keeps_nested_snapshots_independent():
    first = question(contentBlocks=[{'partType': 'markdown', 'markdownValue': 'Original material'}])
    second = first.model_copy(update={'id': 'q2'})
    original = result([first, second])
    edits = [DocumentQuestionCorrection(requestId=UUID(int=index + 1), questionIndex=index // 2,
             question=value, savedAt='2026-11-07T00:00:00Z') for index, value in enumerate([
                 first.model_copy(update={'stem': 'First revision'}), first.model_copy(update={'stem': 'Last revision'}), second,
             ])]
    changes = DocumentCorrections(checkpointId='checkpoint', edits=edits)
    initial = original.model_dump(mode='json')
    assert corrected_result(original, changes, edits[0].requestId).questions[0].stem == 'First revision'
    assert corrected_result(original, changes, edits[1].requestId).questions[0].stem == 'Last revision'
    derived = corrected_result(original, changes)
    derived.questions[0].contentBlocks[0].markdownValue = 'Edited derived material'
    assert derived.questions[1].contentBlocks[0].markdownValue == 'Original material'
    assert edits[1].question.contentBlocks[0].markdownValue == 'Original material'
    assert original.model_dump(mode='json') == initial
    changes.edits.append(edits[0].model_copy(update={'requestId': UUID(int=99), 'questionIndex': 99}))
    assert corrected_result(original, changes, edits[1].requestId).questions[0].stem == 'Last revision'
    with pytest.raises(DocumentProcessingError) as error:
        corrected_result(original, changes)
    assert error.value.code == 'CORRECTION_CONFLICT'


@pytest.mark.parametrize('pairs', [[('a', 1), ('a', 1)], [('a', False), ('b', 0), ('a', None)]])
def test_json_object_fast_construction_still_rejects_equal_and_unequal_duplicate_fields(pairs):
    with pytest.raises(ValueError, match='Duplicate JSON field'):
        unique_json_object(pairs)
    with pytest.raises(ValueError, match='Duplicate JSON field'):
        repair_json('{"outer":{"a":1,"a":1}}')


def test_ocr_literal_extraction_preserves_newlines_order_and_scalar_exclusion():
    source = {'first': ['A\nB', None, 12, False], 'second': {'text': ' C ', 'empty': []}}
    assert evidence_text(source) == 'A\nB\n\n C '


@pytest.mark.parametrize('source,rendered,expected', [
    ('No mathematical evidence.', '', []), (r'Unclosed \(a+b', '', []),
    (r'Escaped \$x$', '', []), ('$$x^2$$', 'x^2', []),
    (r'\[a \geq b\]', r'a\ge b', []), ('Given $x^2$ and $y$.', 'x^2', ['y']),
])
def test_math_prefilter_preserves_literal_and_unfinished_formula_semantics(source, rendered, expected):
    assert missing_formulas(source, rendered) == expected


def test_formula_source_retains_prefix_and_unique_answer_math_after_early_anchor():
    value = question('page:1:1')
    source, prefix = _formula_source('Given $g$.\n1. Printed prompt?\nAnswer key\n1. $y$', [value])
    assert prefix == 'Given $g$.\n'
    assert '1. Printed prompt?' in source and '$y$' in source
    assert _formula_source('1. Printed prompt?', [value]) == ('1. Printed prompt?', '')
    invalid = value.model_copy(update={'stem': 42})
    with pytest.raises(TypeError):
        question_issues('1. Printed prompt?', [invalid], [])


@pytest.mark.parametrize('invalid', [True, '10', float('inf'), float('nan')])
def test_coordinate_optimization_keeps_non_numeric_and_non_finite_rejection(invalid):
    polygon = {key: {'x': x, 'y': y} for key, x, y in (
        ('left_top', 10, 10), ('right_top', 80, 10), ('left_bottom', 10, 90), ('right_bottom', 80, 90),
    )}
    assert _bbox({'polygon': polygon}, 100, 100) == [.1, .1, .8, .9]
    polygon['left_top']['x'] = invalid
    with pytest.raises(ValueError):
        _bbox({'polygon': polygon}, 100, 100)


def test_image_identifier_compilation_keeps_association_order_and_duplicate_rejection():
    def archive(xml):
        output = BytesIO()
        with ZipFile(output, 'w') as writer:
            writer.writestr('result_xml_full.xml', xml)
        return ZipFile(BytesIO(output.getvalue()))

    image = '<image id="p-2" page-numbers="1" src="a.png"/>'
    with archive('<root>' + image + '<image id="p-1" page-numbers="0" src="b.png"/></root>') as reader:
        assert list(_image_members(reader, {'a.png', 'b.png'}).items()) == [((1, 2), 'a.png'), ((0, 1), 'b.png')]
    with archive('<root>' + image + image + '</root>') as reader, pytest.raises(ValueError, match='Duplicate image'):
        _image_members(reader, {'a.png'})
