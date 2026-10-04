import hashlib
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError

from practiq_ai import config
from practiq_ai.contracts import (
    DocumentReference,
    DocumentTaskCreate,
    DocumentUploadRequest,
)
from practiq_ai.errors import DocumentProcessingError
from tests.support import object_store

OFFICE = {
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}


def office_reference(kind='docx'):
    return DocumentReference.model_validate({'sourceType': kind, 'fileName': f'quiz.{kind}',
        'mediaType': OFFICE[kind], 'sha256': 'a' * 64, 'sizeBytes': 10,
        'objectKey': f'practiq-agent/sources/{"a" * 64}/source.{kind}'})


@pytest.mark.parametrize('kind', OFFICE)
async def test_office_upload_verifies_original_bytes_and_family_before_publishing(tmp_path, kind):
    stem = '中文 试卷' if kind in {'doc', 'docx'} else '中文 表格'
    fixture = Path(__file__).parents[2] / f'app/fixtures/office/{stem}.{kind}'
    payload = fixture.read_bytes()
    request = DocumentUploadRequest.model_validate({'sourceType': kind, 'fileName': fixture.name,
        'mediaType': OFFICE[kind], 'sizeBytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()})
    store = object_store(tmp_path)
    reference = await store.put_document(payload, request)
    assert reference.objectKey.endswith(f'/source.{kind}')
    assert await store.get_verified(reference) == payload
    bad = b'not an Office container'
    invalid = request.model_copy(update={'sizeBytes': len(bad), 'sha256': hashlib.sha256(bad).hexdigest()})
    with pytest.raises(DocumentProcessingError) as error:
        await store.put_document(bad, invalid)
    assert error.value.code == 'OFFICE_INPUT_INVALID'
    assert not (tmp_path / f'practiq-agent/sources/{invalid.sha256}/source.{kind}').exists()


def test_office_mode_defaults_pdf_but_is_explicit_request_identity():
    reference = office_reference()
    request_id = uuid4()
    default = DocumentTaskCreate(requestId=request_id, document=reference)
    assert default.officeMode == 'pdf'
    text = DocumentTaskCreate(requestId=request_id, document=reference, officeMode='text')
    assert text.model_dump() != default.model_dump()
    with pytest.raises(ValidationError):
        DocumentTaskCreate.model_validate({'requestId': request_id, 'document': reference, 'officeMode': 'shell'})
    with pytest.raises(ValidationError):
        DocumentTaskCreate(requestId=request_id, document=reference, graphId='pdf_parser')
    normal = reference.model_copy(update={'sourceType': 'text', 'mediaType': 'text/plain',
        'objectKey': f'practiq-agent/sources/{reference.sha256}/source.txt'})
    with pytest.raises(ValidationError):
        DocumentTaskCreate(requestId=request_id, document=normal, officeMode='text')


def test_office_deployment_requires_explicit_absolute_engine_and_version(monkeypatch, tmp_path):
    monkeypatch.setenv('AI_OFFICE_EXECUTABLE', 'soffice')
    monkeypatch.setenv('AI_OFFICE_VERSION', 'LibreOffice 26.8.0.3')
    with pytest.raises(ValueError, match='absolute'):
        config.load()
    engine = tmp_path / 'soffice'
    engine.write_bytes(b'fixture')
    monkeypatch.setenv('AI_OFFICE_EXECUTABLE', str(engine))
    monkeypatch.delenv('AI_OFFICE_VERSION')
    with pytest.raises(ValueError, match='AI_OFFICE_VERSION'):
        config.load()
    monkeypatch.setenv('AI_OFFICE_VERSION', 'LibreOffice 26.8.0.3')
    assert config.load().office_executable == engine
    assert config.load().office_version == 'LibreOffice 26.8.0.3'
