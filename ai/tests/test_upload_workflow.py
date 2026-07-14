from __future__ import annotations

import json
from io import BytesIO
from typing import Any, cast
from zipfile import ZipFile

import httpx
import pytest
from fastapi.testclient import TestClient

from openwook_ai import main
from openwook_ai.documents import NormalizedDocument
from openwook_ai.fallbacks import fallback_parse_document
from openwook_ai.schemas import DocumentParseRequest, DocumentParseResult


TOKEN = 'test-ai-token'


def make_docx() -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, 'w') as archive:
        archive.writestr('word/document.xml', '<w:document><w:t>Question</w:t></w:document>')
    return buffer.getvalue()


@pytest.mark.parametrize(
    ('path', 'file_name', 'content_type', 'content', 'source_type', 'parse_method'),
    (
        ('/internal/ai/upload-text', 'questions.txt', 'text/plain', b'Question', 'txt', 'auto'),
        (
            '/internal/ai/upload-document',
            'questions.docx',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            make_docx(),
            'docx',
            'auto',
        ),
        (
            '/internal/ai/upload-document',
            'questions.pdf',
            'application/pdf',
            b'%PDF-1.7\nquestion',
            'pdf',
            'auto',
        ),
        (
            '/internal/ai/upload-scan',
            'scan.png',
            'image/png',
            b'\x89PNG\r\n\x1a\nimage',
            'image',
            'ocr',
        ),
        (
            '/internal/ai/upload-scan',
            'scan.pdf',
            'application/pdf',
            b'%PDF-1.7\nscan',
            'pdf',
            'ocr',
        ),
    ),
)
def test_upload_routes_send_validated_files_through_the_shared_workflow(
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    file_name: str,
    content_type: str,
    content: bytes,
    source_type: str,
    parse_method: str,
) -> None:
    from openwook_ai.schemas import FileUploadWorkflowRequest

    captured: list[tuple[str, FileUploadWorkflowRequest]] = []

    def invoke(operation: str, payload: FileUploadWorkflowRequest):
        captured.append((operation, payload))
        return fallback_parse_document(
            DocumentParseRequest(sourceType='text', text='Parsed question')
        )

    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)
    monkeypatch.setattr(main, 'invoke_workflow', invoke)
    client = TestClient(main.app)

    response = client.post(
        path,
        files={'file': (file_name, content, content_type)},
        data={'importJobId': '12', 'bankId': '34'},
        headers={'Authorization': f'Bearer {TOKEN}'},
    )

    assert response.status_code == 200
    assert response.json()['questions'][0]['stem'] == 'Parsed question'
    assert len(captured) == 1
    operation, payload = captured[0]
    assert operation == 'parse_upload'
    assert payload.importJobId == 12
    assert payload.bankId == 34
    assert payload.sourceType == source_type
    assert payload.fileName == file_name
    assert payload.fileBytes == content
    assert payload.mimeType == content_type
    assert payload.parseMethod == parse_method


def test_upload_routes_require_the_existing_service_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)
    client = TestClient(main.app)

    response = client.post(
        '/internal/ai/upload-text',
        files={'file': ('questions.txt', b'Question', 'text/plain')},
    )
    raw_token = client.post(
        '/internal/ai/upload-text',
        files={'file': ('questions.txt', b'Question', 'text/plain')},
        headers={'Authorization': TOKEN},
    )

    assert response.status_code == 401
    assert raw_token.status_code == 401


def test_upload_routes_fail_closed_when_service_token_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv('AI_SERVICE_TOKEN', raising=False)
    client = TestClient(main.app)

    response = client.post(
        '/internal/ai/upload-text',
        files={'file': ('questions.txt', b'Question', 'text/plain')},
    )

    assert response.status_code == 503


def test_upload_route_rejects_oversized_files_before_running_the_workflow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)
    monkeypatch.setenv('IMPORT_SOURCE_MAX_BYTES', '4')
    monkeypatch.setattr(
        main,
        'invoke_workflow',
        lambda *_: pytest.fail('oversized upload reached the workflow'),
    )
    client = TestClient(main.app)

    response = client.post(
        '/internal/ai/upload-text',
        files={'file': ('questions.txt', b'12345', 'text/plain')},
        headers={'Authorization': f'Bearer {TOKEN}'},
    )

    assert response.status_code == 413


def test_upload_middleware_rejects_an_oversized_request_before_multipart_parsing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)
    monkeypatch.setenv('IMPORT_SOURCE_MAX_BYTES', '4')
    client = TestClient(main.app)

    response = client.post(
        '/internal/ai/upload-text',
        content=b'x' * (1024 * 1024 + 5),
        headers={
            'Authorization': f'Bearer {TOKEN}',
            'Content-Type': 'multipart/form-data; boundary=x',
        },
    )

    assert response.status_code == 413


