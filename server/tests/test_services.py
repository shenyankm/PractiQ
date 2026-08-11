"""Service-level unit tests not requiring a database.

Mirrors services practice grading + imports validation + media sniffing tests.
"""

from __future__ import annotations

import base64

import pytest

from server import envelope
from server.auth.runtime import User
from server.services import imports as imports_svc
from server.services import imports_upload
from server.services import media as media_svc
from server.services import users as users_svc
from server.services.practice import grade_practice_answer


def _user(membership: str = 'free', role: str = 'user') -> User:
    return User(id=1, username='u', email=None, is_active=True, role=role, membership=membership)


class _MembershipCursor:
    def __init__(self, membership: str):
        self.membership = membership

    async def fetchone(self):
        return (self.membership,)


class _MembershipConnection:
    def __init__(self, membership: str):
        self.membership = membership

    async def execute(self, *_args):
        return _MembershipCursor(self.membership)


async def test_pro_entitlement_has_no_role_bypass():
    await users_svc.require_pro_entitlement(_MembershipConnection('pro'), _user('pro'), 'AI')
    for role in ('user', 'admin'):
        with pytest.raises(envelope.APIError) as exc_info:
            await users_svc.require_pro_entitlement(
                _MembershipConnection('free'), _user('free', role), 'AI'
            )
        assert exc_info.value.code == 'PRO_REQUIRED'


# ---------------------------------------------------------- practice grading


def _key(payload) -> dict:
    import json

    return {'id': 1, 'answer_payload': json.dumps(payload)}


def test_grade_choice_answer():
    key = _key({'selected': ['A', 'B']})
    assert grade_practice_answer('choice', key, {'selected': ['B', 'A']}) is True
    assert grade_practice_answer('choice', key, {'selected': ['A']}) is False


def test_grade_true_false_answer():
    key = _key({'value': True})
    assert grade_practice_answer('true_false', key, {'value': True}) is True
    assert grade_practice_answer('true_false', key, {'value': False}) is False
    assert grade_practice_answer('true_false', key, {'value': 'yes'}) is None


def test_grade_fill_blank_answer():
    key = _key({'value': ['Paris', ' France ']})
    assert grade_practice_answer('fill_blank', key, {'value': ['paris', 'france']}) is True
    assert grade_practice_answer('fill_blank', key, {'value': ['paris']}) is False
    assert grade_practice_answer('fill_blank', key, {'value': ['lyon', 'france']}) is False


def test_grade_without_key_returns_none():
    assert grade_practice_answer('choice', None, {'selected': ['A']}) is None


# ------------------------------------------------------- imports validation


def test_normalize_import_source_type():
    assert imports_svc.normalize_import_source_type('TXT') == 'txt'
    assert imports_svc.normalize_import_source_type('text') == 'txt'
    assert imports_svc.normalize_import_source_type('') == 'txt'
    assert imports_svc.normalize_import_source_type('docx') == 'docx'
    assert imports_svc.normalize_import_source_type('pdf') == 'pdf'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.normalize_import_source_type('csv')
    assert exc_info.value.code == 'UNSUPPORTED_SOURCE_TYPE'


def test_decode_bounded_import_base64():
    payload = base64.b64encode(b'hello').decode()
    assert imports_svc.decode_bounded_import_base64(payload, 100) == b'hello'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.decode_bounded_import_base64('!!!invalid!!!', 100)
    assert exc_info.value.code == 'INVALID_FILE_CONTENT'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.decode_bounded_import_base64(base64.b64encode(b'x' * 200).decode(), 100)
    assert exc_info.value.code == 'FILE_TOO_LARGE'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.decode_bounded_import_base64(base64.b64encode(b'').decode(), 100)
    assert exc_info.value.code == 'EMPTY_FILE'


