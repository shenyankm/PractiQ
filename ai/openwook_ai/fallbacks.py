from __future__ import annotations

from .schemas import (
    AnswerGenerationResult,
    DocumentParseRequest,
    DocumentParseResult,
    LearningReportResult,
)


def fallback_parse_document(request: DocumentParseRequest) -> DocumentParseResult:
    text = (request.text or '').strip()
    stem = text.splitlines()[0].strip() if text else 'Untitled question'
    if stem[:2].isdigit() and '. ' in stem:
        stem = stem.split('. ', 1)[1]
    question = {
        'stem': stem,
        'answerMode': 'choice',
        'questionTypeId': 'imported-choice',
        'options': [
            {'label': 'A', 'content': '4', 'isCorrect': True},
            {'label': 'B', 'content': '5', 'isCorrect': False},
        ],
        'answerPayload': {'correctOption': 'A'},
        'analysis': 'Deterministic fallback parse.',
        'contentBlocks': [
            {
                'partType': 'text',
                'role': 'stem',
                'textValue': stem,
                'markdownValue': None,
                'latexValue': None,
                'jsonValue': None,
            }
        ],
        'sourceText': text or None,
        'confidence': 0.55,
        'needsReview': True,
    }
    return DocumentParseResult.model_validate(
        {
            'questions': [question],
            'groups': [],
            'visualElements': [],
            'warnings': ['Deterministic fallback parser was used.'],
            'qualityScore': 55,
        }
    )


def fallback_generate_answer(payload: dict) -> AnswerGenerationResult:
    options = payload.get('options') or []
    canonical = options[0]['content'] if options else 'See explanation.'
    return AnswerGenerationResult.model_validate(
        {
            'answerPayload': {'correctOption': options[0]['label']} if options else {'value': canonical},
            'canonicalAnswer': canonical,
            'explanation': 'Deterministic fallback answer generation was used.',
            'steps': ['Read the prompt', 'Apply the deterministic fallback'],
            'confidence': 0.6,
            'educationalValue': 'Provides a baseline answer when no model provider is configured.',
        }
    )


def fallback_learning_report(payload: dict) -> LearningReportResult:
    label = f"User {payload.get('userId', 'unknown')}"
    return LearningReportResult.model_validate(
        {
            'summary': 'Deterministic fallback learning report was used.',
            'mastery': [
                {'label': label, 'score': 0.5, 'evidence': 'No provider configured; using fallback summary.'}
            ],
            'weakPoints': [
                {
                    'label': 'Needs provider-backed analysis',
                    'reason': 'Fallback mode has limited context.',
                    'suggestedAction': 'Retry with an AI provider configured.',
                }
            ],
            'recommendations': ['Configure an AI provider for richer analysis.'],
            'riskLevel': 'medium',
        }
    )