def test_upload_middleware_limits_streamed_request_bodies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)
    monkeypatch.setenv('IMPORT_SOURCE_MAX_BYTES', '4')
    client = TestClient(main.app)
    prefix = (
        b'--x\r\n'
        b'Content-Disposition: form-data; name="file"; filename="questions.txt"\r\n'
        b'Content-Type: text/plain\r\n\r\n'
    )

    response = client.post(
        '/internal/ai/upload-text',
        content=iter(
            (
                prefix,
                b'x' * (512 * 1024),
                b'x' * (512 * 1024 + 5),
                b'\r\n--x--\r\n',
            )
        ),
        headers={
            'Authorization': f'Bearer {TOKEN}',
            'Content-Type': 'multipart/form-data; boundary=x',
        },
    )

    assert response.status_code == 413


def test_upload_middleware_guards_the_legacy_base64_json_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)
    monkeypatch.setenv('IMPORT_SOURCE_MAX_BYTES', '4')
    client = TestClient(main.app)

    response = client.post(
        '/internal/ai/parse-document',
        content=b'x' * (1024 * 1024 + 17),
        headers={
            'Authorization': f'Bearer {TOKEN}',
            'Content-Type': 'application/json',
        },
    )

    assert response.status_code == 413


def test_upload_route_rejects_an_extension_outside_its_file_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)
    client = TestClient(main.app)

    response = client.post(
        '/internal/ai/upload-text',
        files={'file': ('questions.pdf', b'%PDF-1.7', 'application/pdf')},
        headers={'Authorization': f'Bearer {TOKEN}'},
    )

    assert response.status_code == 415


def test_upload_route_rejects_an_overlong_file_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('AI_SERVICE_TOKEN', TOKEN)
    client = TestClient(main.app)

    response = client.post(
        '/internal/ai/upload-text',
        files={'file': (f'{"x" * 252}.txt', b'Question', 'text/plain')},
        headers={'Authorization': f'Bearer {TOKEN}'},
    )

    assert response.status_code == 400


def test_parse_upload_workflow_preprocesses_parses_and_persists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from openwook_ai import workflows
    from openwook_ai.schemas import FileUploadWorkflowRequest

    calls: list[tuple[str, object]] = []

    def preprocess(payload: FileUploadWorkflowRequest) -> NormalizedDocument:
        calls.append(('preprocess', payload))
        return NormalizedDocument(
            text='MinerU markdown',
            html=None,
            warnings=['OCR confidence was low.'],
            visual_hints=[],
            metadata={'mineru': {'version': '3.4.4'}},
        )

    def parse(payload: DocumentParseRequest):
        calls.append(('parse', payload))
        return fallback_parse_document(payload)

    def persist(payload, result, preprocessing) -> None:
        calls.append(('persist', (payload, result, preprocessing)))

    monkeypatch.setattr(workflows, 'preprocess_upload', preprocess)
    monkeypatch.setattr(workflows, 'parse_document_with_agent', parse)
    monkeypatch.setattr(workflows, 'persist_document_parse', persist)
    payload = FileUploadWorkflowRequest(
        importJobId=12,
        bankId=34,
        sourceType='pdf',
        fileName='scan.pdf',
        fileBytes=b'%PDF-1.7',
        mimeType='application/pdf',
        parseMethod='ocr',
    )

    result = cast(DocumentParseResult, workflows.invoke_workflow('parse_upload', payload))

    assert [name for name, _ in calls] == ['preprocess', 'parse', 'persist']
    normalized_request = calls[1][1]
    assert isinstance(normalized_request, DocumentParseRequest)
    assert normalized_request.text == 'MinerU markdown'
    assert normalized_request.fileBase64 is None
    assert result.warnings == [
        'OCR confidence was low.',
        'Deterministic fallback parser was used.',
    ]


def test_document_agent_uses_configured_openai_compatible_json_api(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from openwook_ai import workflows

    expected = fallback_parse_document(
        DocumentParseRequest(sourceType='text', text='Agent parsed question')
    )
    captured: dict[str, Any] = {}

    class Response:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *_: object) -> None:
            return None

        @staticmethod
        def iter_bytes():
            yield json.dumps(
                {
                    'choices': [
                        {'message': {'content': json.dumps(expected.model_dump())}}
                    ]
                }
            ).encode()

    class Client:
        def __init__(self, **kwargs: object) -> None:
            captured['client'] = kwargs

        def __enter__(self):
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def stream(self, method: str, url: str, **kwargs: object) -> Response:
            captured['method'] = method
            captured['url'] = url
            captured.update(kwargs)
            return Response()

    monkeypatch.setenv('OPENAI_BASE_URL', 'http://agent:9000/v1/')
    monkeypatch.setenv('OPENAI_API_KEY', 'secret')
    monkeypatch.setenv('OPENAI_MODEL', 'parser-model')
    monkeypatch.setattr(workflows.httpx, 'Client', Client)

    result = workflows.parse_document_with_agent(
        DocumentParseRequest(sourceType='text', text='Question source')
    )

    assert result == expected
    assert captured['method'] == 'POST'
    assert captured['url'] == 'http://agent:9000/v1/chat/completions'
    assert captured['headers'] == {'Authorization': 'Bearer secret'}
    assert captured['json']['model'] == 'parser-model'
    assert captured['json']['response_format'] == {'type': 'json_object'}


