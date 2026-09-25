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


def test_visual_result_rejects_invalid_final_question_index():
    from practiq_ai.contracts import DocumentParseResult
    with pytest.raises(ValidationError, match='questionIds'):
        DocumentParseResult.model_validate({'schemaVersion': 3, 'questions': [{**question('Q'), 'id': 'q0'}], 'groups': [], 'warnings': [], 'confidenceScore': 80,
                                          'visualElements': [{'kind': 'image', 'description': 'x', 'questionIds': ['absent']}]})






@pytest.mark.parametrize('kind', ['text', 'csv'])
async def test_text_formats_use_unified_model(monkeypatch, kind):
    from tests.support import source
    files, reference = source('1. Question?')
    if kind == 'csv':
        original = reference['objectKey']
        reference.update(sourceType='csv', mediaType='text/csv', objectKey=document_source_key('csv', reference['sha256']))
        files.blobs[reference['objectKey']] = files.blobs.pop(original)
    seen = []
    model = FakeModel(responses=[{'questions': [question('Question?')]}])
    def get_model():
        seen.append('unified')
        return model
    monkeypatch.setattr(document, 'get_model', get_model)
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    result = await local_graph().ainvoke({'document': reference}, run_config())
    assert result['status'] == 'SUCCEEDED' and seen == ['unified', 'unified']
