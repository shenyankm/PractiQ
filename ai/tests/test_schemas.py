from importlib import import_module

import pytest
from pydantic import BaseModel, ValidationError


DOCUMENT_SOURCE_TYPES = ("docx", "txt", "text")
ANSWER_MODES = ("choice", "true_false", "fill_blank", "short_answer")


def require_schema_model(name: str) -> type[BaseModel]:
    try:
        module = import_module("openwook_ai.schemas")
    except ModuleNotFoundError as exc:
        pytest.fail(f"Migration contract missing module openwook_ai.schemas: {exc}")

    try:
        model = getattr(module, name)
    except AttributeError:
        pytest.fail(f"Migration contract missing class {name} in openwook_ai.schemas")

    assert isinstance(model, type), f"{name} must be a class"
    assert issubclass(model, BaseModel), f"{name} must be a Pydantic BaseModel"
    return model


def assert_field_names(model: type[BaseModel], expected: tuple[str, ...]) -> None:
    assert tuple(model.model_fields) == expected


def assert_validation_error(model: type[BaseModel], payload: dict, field_name: str) -> None:
    with pytest.raises(ValidationError) as excinfo:
        model.model_validate(payload)

    assert field_name in str(excinfo.value)


def make_option() -> dict:
    return {"label": "A", "content": "4", "isCorrect": True}


def make_content_block() -> dict:
    return {
        "partType": "text",
        "role": "stem",
        "textValue": "What is 2+2?",
        "markdownValue": None,
        "latexValue": None,
        "jsonValue": None,
    }


def make_parsed_question(answer_mode: str = "choice") -> dict:
    return {
        "stem": "What is 2+2?",
        "answerMode": answer_mode,
        "questionTypeId": "math-mcq",
        "options": [make_option()],
        "answerPayload": {"correctOption": "A"},
        "analysis": "Simple arithmetic.",
        "contentBlocks": [make_content_block()],
        "sourceText": "1. What is 2+2?",
        "confidence": 0.9,
        "needsReview": False,
    }


def make_group() -> dict:
    return {
        "title": "Section 1",
        "instructions": "Choose the best answer.",
        "questionIndexes": [0],
    }


def make_visual_element() -> dict:
    return {
        "kind": "table",
        "label": "Data table",
        "description": "Two-column lookup table",
        "extractedText": "1 2 3 4",
    }


def make_answer_generation_result() -> dict:
    return {
        "answerPayload": {"correctOption": "A"},
        "canonicalAnswer": "4",
        "explanation": "Adding two and two gives four.",
        "steps": ["Identify the operands", "Add them together"],
        "confidence": 0.82,
        "educationalValue": "Reinforces basic addition.",
    }


def make_learning_report_result() -> dict:
    return {
        "summary": "Solid arithmetic fundamentals with one weak spot.",
        "mastery": [
            {
                "label": "Addition",
                "score": 0.92,
                "evidence": "Answered 11 of 12 addition questions correctly.",
            }
        ],
        "weakPoints": [
            {
                "label": "Fractions",
                "reason": "Missed equivalent fraction questions.",
                "suggestedAction": "Practice simplifying and comparing fractions.",
            }
        ],
        "recommendations": ["Review fraction basics", "Retry the last quiz tomorrow"],
        "riskLevel": "medium",
    }


