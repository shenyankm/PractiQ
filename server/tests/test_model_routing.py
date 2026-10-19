import pytest
from pydantic import ValidationError

from practiq_ai import config, execution, llm
from practiq_ai.contracts import document_source_key
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from tests.support import FakeModel, local_graph, question, run_config


def test_single_model_is_required(monkeypatch):
    monkeypatch.delenv('LLM_MODEL')
    monkeypatch.setenv('LLM_TEXT_MODEL', 'old-text')
    monkeypatch.setenv('LLM_VISION_MODEL', 'old-vision')
    with pytest.raises(ValueError, match='LLM_MODEL'):
        config.load()


def test_single_model_and_execution_signature(monkeypatch):
    llm.get_model.cache_clear()
    monkeypatch.setenv('LLM_MODEL', 'image-capable')
    assert llm.get_model().model_name == 'image-capable'
    assert llm.get_model() is llm.get_model()
    previous = execution.new_execution()
    monkeypatch.setenv('LLM_MODEL', 'changed')
    with pytest.raises(DocumentProcessingError, match='original deployment'):
        execution.validate_execution(previous)
    llm.get_model.cache_clear()


@pytest.mark.parametrize('legacy_api', ['chat_completions', 'responses', 'invalid'])
def test_legacy_api_setting_cannot_override_responses(monkeypatch, legacy_api):
    llm.get_model.cache_clear()
    monkeypatch.delenv('AI_MODEL_API', raising=False)
    before = execution.new_execution()
    monkeypatch.setenv('AI_MODEL_API', legacy_api)
    try:
        model = llm.get_model()
        assert model.use_responses_api is True and model.store is False
        assert before['signature']['settings']['model_api'] == 'responses'
        execution.validate_execution(before)
    finally:
        llm.get_model.cache_clear()


def test_visual_result_rejects_invalid_final_question_index():
    from practiq_ai.contracts import DocumentParseResult
    with pytest.raises(ValidationError, match='questionIds'):
        DocumentParseResult.model_validate({'schemaVersion': 3, 'questions': [{**question('Q'), 'id': 'q0'}], 'groups': [], 'warnings': [], 'confidenceScore': 80,
                                          'visualElements': [{'kind': 'image', 'description': 'x', 'questionIds': ['absent']}]})






@pytest.mark.parametrize('kind', ['text', 'markdown'])
async def test_text_formats_use_unified_model(monkeypatch, kind):
    from tests.support import source
    files, reference = source('1. Question?')
    if kind == 'markdown':
        original = reference['objectKey']
        reference.update(sourceType='markdown', mediaType='text/markdown', objectKey=document_source_key('markdown', reference['sha256']))
        files.blobs[reference['objectKey']] = files.blobs.pop(original)
    model = FakeModel(responses=[{'questions': [question('Question?')]}])
    monkeypatch.setattr(document, 'get_model', lambda: model)
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    from tests.support import tencent_provider
    tencent_provider(monkeypatch)
    result = await local_graph().ainvoke({'document': reference}, run_config())
    assert result['status'] == 'SUCCEEDED'
    assert result['result']['questions'][0]['stem'] == 'Question?'
    assert len(model.calls) == 1
