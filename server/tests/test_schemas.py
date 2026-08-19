import pytest
from pydantic import TypeAdapter, ValidationError

from server.ai_schemas import (
    AnswerGenerationResult,
    DocumentParseRequest,
    DocumentParseResult,
    LearningReportRequest,
    LearningReportResult,
)


def question() -> dict:
    return {
        'stem': 'What is 2+2?',
        'answerMode': 'choice',
        'questionTypeId': 'math-mcq',
        'options': [{'label': ' A ', 'content': '4', 'isCorrect': True}],
        'answerPayload': {'correctOption': ' a '},
        'analysis': 'Simple arithmetic.',
        'contentBlocks': [{'partType': 'text', 'textValue': 'What is 2+2?'}],
        'sourceText': '1. What is 2+2?',
        'confidence': 0.9,
        'needsReview': False,
    }


def test_document_request_accepts_only_normalized_sources() -> None:
    for source_type in ('docx', 'pdf', 'xlsx'):
        assert DocumentParseRequest.model_validate(
            {'sourceType': source_type, 'fileBase64': 'eA=='}
        ).sourceType == source_type
    assert DocumentParseRequest(sourceType='text', text='# Quiz').sourceType == 'text'

    for payload in (
        {'sourceType': 'txt', 'text': 'Quiz'},
        {'sourceType': 'md', 'text': '# Quiz'},
        {'sourceType': 'csv', 'fileBase64': 'eA=='},
        {'sourceType': 'image', 'fileBase64': 'eA=='},
        {'sourceType': 'text'},
        {'sourceType': 'text', 'text': '   '},
        {'sourceType': 'text', 'text': 'Quiz', 'fileBase64': 'eA=='},
        {'sourceType': 'pdf'},
        {'sourceType': 'xls', 'fileBase64': 'eA=='},
        {'sourceType': 'text', 'text': 'Quiz', 'unexpected': True},
    ):
        with pytest.raises(ValidationError):
            DocumentParseRequest.model_validate(payload)


def _common_learning_stats() -> dict:
    return {
        'attemptCount': 3,
        'correctCount': 2,
        'accuracy': 2 / 3,
        'periodStart': '2026-08-01T00:00:00Z',
        'periodEnd': '2026-08-19T00:00:00Z',
        'knowledgePointMastery': [
            {'label': 'Addition', 'attempts': 3, 'correct': 2}
        ],
    }


def test_learning_report_request_is_scope_discriminated_and_strict() -> None:
    adapter = TypeAdapter(LearningReportRequest)
    individual = adapter.validate_python({
        'scope': 'individual',
        'stats': {
            **_common_learning_stats(),
            'accuracyTrend': [{
                'periodStart': '2026-08-01T00:00:00Z',
                'periodEnd': '2026-08-19T00:00:00Z',
                'attemptCount': 3,
                'correctCount': 2,
                'accuracy': 2 / 3,
            }],
            'weakKnowledgePoints': ['Fractions'],
        },
    })
    assert individual.scope == 'individual'

    for payload in (
        {'scope': 'individual', 'stats': _common_learning_stats()},
        {
            'scope': 'bank',
            'stats': {
                **_common_learning_stats(),
                'questionCount': 10,
                'questionTypeDistribution': [{'label': 'Choice', 'count': 10}],
                'bankId': 7,
            },
        },
        {
            'scope': 'class',
            'stats': {
                **_common_learning_stats(),
                'learnerCount': 2,
                'scoreDistribution': [],
            },
        },
        {
            'scope': 'bank',
            'stats': {
                **_common_learning_stats(),
                'questionCount': 0,
                'questionTypeDistribution': [{'label': 'Choice', 'count': 1}],
            },
        },
    ):
        with pytest.raises(ValidationError):
            adapter.validate_python(payload)


def test_document_result_validates_nested_references_and_labels() -> None:
    result = DocumentParseResult.model_validate(
        {
            'questions': [question()],
            'groups': [{'title': 'Section 1', 'questionIndexes': [0]}],
            'visualElements': [],
            'warnings': [],
            'qualityScore': 91,
        }
    )

    assert result.questions[0].options[0].label == 'A'
    assert result.questions[0].answerPayload == {'correctOption': 'A'}

    with pytest.raises(ValidationError):
        DocumentParseResult.model_validate(
            {
                **result.model_dump(),
                'groups': [{'title': 'Section 1', 'questionIndexes': [1]}],
            }
        )


def test_answer_and_learning_report_result_contracts() -> None:
    answer = AnswerGenerationResult.model_validate(
        {
            'answerPayload': {'correctOption': 'A'},
            'canonicalAnswer': '4',
            'explanation': 'Adding two and two gives four.',
            'steps': ['Add the operands'],
            'confidence': 0.9,
        }
    )
    report = LearningReportResult.model_validate(
        {
            'summary': 'Solid arithmetic fundamentals.',
            'mastery': [
                {'label': 'Addition', 'score': 0.9, 'evidence': 'Recent answers'}
            ],
            'weakPoints': [
                {
                    'label': 'Fractions',
                    'reason': 'Missed items',
                    'suggestedAction': 'Practice fractions',
                }
            ],
            'recommendations': ['Review fractions'],
            'riskLevel': 'medium',
        }
    )

    assert answer.canonicalAnswer == '4'
    assert report.riskLevel == 'medium'
