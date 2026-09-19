import pytest
from pydantic import ValidationError

from practiq_ai import config, execution, llm
from practiq_ai.contracts import document_source_key
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from tests.support import FakeModel, local_graph, question, run_config


@pytest.mark.parametrize('key', ['LLM_TEXT_MODEL', 'LLM_VISION_MODEL'])
def test_both_models_are_required(monkeypatch, key):
    monkeypatch.delenv(key)
    with pytest.raises(ValueError, match=key):
        config.load()


def test_models_and_execution_signatures_are_distinct(monkeypatch):
    llm.get_model.cache_clear()
    monkeypatch.setenv('LLM_TEXT_MODEL', 'text-only')
    monkeypatch.setenv('LLM_VISION_MODEL', 'image-capable')
    assert llm.get_model('text').model_name == 'text-only'
    assert llm.get_model('vision').model_name == 'image-capable'
    previous = execution.new_execution()
    monkeypatch.setenv('LLM_TEXT_MODEL', 'changed')
    with pytest.raises(DocumentProcessingError, match='original deployment'):
        execution.validate_execution(previous)
    with pytest.raises(ValueError, match='Unknown model'):
        llm.get_model('invalid')
    llm.get_model.cache_clear()


def test_visual_result_rejects_invalid_final_question_index():
    from practiq_ai.contracts import DocumentParseResult
    with pytest.raises(ValidationError, match='visual questionIndexes'):
        DocumentParseResult.model_validate({'questions': [question('Q')], 'groups': [], 'warnings': [], 'confidenceScore': 80,
                                          'visualElements': [{'kind': 'image', 'description': 'x', 'questionIndexes': [1]}]})






@pytest.mark.parametrize('kind', ['text', 'csv'])
async def test_text_formats_route_to_text_model(monkeypatch, kind):
    from tests.support import source
    files, reference = source('1. Question?')
    if kind == 'csv':
        original = reference['objectKey']
        reference.update(sourceType='csv', mediaType='text/csv', objectKey=document_source_key('csv', reference['sha256']))
        files.blobs[reference['objectKey']] = files.blobs.pop(original)
    seen = []
    model = FakeModel(responses=[{'questions': [question('Question?')]}])
    def get_model(role='vision'):
        seen.append(role)
        assert role == 'text'
        return model
    monkeypatch.setattr(document, 'get_model', get_model)
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    result = await local_graph().ainvoke({'document': reference}, run_config())
    assert result['status'] == 'SUCCEEDED' and seen == ['text', 'text']
