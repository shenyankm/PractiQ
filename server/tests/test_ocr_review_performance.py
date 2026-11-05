"""Fidelity boundaries of the bounded OCR review optimizations."""

import json
from copy import deepcopy
from io import BytesIO
from typing import Any
from zipfile import ZipFile

import pytest

from practiq_ai.config import load
from practiq_ai.contracts import ParsedQuestion
from practiq_ai.graphs.ocr_validation import question_issues
from practiq_ai.graphs.source_context import source_context
from practiq_ai.tencent_bundle import decode_bundle
from practiq_ai.unit_results import missing_formulas


@pytest.mark.parametrize('source,rendered,expected', [
    ('No printed formula', r'$invented$', []),
    (r'Unclosed $x+1', '', []),
    ('Empty $ $ formula', '', []),
    (r'Escaped \$x+1\$', '', []),
    (r'$x+1$ and \(y-2\)', 'x + 1', ['y-2']),
    (r'$$x+1$$ and \[y-2\]', 'y-2', ['x+1']),
    (r'$x+1$ then $x+1$', '', ['x+1', 'x+1']),
    (r'$a\geq b$ then $c\leq d$', r'a\ge b c\le d', []),
])
def test_lazy_formula_normalization_keeps_token_and_literal_rules(source, rendered, expected):
    assert missing_formulas(source, rendered) == expected


@pytest.mark.parametrize('ids', [['page:1:7', 'page:1:8'], [None, None], ['page:1:7', 'page:2:7']])
def test_number_index_keeps_missing_and_ambiguous_owners_reviewable(ids):
    questions = [ParsedQuestion(id=identifier, stem=stem, answerMode='short_answer')
                 for identifier, stem in zip(ids, ['First?', 'Second?'], strict=True)]
    saved = [q.model_dump() for q in questions]
    issues = question_issues('7. First?\n8. Second?', questions, [])
    assert not issues
    assert [q.model_dump() for q in questions] == saved


def test_repeated_printed_number_is_not_silently_collapsed():
    questions = [ParsedQuestion(id='page:1:7', stem='Repeated?', answerMode='short_answer')]
    issues = question_issues('7. Repeated?\n7. Repeated?', questions, [])
    assert any('repeated questions must not collapse' in issue for issue in issues)


def test_formula_before_questions_still_marks_every_question_for_review():
    questions = [ParsedQuestion(id='page:1:7', stem='Printed?', answerMode='short_answer')]
    assert not question_issues('Given $a+b$\n7. Printed?', questions, [])
    assert questions[0].needsReview


@pytest.mark.parametrize('failed', [0, 1, 5, 11])
def test_context_barrier_includes_both_endpoints_and_preserves_cap(failed):
    pages: list[dict[str, Any]] = [{'elements': [{'text_info': {'content': f'{i + 1}. See pages 1-12.'}}]} for i in range(12)]
    pages[failed] = {'failed': True}
    saved = deepcopy(pages)
    plans, incomplete = source_context(pages)
    assert plans[failed] == []
    for index, selected in enumerate(plans):
        assert len(selected) <= 8 and selected == sorted(set(selected))
        assert all(not min(index, other) <= failed <= max(index, other) for other in selected)
    assert all(index in incomplete for index in range(12) if index != failed)
    assert pages == saved


def test_answer_page_index_retains_all_associations_and_number_ambiguity():
    def page(text):
        return {'elements': [{'text_info': {'content': text}}]}

    pages = [page('7. Printed?'), *[page('material') for _ in range(4)],
             page('Answer key\n7. A'), page('Answer key\n7. B')]
    plans, incomplete = source_context(pages)
    assert plans[0] == [0, 1, 5, 6] and not incomplete
    pages[2] = page('7. Another question?')
    plans, incomplete = source_context(pages)
    assert plans[0] == [0, 1] and not incomplete


def test_native_table_image_index_preserves_page_and_xml_order():
    output = BytesIO()
    with ZipFile(output, 'w') as archive:
        archive.writestr('source_xml_full.xml', '<root>' + ''.join(
            f'<image id="p-{identifier}" page-numbers="{page}" src="images/{identifier}.png"/>'
            for page, identifier in [(1, 9), (0, 27), (1, 2), (0, 3)]) + '</root>')
        for identifier in [9, 27, 2, 3]:
            archive.writestr(f'images/{identifier}.png', b'not-read-by-decoder')
        for page in [2, 1, 0]:
            archive.writestr(f'source_ocr_page{page}.json', json.dumps({'table_name': str(page), 'fields': [], 'rows': []}))
    pages = decode_bundle(output.getvalue(), load(), page_count=3)
    assert [page['page'] for page in pages] == [0, 1, 2]
    assert [[figure['elementIndex'] for figure in page['figures']] for page in pages] == [[27, 3], [9, 2], []]
    assert all(figure['bbox'] is None for page in pages for figure in page['figures'])