def test_agent_rejects_input_that_cannot_be_processed_without_truncation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from openwook_ai import workflows
    from openwook_ai.documents import DocumentProcessingError

    monkeypatch.delenv('OPENAI_BASE_URL', raising=False)
    monkeypatch.delenv('OPENAI_MODEL', raising=False)
    with pytest.raises(DocumentProcessingError) as exc_info:
        workflows.parse_document_with_agent(
            DocumentParseRequest(
                sourceType='text',
                text='x' * (workflows.MAX_AGENT_INPUT_CHARS + 1),
            )
        )

    assert exc_info.value.status_code == 413


def test_mineru_preprocessing_returns_markdown_and_structured_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from openwook_ai import documents
    from openwook_ai.schemas import FileUploadWorkflowRequest

    captured: dict[str, Any] = {}

    class Response:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *_: object) -> None:
            return None

        @staticmethod
        def iter_bytes():
            yield json.dumps(
                {
                    'backend': 'pipeline',
                    'version': '3.4.4',
                    'results': {
                        'scan': {
                            'md_content': '# Question\nWhat is 2 + 2?',
                        }
                    },
                }
            ).encode()

    class Client:
        def __init__(self, **kwargs: object) -> None:
            captured['client'] = kwargs

        def __enter__(self):
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def stream(self, method: str, url: str, **kwargs: object) -> Response:
            captured['method'] = method
            captured['url'] = url
            captured.update(kwargs)
            return Response()

    monkeypatch.setenv('MINERU_API_URL', 'http://mineru:8000/')
    monkeypatch.setattr(documents.httpx, 'Client', Client)
    payload = FileUploadWorkflowRequest(
        sourceType='image',
        fileName='scan.png',
        fileBytes=b'\x89PNG\r\n\x1a\nimage',
        mimeType='image/png',
        parseMethod='ocr',
    )

    document = documents.preprocess_upload(payload)

    assert document.text == '# Question\nWhat is 2 + 2?'
    assert document.metadata['byteLength'] == len(payload.fileBytes)
    mineru_metadata = cast(dict[str, object], document.metadata['mineru'])
    assert mineru_metadata == {'backend': 'pipeline', 'version': '3.4.4'}
    assert captured['method'] == 'POST'
    assert captured['url'] == 'http://mineru:8000/file_parse'
    assert captured['data']['parse_method'] == 'ocr'
    assert captured['data']['return_md'] == 'true'
    assert captured['data']['return_content_list'] == 'false'


def test_provider_responses_are_streamed_with_a_hard_size_limit() -> None:
    from openwook_ai.documents import DocumentProcessingError, read_limited_response

    with pytest.raises(DocumentProcessingError) as exc_info:
        read_limited_response(
            httpx.Response(200, content=b'12345'),
            4,
            'response too large',
        )

    assert exc_info.value.status_code == 502


def test_document_parse_persistence_writes_the_existing_ai_artifact_table(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from openwook_ai.persistence import persist_document_parse
    from openwook_ai.schemas import FileUploadWorkflowRequest

    executed: list[tuple[str, tuple[object, ...]]] = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def execute(self, query: str, params: tuple[object, ...]):
            executed.append((query, params))
            return self

        @staticmethod
        def fetchone() -> tuple[int]:
            return (91,)

    monkeypatch.setenv('AI_POSTGRES_URL', 'postgres://openwook:test@db/openwook')
    monkeypatch.setattr('openwook_ai.persistence.psycopg.connect', lambda _: Connection())
    request = FileUploadWorkflowRequest(
        importJobId=12,
        bankId=34,
        sourceType='txt',
        fileName='questions.txt',
        fileBytes=b'Secret source text',
        mimeType='text/plain',
    )
    result = fallback_parse_document(
        DocumentParseRequest(sourceType='text', text='Parsed question')
    )

    persist_document_parse(request, result, {'byteLength': len(request.fileBytes)})

    assert len(executed) == 1
    query, params = executed[0]
    assert 'INSERT INTO ai_artifacts' in query
    assert 'FROM question_import_jobs' in query
    assert params[0:3] == (12, 34, 34)
    assert b'Secret source text' not in repr(params).encode()
    assert getattr(params[-1], 'obj')['questions'][0]['stem'] == 'Parsed question'
    assert getattr(params[-1], 'obj')['questions'][0]['sourceText'] is None


def test_file_upload_persistence_requires_a_database_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from openwook_ai.documents import DocumentProcessingError
    from openwook_ai.persistence import persist_document_parse
    from openwook_ai.schemas import FileUploadWorkflowRequest

    monkeypatch.delenv('AI_POSTGRES_URL', raising=False)
    request = FileUploadWorkflowRequest(
        sourceType='txt',
        fileName='questions.txt',
        fileBytes=b'Question',
        mimeType='text/plain',
    )
    result = fallback_parse_document(
        DocumentParseRequest(sourceType='text', text='Parsed question')
    )

    with pytest.raises(DocumentProcessingError) as exc_info:
        persist_document_parse(request, result)

    assert exc_info.value.status_code == 503
