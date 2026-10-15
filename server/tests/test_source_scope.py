import pytest

from practiq_ai.contracts import ParsedQuestion, QuestionSource
from practiq_ai.graphs.chunking import (
    build_source_evidence,
    find_duplicate_question_trees,
)


def proof_for(text, questions):
    sources = [QuestionSource(questionIndex=index, stage='document_parse', unitIndex=0) for index in range(len(questions))]
    return build_source_evidence(text, questions, sources, [{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0}])


@pytest.mark.parametrize('quote_includes_section', [False, True])
@pytest.mark.parametrize('section_line', ['Section B: Each item worth 7', 'B. Each item is worth 7 points.'])
def test_unscoped_section_content_blocks_proof_even_when_preceding_quote_includes_it(quote_includes_section, section_line):
    records = [f'{index}. Short answer: {stem}\nReference answer: A' for index, stem in enumerate(('Q', 'Other', 'Q', 'Another'), 1)]
    text = 'Section A: Each item worth 3\n\n' + '\n\n'.join((records[0], records[1] + '\n' + section_line, records[2], records[3]))
    questions = [ParsedQuestion(id=f'q{index}', stem=stem, answerMode='short_answer', answerPayload={'text': 'A'}, sourceText=record)
                 for index, (stem, record) in enumerate(zip(('Q', 'Other', 'Q', 'Another'), records, strict=True))]
    if quote_includes_section:
        questions[1].sourceText = records[1] + '\n' + section_line
    proof = proof_for(text, questions)
    assert proof == {f'q{index}': None for index in range(4)}
    assert find_duplicate_question_trees(questions, [], [], source_evidence=proof) == []


@pytest.mark.parametrize('kind,local_evidence', [
    ('Short answer', 'Points: 3\nRubric: Explain attraction\nSupplied explanation: Attraction is mutual'),
    ('Translation', 'Source passage: Local passage\nInstructions: Translate the supplied passage\nTarget language: en'),
    ('Single choice', 'A. One\nB. Two'),
    ('Matching', 'Matching policy: one_to_one\nItem left 0 (0): One\nItem right 0 (A): 1\nItem right 1 (B): 2'),
    ('Ordering', 'Item sequence 0 (0): One'),
    ('Writing', 'Genre: Invitation\nMinimum words: 80\nMaximum words: 120'),
    ('Short answer', 'Play count: 2\nTranscript: Local transcript\nNo audio file is supplied.'),
    ('Short answer', 'Do not reuse options.\nNo reference answer is supplied for this question.'),
])
def test_explicit_local_evidence_keeps_full_source_proof(kind, local_evidence):
    records = [f'{identifier}. {kind}: Q\n{local_evidence}\nReference answer: A' for identifier in (1, 3)]
    text = 'Fixed source preamble\n\n' + '\n\n'.join(records)
    questions = [ParsedQuestion(id=f'q{index}', stem='Q', sourceText=record)
                 for index, record in enumerate(records)]
    proof = proof_for(text, questions)
    assert all(proof.values()) and len(proof) == 2
    assert find_duplicate_question_trees(questions, [], [], source_evidence=proof) == [[['q0'], ['q1']]]


@pytest.mark.parametrize('field,first,second', [('Source passage', 'Snow is white', 'Snow is blue'), ('Maximum words', '120', '150')])
def test_local_source_fields_remain_literal_even_when_model_quote_omits_them(field, first, second):
    kind = 'Writing' if field == 'Maximum words' else 'Translation'
    quotes = [f'{identifier}. {kind}: Q\nReference answer: A' for identifier in (1, 3)]
    text = '\n\n'.join(quote + f'\n{field}: {value}' for quote, value in zip(quotes, (first, second), strict=True))
    questions = [ParsedQuestion(id=f'q{index}', stem='Q', sourceText=quote) for index, quote in enumerate(quotes)]
    proof = proof_for(text, questions)
    assert all(proof.values())
    assert find_duplicate_question_trees(questions, [], [], source_evidence=proof) == []