@pytest.mark.parametrize("source_type", DOCUMENT_SOURCE_TYPES)
def test_document_parse_request_accepts_public_source_types(source_type: str) -> None:
    model = require_schema_model("DocumentParseRequest")

    assert_field_names(
        model,
        (
            "importJobId",
            "bankId",
            "sourceType",
            "fileName",
            "text",
            "fileBase64",
            "mimeType",
        ),
    )

    validated = model.model_validate(
        {
            "importJobId": 12,
            "bankId": 34,
            "sourceType": source_type,
            "fileName": "questions.docx",
            "text": "1. What is 2+2?",
            "fileBase64": "ZmlsZQ==",
            "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }
    )

    assert validated.model_dump() == {
        "importJobId": 12,
        "bankId": 34,
        "sourceType": source_type,
        "fileName": "questions.docx",
        "text": "1. What is 2+2?",
        "fileBase64": "ZmlsZQ==",
        "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }


def test_document_parse_request_rejects_non_public_source_type() -> None:
    model = require_schema_model("DocumentParseRequest")

    assert_validation_error(model, {"sourceType": "unknown"}, "sourceType")


def test_parsed_question_uses_exact_fields_and_answer_mode_literals() -> None:
    model = require_schema_model("ParsedQuestion")

    assert_field_names(
        model,
        (
            "stem",
            "answerMode",
            "questionTypeId",
            "options",
            "answerPayload",
            "analysis",
            "contentBlocks",
            "sourceText",
            "confidence",
            "needsReview",
        ),
    )

    for answer_mode in ANSWER_MODES:
        validated = model.model_validate(make_parsed_question(answer_mode))
        dumped = validated.model_dump()
        assert dumped["answerMode"] == answer_mode
        assert dumped["options"] == [make_option()]
        assert dumped["contentBlocks"] == [make_content_block()]

    invalid_payload = make_parsed_question("essay")
    assert_validation_error(model, invalid_payload, "answerMode")


def test_parsed_question_rejects_renamed_nested_fields() -> None:
    model = require_schema_model("ParsedQuestion")

    invalid_option_payload = make_parsed_question()
    invalid_option_payload["options"] = [{"label": "A", "text": "4"}]
    assert_validation_error(model, invalid_option_payload, "content")

    invalid_content_block_payload = make_parsed_question()
    invalid_content_block_payload["contentBlocks"] = [{"role": "stem", "textValue": "x"}]
    assert_validation_error(model, invalid_content_block_payload, "partType")


def test_document_parse_result_requires_exact_top_level_and_nested_fields() -> None:
    model = require_schema_model("DocumentParseResult")

    assert_field_names(
        model,
        (
            "questions",
            "groups",
            "visualElements",
            "warnings",
            "qualityScore",
        ),
    )

    validated = model.model_validate(
        {
            "questions": [make_parsed_question()],
            "groups": [make_group()],
            "visualElements": [make_visual_element()],
            "warnings": ["Low-confidence OCR on item 3"],
            "qualityScore": 91,
        }
    )

    dumped = validated.model_dump()
    assert dumped["groups"] == [make_group()]
    assert dumped["visualElements"] == [make_visual_element()]
    assert dumped["warnings"] == ["Low-confidence OCR on item 3"]
    assert dumped["qualityScore"] == 91

    invalid_group_payload = {
        "questions": [make_parsed_question()],
        "groups": [{"title": "Section 1", "instructions": "Read carefully"}],
        "visualElements": [make_visual_element()],
        "warnings": [],
        "qualityScore": 75,
    }
    assert_validation_error(model, invalid_group_payload, "questionIndexes")

    invalid_visual_payload = {
        "questions": [make_parsed_question()],
        "groups": [make_group()],
        "visualElements": [{"type": "table", "description": "Missing kind field"}],
        "warnings": [],
        "qualityScore": 75,
    }
    assert_validation_error(model, invalid_visual_payload, "kind")


def test_answer_generation_result_contract() -> None:
    model = require_schema_model("AnswerGenerationResult")

    assert_field_names(
        model,
        (
            "answerPayload",
            "canonicalAnswer",
            "explanation",
            "steps",
            "confidence",
            "educationalValue",
        ),
    )

    validated = model.model_validate(make_answer_generation_result())
    assert validated.model_dump() == make_answer_generation_result()

    invalid_payload = make_answer_generation_result()
    invalid_payload.pop("canonicalAnswer")
    assert_validation_error(model, invalid_payload, "canonicalAnswer")


def test_learning_report_result_contract() -> None:
    model = require_schema_model("LearningReportResult")

    assert_field_names(
        model,
        (
            "summary",
            "mastery",
            "weakPoints",
            "recommendations",
            "riskLevel",
        ),
    )

    validated = model.model_validate(make_learning_report_result())
    assert validated.model_dump() == make_learning_report_result()

    invalid_mastery_payload = make_learning_report_result()
    invalid_mastery_payload["mastery"] = [{"label": "Addition", "score": 0.5}]
    assert_validation_error(model, invalid_mastery_payload, "evidence")

    invalid_weak_point_payload = make_learning_report_result()
    invalid_weak_point_payload["weakPoints"] = [{"label": "Fractions", "reason": "Missed items"}]
    assert_validation_error(model, invalid_weak_point_payload, "suggestedAction")

    invalid_risk_payload = make_learning_report_result()
    invalid_risk_payload["riskLevel"] = "urgent"
    assert_validation_error(model, invalid_risk_payload, "riskLevel")
