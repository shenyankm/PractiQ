import pytest
from pydantic import ValidationError

from server.ai_schemas import (
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


def test_learning_report_requires_non_empty_stats() -> None:
    with pytest.raises(ValidationError):
        LearningReportRequest.model_validate({"stats": {}})
    assert LearningReportRequest.model_validate({"stats": {"answers": 1}}).stats


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
