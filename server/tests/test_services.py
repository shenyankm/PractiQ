"""Service-level unit tests not requiring a database.

Mirrors services practice grading + imports validation + media sniffing tests.
"""

from __future__ import annotations

import base64

import pytest

from server import envelope
from server.auth.runtime import User
from server.services import imports as imports_svc
from server.services import media as media_svc
from server.services.practice import grade_practice_answer


def _user(membership: str = 'free', role: str = 'user') -> User:
    return User(id=1, username='u', email=None, is_active=True, role=role, membership=membership)


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
    assert imports_svc.normalize_import_source_type(_user(), 'TXT') == 'txt'
    assert imports_svc.normalize_import_source_type(_user(), 'text') == 'txt'
    assert imports_svc.normalize_import_source_type(_user(), '') == 'txt'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.normalize_import_source_type(_user(), 'docx')
    assert exc_info.value.code == 'PLUS_REQUIRED'
    assert imports_svc.normalize_import_source_type(_user(membership='plus'), 'docx') == 'docx'
    assert imports_svc.normalize_import_source_type(_user(role='admin'), 'pdf') == 'pdf'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.normalize_import_source_type(_user(membership='enterprise'), 'csv')
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


# ------------------------------------------------------------ media sniffing


def test_detect_image_content_type():
    assert media_svc._detect_image_content_type(b'\x89PNG\r\n\x1a\n....') == 'image/png'
    assert media_svc._detect_image_content_type(b'\xff\xd8\xff\xe0....') == 'image/jpeg'
    assert media_svc._detect_image_content_type(b'GIF89a....') == 'image/gif'
    assert media_svc._detect_image_content_type(b'RIFF\x00\x00\x00\x00WEBP....') == 'image/webp'
    assert media_svc._detect_image_content_type(b'plain text') == 'application/octet-stream'
