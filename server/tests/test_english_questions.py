"""English metadata remains source content, including incomplete listening materials."""
from pathlib import Path

import pytest

from practiq_ai.contracts import (
    ContentBlock,
    DocumentParseResult,
    DocumentQuality,
    ParsedQuestion,
    QuestionSource,
)
from practiq_ai.graphs.chunking import finalize_question_ids
from tests.support import run_config, setup_graph

FIXTURE = Path(__file__).resolve().parents[2] / 'app/fixtures/english.json'


async def test_english_pipeline_keeps_metadata_and_does_not_solve(monkeypatch):
    expected = DocumentParseResult.model_validate_json(FIXTURE.read_text())
    source = '\n'.join(q.sourceText or '' for q in expected.questions)
    graph, _, _, reference, _ = setup_graph(monkeypatch, [{'questions': [q.model_dump() for q in expected.questions]}], parts=[source])
    state = await graph.ainvoke({'document': reference}, run_config())
    actual = DocumentParseResult.model_validate(state['result'])
    assert actual.schemaVersion == 3
    assert {q.questionKind for q in actual.questions if q.questionKind} == {q.questionKind for q in expected.questions if q.questionKind}
    for left, right in zip(actual.questions, expected.questions, strict=True):
        for key in ('instructions', 'audioRef', 'transcript', 'examPlayCount', 'sourceLanguage', 'targetLanguage', 'writingGenre', 'minWords', 'maxWords', 'answerPayload'):
            assert left.model_dump()[key] == right.model_dump()[key]
    assert actual.questions[-1].answerPayload is None


@pytest.mark.parametrize('patch', [
    {'questionKind': 'writing'}, {'audioEndSeconds': 1, 'audioStartSeconds': 2},
    {'examPlayCount': 0}, {'examPlayCount': True}, {'transcript': [{'partType': 'blank', 'questionId': 'x'}]},
    {'sourceLanguage': 'en'}, {'targetLanguage': 'en'}, {'minWords': 20},
])
def test_reject_incompatible_listening_fields(patch):
    with pytest.raises(ValueError):
        ParsedQuestion.model_validate({'stem': 'Listen', 'answerMode': 'listening', **patch})


@pytest.mark.parametrize('patch', [{'audioStartSeconds': 1}, {'audioEndSeconds': 2}, {'transcript': [{'partType': 'text', 'textValue': 'Secret'}]}, {'examPlayCount': 3}])
def test_audio_fields_only_belong_to_listening(patch):
    with pytest.raises(ValueError, match='audio fields'):
        ParsedQuestion.model_validate({'stem': 'Read', 'answerMode': 'reading', **patch})


def test_missing_audio_is_reviewable_without_fake_passage():
    result = DocumentParseResult.model_validate({'schemaVersion': 3, 'questions': [
        {'id': 'l', 'stem': 'Listen', 'answerMode': 'listening'},
        {'id': 'c', 'parentId': 'l', 'stem': 'What?', 'answerMode': 'short_answer'},
    ], 'groups': [], 'visualElements': [], 'warnings': [], 'confidenceScore': 0})
    assert 'media' in result.questions[0].missingFields
    assert 'material' not in result.questions[0].missingFields
    assert result.questions[0].examPlayCount == 2
    assert result.questions[0].needsReview


def test_listening_continuation_preserves_transcript_and_rejects_metadata_conflict():
    def fragments():
        return [ParsedQuestion(id='page:0:audio', stem='Listen', answerMode='listening', instructions='Listen twice', transcript=[ContentBlock(partType='text', textValue=text)]) for text in ['First turn', 'Second turn']]
    sources = [QuestionSource(questionIndex=i, stage='vision_parse', unitIndex=i) for i in range(2)]
    result = finalize_question_ids(fragments(), [], [], sources, DocumentQuality())
    assert [b.textValue for b in result[0].transcript] == ['First turn', 'Second turn']
    qs = fragments()
    qs[1].audioStartSeconds = 1
    qs[1].examPlayCount = 3
    sources = [QuestionSource(questionIndex=i, stage='vision_parse', unitIndex=i) for i in range(2)]
    merged = finalize_question_ids(qs, [], [], sources, DocumentQuality())
    assert merged[0].audioStartSeconds == 1 and merged[0].examPlayCount == 3
    qs = fragments()
    qs[0].examPlayCount = 3
    qs[1].examPlayCount = 4
    sources = [QuestionSource(questionIndex=i, stage='vision_parse', unitIndex=i) for i in range(2)]
    with pytest.raises(ValueError, match='audio metadata'):
        finalize_question_ids(qs, [], [], sources, DocumentQuality())
    qs = fragments()
    qs[1].instructions = 'Different instruction'
    sources = [QuestionSource(questionIndex=i, stage='vision_parse', unitIndex=i) for i in range(2)]
    with pytest.raises(ValueError, match='metadata'):
        finalize_question_ids(qs, [], [], sources, DocumentQuality())
