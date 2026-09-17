import os
import uuid
from pathlib import Path
from urllib.parse import quote

import psycopg
import pytest
from fastapi.testclient import TestClient

from practiq_backend.app import create_app
from practiq_backend.core import Settings


@pytest.fixture
def app(tmp_path):
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.fail("TEST_DATABASE_URL must point to a disposable PostgreSQL database")
    schema = "test_" + uuid.uuid4().hex
    with psycopg.connect(url, autocommit=True) as db:
        db.execute(f'CREATE SCHEMA "{schema}"')
        db.execute(f'SET search_path TO "{schema}"')
        db.execute(Path(__file__).resolve().parents[2].joinpath("db/00_schema.sql").read_text())
    scoped = url + ("&" if "?" in url else "?") + "options=" + quote(f"-csearch_path={schema}")
    settings = Settings(
        database_url=scoped,
        media_dir=tmp_path / "media",
        ai_token="test-service-token",
        web_dist=tmp_path / "web",
    )
    application = create_app(settings)
    yield application
    with psycopg.connect(url, autocommit=True) as db:
        db.execute(f'DROP SCHEMA "{schema}" CASCADE')


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        yield client


def write(client, method, path, body=None, key=None, **kwargs):
    return client.request(
        method, "/api/v1" + path, json=body, headers={"Idempotency-Key": key or str(uuid.uuid4())}, **kwargs
    )


@pytest.fixture
def content(client):
    b = write(client, "POST", "/banks", {"name": "测试题库"}).json()["data"]
    payload = {
        "questionTypeId": "choice",
        "answerMode": "choice",
        "choiceVariant": "single",
        "stem": "1 + 1 = ?",
        "status": "active",
        "options": [{"label": "A", "content": "2"}, {"label": "B", "content": "3"}],
        "answerPayload": {"correct": ["A"]},
    }
    response = write(client, "POST", f"/banks/{b['id']}/questions", payload)
    assert response.status_code == 201, response.text
    return b, response.json()["data"]
