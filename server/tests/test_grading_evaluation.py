import json
from types import SimpleNamespace

import pytest

from scripts import evaluate_grading as ev


async def test_repeated_grading_includes_images_and_retains_failures(monkeypatch):
    calls = []

    async def grade(request):
        calls.append(request)
        return {"status": "failed"} if len(calls) == 1 else {"result": {"scoreCents": 200}}

    monkeypatch.setattr(ev, "grade", grade)
    monkeypatch.setattr(ev, "load", lambda: SimpleNamespace(model_id="fake"))
    report = await ev.evaluate(10)
    assert len(calls) == 50
    assert sum(bool(c.images) for c in calls) == 10
    assert report["status"] == "FAILED"
    assert report["statistics"]["full"]["failed"] == 1
    assert report["statistics"]["image_partial"]["meanCents"] == 200
    assert report["statistics"]["image_partial"]["varianceCentsSquared"] == 0


def test_statistics_keep_missing_scores_out_of_numeric_samples():
    result = ev.summarize([
        {"case": "a", "actualCents": n, "expectedCents": 200} for n in [100, 300, None]
    ])["a"]
    assert result == {"runs": 3, "graded": 2, "failed": 1, "meanCents": 200, "varianceCentsSquared": 10000,
                      "rangeCents": 200, "meanAbsoluteErrorCents": 100, "maxAbsoluteErrorCents": 100}


def test_external_anchors_require_provenance_and_valid_scores(tmp_path):
    path = tmp_path / "anchors.json"
    path.write_text('{"cases": []}')
    with pytest.raises(ValueError):
        ev.load_anchors(path)
    data = {"labelProvenance":"Teacher A, synthetic example, 2026-09-29", "cases":[{
        "name":"anchor", "expectedCents":200, "payload":{"question":{"stem":"Explain", "answerMode":"short_answer", "answerPayload":{"text":"Reference"}}, "answer":"Reference", "maxCents":200}}]}
    path.write_text(json.dumps(data))
    assert ev.load_anchors(path) == data
    data["cases"][0]["expectedCents"] = 201
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        ev.load_anchors(path)


def test_cli_failure_is_nonzero_and_existing_evidence_prevents_calls(tmp_path, monkeypatch):
    calls = []

    async def evaluate(repeats, anchors):
        calls.append((repeats, anchors))
        return {"total":1,"exactMatches":0,"status":"FAILED"}

    output = tmp_path/'report.json'
    monkeypatch.setattr(ev, 'evaluate', evaluate)
    monkeypatch.setattr(ev, 'load_dotenv', lambda *args, **kwargs: None)
    for name in ['DATABASE_URI','LANGSMITH_TRACING','LANGCHAIN_TRACING_V2']:
        monkeypatch.setenv(name, 'test')
    monkeypatch.setattr('sys.argv', ['evaluate_grading.py','--live','--output',str(output)])
    assert ev.main() == 1
    original = output.read_bytes()
    with pytest.raises(FileExistsError):
        ev.main()
    assert output.read_bytes() == original and calls == [(10, None)]


@pytest.mark.parametrize("content", [None, "{", '{"cases": []}', '{"labelProvenance":"Teacher", "cases":[{"name":"a","expectedCents":1,"payload":{}}]}'])
def test_cli_bad_anchors_exit_before_creating_report(tmp_path, monkeypatch, capsys, content):
    anchors = tmp_path / "anchors.json"
    if content is not None:
        anchors.write_text(content, encoding="utf-8")
    output = tmp_path / "report.json"
    monkeypatch.setattr("sys.argv", ["evaluate_grading.py", "--live", "--anchors", str(anchors), "--output", str(output)])
    with pytest.raises(SystemExit) as error:
        ev.main()
    assert error.value.code == 2
    assert "Invalid anchors" in capsys.readouterr().err
    assert not output.exists()