def test_validate_txt_payload():
    imports_svc.validate_import_source_payload('.txt', 'text/plain', '题目一'.encode(), 'a.txt')
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.txt', 'text/plain', b'\xff\xfe invalid', 'a.txt')
    assert exc_info.value.code == 'INVALID_FILE_CONTENT'
    with pytest.raises(envelope.APIError):
        imports_svc.validate_import_source_payload('.txt', 'text/plain', b'a\x00b', 'a.txt')
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.txt', 'text/plain', b'   ', 'a.txt')
    assert exc_info.value.code == 'EMPTY_FILE'


def test_validate_docx_payload():
    imports_svc.validate_import_source_payload('.docx', imports_svc.DOCX_MIME_TYPE, b'PK\x03\x04rest', 'a.docx')
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.docx', imports_svc.DOCX_MIME_TYPE, b'not-a-zip', 'a.docx')
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'


def test_validate_pdf_payload():
    imports_svc.validate_import_source_payload('.pdf', imports_svc.PDF_MIME_TYPE, b'%PDF-1.7 body', 'a.pdf')
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.pdf', imports_svc.PDF_MIME_TYPE, b'not-a-pdf', 'a.pdf')
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.pdf', 'text/plain', b'%PDF-1.7 body', 'a.pdf')
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'


def test_validate_xlsx_payload():
    imports_svc.validate_import_source_payload('.xlsx', imports_svc.XLSX_MIME_TYPE, b'PK\x03\x04rest', 'a.xlsx')
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.xlsx', imports_svc.XLSX_MIME_TYPE, b'not-a-zip', 'a.xlsx')
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.xlsx', imports_svc.DOCX_MIME_TYPE, b'PK\x03\x04rest', 'a.xlsx')
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'


def test_validate_import_artifact_content_pdf_xlsx():
    pdf_b64 = base64.b64encode(b'%PDF-1.7 body').decode()
    imports_svc._validate_import_artifact_content(
        'pdf', {'fileBase64': pdf_b64, 'mimeType': imports_svc.PDF_MIME_TYPE}
    )
    xlsx_b64 = base64.b64encode(b'PK\x03\x04rest').decode()
    imports_svc._validate_import_artifact_content('xlsx', {'fileBase64': xlsx_b64})
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc._validate_import_artifact_content('pdf', {})
    assert exc_info.value.code == 'FILE_REQUIRED'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc._validate_import_artifact_content('xlsx', {'fileBase64': pdf_b64})
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'


def test_resolve_import_file_extension_pdf_xlsx():
    assert imports_upload._resolve_import_file_extension('a.pdf', '') == '.pdf'
    assert imports_upload._resolve_import_file_extension('a.xlsx', '') == '.xlsx'
    assert imports_upload._resolve_import_file_extension('blob', imports_svc.PDF_MIME_TYPE) == '.pdf'
    assert imports_upload._resolve_import_file_extension('blob', imports_svc.XLSX_MIME_TYPE) == '.xlsx'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_upload._resolve_import_file_extension('a.csv', '')
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'


def test_build_import_source_artifact_content_binary_types():
    stored = imports_upload._StoredImportSource(
        relative_path='imports/1/2/source.pdf',
        object_url='oss://practiq/imports/1/2/source.pdf',
        original_name='a.pdf',
        mime_type=imports_svc.PDF_MIME_TYPE,
        size_bytes=12,
    )
    content = imports_upload._build_import_source_artifact_content(stored, 'pdf', b'%PDF-1.7body')
    assert base64.b64decode(content['fileBase64']) == b'%PDF-1.7body'
    assert 'text' not in content


# ------------------------------------------------------------ media sniffing


def test_detect_image_content_type():
    assert media_svc._detect_image_content_type(b'\x89PNG\r\n\x1a\n....') == 'image/png'
    assert media_svc._detect_image_content_type(b'\xff\xd8\xff\xe0....') == 'image/jpeg'
    assert media_svc._detect_image_content_type(b'GIF89a....') == 'image/gif'
    assert media_svc._detect_image_content_type(b'RIFF\x00\x00\x00\x00WEBP....') == 'image/webp'
    assert media_svc._detect_image_content_type(b'plain text') == 'application/octet-stream'
