import pytest
from pydantic import ValidationError

from practiq_ai.product.ai_schemas import (
    AnswerGenerationResult,
    DocumentParseRequest,
    DocumentParseResult,
    LearningReportRequest,
    LearningReportResult,
    ModelCallUsage,
)


def question() -> dict:
    return {
        "stem": "What is 2+2?",
        "answerMode": "choice",
        "questionTypeId": "math-mcq",
        "options": [{"label": " A ", "content": "4", "isCorrect": True}],
        "answerPayload": {"correctOption": " a "},
        "analysis": "Simple arithmetic.",
        "contentBlocks": [{"partType": "text", "textValue": "What is 2+2?"}],
        "sourceText": "1. What is 2+2?",
        "confidence": 0.9,
        "needsReview": False,
    }


def test_document_request_accepts_only_normalized_sources() -> None:
    for source_type in ("csv", "docx", "image", "pdf", "xlsx"):
        assert (
            DocumentParseRequest.model_validate(
                {"sourceType": source_type, "fileBase64": "eA=="}
            ).sourceType
            == source_type
        )
    assert DocumentParseRequest(sourceType="text", text="# Quiz").sourceType == "text"

    for payload in (
        {"sourceType": "txt", "text": "Quiz"},
        {"sourceType": "md", "text": "# Quiz"},
        {"sourceType": "text"},
        {"sourceType": "text", "text": "   "},
        {"sourceType": "text", "text": "Quiz", "fileBase64": "eA=="},
        {"sourceType": "pdf"},
        {"sourceType": "xls", "fileBase64": "eA=="},
        {"sourceType": "text", "text": "Quiz", "unexpected": True},
    ):
        with pytest.raises(ValidationError):
            DocumentParseRequest.model_validate(payload)


def test_document_result_validates_nested_references_and_labels() -> None:
    result = DocumentParseResult.model_validate(
        {
            "questions": [question()],
            "groups": [{"title": "Section 1", "questionIndexes": [0]}],
            "visualElements": [],
            "warnings": [],
            "qualityScore": 91,
        }
    )

    assert result.questions[0].options[0].label == "A"
    assert result.questions[0].answerPayload == {"correctOption": "A"}

    with pytest.raises(ValidationError):
        DocumentParseResult.model_validate(
            {
                **result.model_dump(),
                "groups": [{"title": "Section 1", "questionIndexes": [1]}],
            }
        )


def test_usage_contract_rejects_product_ids_and_negative_tokens() -> None:
    payload = {
        "callKey": "00000000-0000-0000-0000-000000000001",
        "modelId": "model",
        "inputTokens": 10,
        "outputTokens": 5,
        "callKind": "document_parse",
    }
    assert ModelCallUsage.model_validate(payload).inputTokens == 10
    for invalid in ({**payload, "userId": 1}, {**payload, "inputTokens": -1}):
        with pytest.raises(ValidationError):
            ModelCallUsage.model_validate(invalid)


def report_stats() -> dict:
    return {
        "attemptCount": 4,
        "correctCount": 3,
        "accuracy": 0.75,
        "startedAt": "2026-01-01T00:00:00Z",
        "endedAt": "2026-01-01T01:00:00Z",
        "mastery": [{"label": "Algebra", "attempts": 4, "correct": 3}],
    }


def test_learning_report_accepts_each_strict_scope() -> None:
    variants = (
        (
            "individual",
            {
                "accuracyTrend": [{"label": "Week 1", "accuracy": 0.75}],
                "weakKnowledgePoints": ["Fractions"],
            },
        ),
        (
            "bank",
            {
                "questionCount": 10,
                "questionTypeDistribution": [{"label": "Choice", "count": 10}],
            },
        ),
        (
            "class",
            {"learnerCount": 3, "scoreDistribution": [{"label": "80-100", "count": 2}]},
        ),
    )
    for scope, extra in variants:
        assert (
            LearningReportRequest.model_validate(
                {"scope": scope, "stats": {**report_stats(), **extra}}
            ).scope
            == scope
        )


def test_learning_report_rejects_invalid_or_mismatched_stats() -> None:
    individual = {
        **report_stats(),
        "accuracyTrend": [{"label": "Week 1", "accuracy": 0.75}],
        "weakKnowledgePoints": ["Fractions"],
    }
    invalid = (
        {"scope": "individual", "stats": {**individual, "correctCount": 5}},
        {
            "scope": "individual",
            "stats": {
                **individual,
                "mastery": [{"label": "Algebra", "attempts": 1, "correct": 2}],
            },
        },
        {
            "scope": "individual",
            "stats": {
                **individual,
                "startedAt": "2026-01-01T00:00:00",
                "endedAt": "2026-01-01T01:00:00",
            },
        },
        {
            "scope": "individual",
            "stats": {**individual, "endedAt": "2025-12-31T23:00:00Z"},
        },
        {"scope": "bank", "stats": individual},
        {"scope": "individual", "stats": {**individual, "userId": 1}},
        {"scope": "individual", "stats": {**report_stats(), "weakKnowledgePoints": []}},
    )
    for payload in invalid:
        with pytest.raises(ValidationError):
            LearningReportRequest.model_validate(payload)


def test_answer_and_learning_report_result_contracts() -> None:
    answer = AnswerGenerationResult.model_validate(
        {
            "answerPayload": {"correctOption": "A"},
            "canonicalAnswer": "4",
            "explanation": "Adding two and two gives four.",
            "steps": ["Add the operands"],
            "confidence": 0.9,
        }
    )
    report = LearningReportResult.model_validate(
        {
            "summary": "Solid arithmetic fundamentals.",
            "mastery": [
                {"label": "Addition", "score": 0.9, "evidence": "Recent answers"}
            ],
            "weakPoints": [
                {
                    "label": "Fractions",
                    "reason": "Missed items",
                    "suggestedAction": "Practice fractions",
                }
            ],
            "recommendations": ["Review fractions"],
            "riskLevel": "medium",
        }
    )

    assert answer.canonicalAnswer == "4"
    assert report.riskLevel == "medium"
