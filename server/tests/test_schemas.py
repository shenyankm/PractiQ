import pytest
from pydantic import ValidationError

from practiq_ai.contracts import (
    DocumentParseInput,
    DocumentParseResult,
    DocumentUploadRequest,
    ModelCallUsage,
    ParsedQuestion,
    UnitCounts,
    VisualElement,
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


def test_upload_request_accepts_file_metadata_only() -> None:
    text = DocumentUploadRequest(
        sourceType="text",
        fileName="quiz.txt",
        mediaType="text/plain",
        sizeBytes=6,
        sha256="b" * 64,
    )
    binary = DocumentUploadRequest(
        sourceType="pdf",
        fileName="quiz.pdf",
        mediaType="application/pdf",
        sizeBytes=123,
        sha256="a" * 64,
    )

    assert text.sourceType == "text"
    assert binary.sizeBytes == 123
    for payload in (
        {"sourceType": "text"},
        {"sourceType": "text", "text": "ZmlsZSBjb250ZW50"},
        {"sourceType": "text", "url": "https://example.com/quiz.txt"},
        {"sourceType": "text", "base64": "ZmlsZSBjb250ZW50"},
        {"sourceType": "text", "contextText": "inline document text"},
        {"sourceType": "pdf", "fileName": "quiz.pdf"},
        {
            "sourceType": "pdf",
            "fileName": "quiz.pdf",
            "mediaType": "application/pdf",
            "sizeBytes": 1,
            "sha256": "bad",
        },
        {
            "sourceType": "pdf",
            "fileName": "quiz.pdf",
            "mediaType": "image/png",
            "sizeBytes": 1,
            "sha256": "a" * 64,
        },
    ):
        with pytest.raises(ValidationError):
            DocumentUploadRequest.model_validate(payload)


def test_document_parse_input_accepts_only_managed_oss_references() -> None:
    digest = "a" * 64
    valid = {
        "objectKey": f"practiq-agent/sources/{digest}/source.pdf",
        "sha256": digest,
        "mediaType": "application/pdf",
        "sizeBytes": 1,
        "sourceType": "pdf",
    }
    assert (
        DocumentParseInput.model_validate({"document": valid}).document.objectKey
        == valid["objectKey"]
    )

    for object_key in (
        "https://example.com/quiz.pdf",
        "file:///tmp/quiz.pdf",
        "data:application/pdf;base64,AAAA",
        "/tmp/quiz.pdf",
        "../quiz.pdf",
        "other-prefix/source.pdf",
    ):
        with pytest.raises(ValidationError, match="managed OSS source object"):
            DocumentParseInput.model_validate(
                {"document": {**valid, "objectKey": object_key}}
            )

    with pytest.raises(ValidationError, match="mediaType does not match"):
        DocumentParseInput.model_validate(
            {"document": {**valid, "mediaType": "image/png"}}
        )

    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        DocumentParseInput.model_validate(
            {
                "document": {
                    **valid,
                    "contextRef": {
                        "objectKey": "https://example.com/context.txt",
                        "sha256": "b" * 64,
                        "mediaType": "text/plain",
                        "sizeBytes": 1,
                    },
                },
            }
        )


def test_document_result_validates_nested_references_and_labels() -> None:
    result = DocumentParseResult.model_validate(
        {
            "questions": [question()],
            "groups": [{"title": "Section 1", "questionIndexes": [0]}],
            "visualElements": [],
            "warnings": [],
            "confidenceScore": 91,
        }
    )

    assert result.questions[0].options[0].label == "A"
    assert result.questions[0].answerPayload is not None
    assert result.questions[0].answerPayload.model_dump() == {"correctOption": "A"}
    with pytest.raises(ValidationError):
        DocumentParseResult.model_validate(
            {
                **result.model_dump(),
                "groups": [{"title": "Section 1", "questionIndexes": [1]}],
            }
        )


def test_content_blocks_and_bboxes_cannot_be_empty_or_invalid() -> None:
    for block in (
        {"partType": "text"},
        {"partType": "text", "textValue": "   "},
    ):
        invalid = question()
        invalid["contentBlocks"] = [block]
        with pytest.raises(ValidationError):
            DocumentParseResult.model_validate(
                {
                    "questions": [invalid],
                    "groups": [],
                    "visualElements": [],
                    "warnings": [],
                    "confidenceScore": 90,
                }
            )

    for bbox in ([0.5, 0, 0.4, 1], [0, 0, float("nan"), 1]):
        with pytest.raises(ValidationError):
            DocumentParseResult.model_validate(
                {
                    "questions": [question()],
                    "groups": [],
                    "visualElements": [
                        {
                            "kind": "chart",
                            "description": "bad box",
                            "bbox": bbox,
                        }
                    ],
                    "warnings": [],
                    "confidenceScore": 90,
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


def test_cross_field_contract_invariants() -> None:
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        DocumentUploadRequest.model_validate(
            {
                "sourceType": "pdf",
                "fileName": "quiz.pdf",
                "mediaType": "application/pdf",
                "sizeBytes": 1,
                "sha256": "a" * 64,
                "text": "unexpected",
            }
        )
    assert DocumentUploadRequest(
        sourceType="image",
        fileName="quiz.png",
        mediaType="image/png",
        sizeBytes=1,
        sha256="a" * 64,
    ).mediaType == "image/png"

    base = question()
    invalid_questions = (
        {**base, "answerMode": "short_answer"},
        {
            **base,
            "options": [
                {"label": "A", "content": "4"},
                {"label": "a", "content": "four"},
            ],
        },
        {**base, "answerPayload": {"text": "4"}},
        {**base, "answerPayload": {"correctOption": "B"}},
    )
    for payload in invalid_questions:
        with pytest.raises(ValidationError):
            ParsedQuestion.model_validate(payload)

    with pytest.raises(ValidationError, match="must not exceed total"):
        UnitCounts(total=1, succeeded=1, skipped=1)
    assert VisualElement(
        kind="image", description="No location", bbox=None
    ).bbox is None
