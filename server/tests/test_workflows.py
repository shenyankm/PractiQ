import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

import server.agents.generator as generator
import server.agents.model as model_factory
import server.agents.parser as parser
import server.agents.vision as vision
from server.extractors import DocumentProcessingError
from server.ai_schemas import (
    AnswerGenerationResult,
    DocumentParseRequest,
    DocumentParseResult,
    LearningReportResult,
)
from server.services.users import LLMConfig


class FakeModel:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = list(responses)
        self.calls: list[list[Any]] = []

    async def generate_structured_output(self, messages, structured_model):
        self.calls.append(list(messages))
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return SimpleNamespace(content=item)


@pytest.mark.parametrize(
    'provider',
    ('anthropic', 'dashscope', 'deepseek', 'gemini', 'moonshot', 'openai', 'xai'),
)
def test_builds_every_supported_provider(provider: str) -> None:
    text, vision_model = model_factory.build_models(
        LLMConfig(provider, 'test-key', 'text-model', None)
    )
    assert text is not None
    assert vision_model is None


def question_dict(stem: str) -> dict[str, Any]:
    return {
        'stem': stem,
        'answerMode': 'short_answer',
        'questionTypeId': 'imported-short',
        'options': [],
        'contentBlocks': [{'partType': 'text', 'textValue': stem}],
        'confidence': 0.8,
        'needsReview': False,
    }


def parse_request(text: str = '1. What is 2+2?') -> DocumentParseRequest:
    return DocumentParseRequest(sourceType='text', text=text)


def test_parse_merges_chunks_and_computes_quality(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeModel(
        [
            {'questions': [question_dict('1. First'), question_dict('2. Second')], 'groups': []},
            {'questions': [question_dict('2. Second'), question_dict('3. Third')], 'groups': []},
        ]
    )
    monkeypatch.setattr(parser, 'split_into_chunks', lambda _text: ['chunk a', 'chunk b'])

    result = asyncio.run(parser.parse_document(fake, None, parse_request()))

    assert isinstance(result, DocumentParseResult)
    assert [q.stem for q in result.questions] == ['1. First', '2. Second', '3. Third']
    assert result.qualityScore == 80.0
    assert 'Fragment 1 of 2' in fake.calls[0][1].get_text_content()


def test_parse_retries_on_validation_error_with_feedback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeModel(
        [
            {'questions': [{'stem': ''}], 'groups': []},  # 校验失败
            {'questions': [question_dict('1. Fixed')], 'groups': []},
        ]
    )
    result = asyncio.run(parser.parse_document(fake, None, parse_request()))

    assert isinstance(result, DocumentParseResult)
    assert result.questions[0].stem == '1. Fixed'
    assert len(fake.calls) == 2
    retry_feedback = fake.calls[1][-1].get_text_content()
    assert 'failed validation' in retry_feedback


def test_parse_skips_exhausted_chunk_but_keeps_others(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bad = {'questions': [{'stem': ''}], 'groups': []}
    fake = FakeModel(
        [
            bad, bad, bad,  # 块 1 三次校验失败
            {'questions': [question_dict('2. Works')], 'groups': []},
        ]
    )
    monkeypatch.setattr(parser, 'split_into_chunks', lambda _text: ['chunk a', 'chunk b'])

    result = asyncio.run(parser.parse_document(fake, None, parse_request()))

    assert isinstance(result, DocumentParseResult)
    assert [q.stem for q in result.questions] == ['2. Works']
    assert any('failed validation' in warning for warning in result.warnings)


def test_parse_fails_when_all_chunks_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    bad = {'questions': [{'stem': ''}], 'groups': []}
    fake = FakeModel([bad, bad, bad])
    with pytest.raises(DocumentProcessingError) as exc_info:
        asyncio.run(parser.parse_document(fake, None, parse_request()))

    assert exc_info.value.status_code == 502


def test_parse_maps_transport_errors_to_502(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeModel([RuntimeError('connection reset')])
    with pytest.raises(DocumentProcessingError) as exc_info:
        asyncio.run(parser.parse_document(fake, None, parse_request()))

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == 'AI agent request failed'


def test_generate_answer_and_report_use_the_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    answer_payload = {
        'answerPayload': {'correctOption': 'A'},
        'canonicalAnswer': '4',
        'explanation': 'Two plus two equals four.',
        'steps': ['Add the operands'],
        'confidence': 0.95,
    }
    report_payload = {
        'summary': 'Limited context report.',
        'mastery': [],
        'weakPoints': [],
        'recommendations': ['Practice more'],
        'riskLevel': 'low',
    }
    fake = FakeModel([answer_payload, report_payload])
    answer = asyncio.run(generator.generate_answer(fake, {'stem': 'What is 2+2?'}))
    report = asyncio.run(generator.learning_report(fake, {'userId': 7}))

    assert isinstance(answer, AnswerGenerationResult)
    assert answer.canonicalAnswer == '4'
    assert isinstance(report, LearningReportResult)
    assert report.riskLevel == 'low'


def test_vision_ocr_crops_figures_with_bboxes() -> None:
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new('RGB', (200, 200), 'white').save(buffer, format='PNG')
    page_png = buffer.getvalue()

    fake_vl = FakeModel(
        [
            {
                'text': 'OCR text with $x^2$',
                'figures': [
                    {
                        'kind': 'chart',
                        'description': 'A bar chart',
                        'bbox': [0.1, 0.1, 0.6, 0.6],
                    }
                ],
            }
        ]
    )

    text, visual_elements, warnings = asyncio.run(
        vision.ocr_pages(fake_vl, [page_png])
    )

    assert text == 'OCR text with $x^2$'
    assert warnings == []
    element = visual_elements[0]
    assert element.kind == 'chart'
    assert element.page == 0
    assert element.bbox == [0.1, 0.1, 0.6, 0.6]
    assert element.imageBase64  # 裁剪出的 JPEG base64
