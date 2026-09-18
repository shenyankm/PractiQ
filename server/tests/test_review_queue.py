import json

from practiq_ai import telemetry
from scripts import review_queue


def candidate(index, source="text", status="SUCCEEDED", review=False):
    return {"event": "review_candidate", "threadId": f"thread-{index}", "runId": f"run-{index}",
            "sourceType": source, "status": status, "reviewRequired": review}


def test_local_review_sampling_deduplicates_and_preserves_all_failures(tmp_path):
    events = [candidate(i, source) for source in ("text", "pdf") for i in range(2000)]
    # Each run has one format; stable IDs still span distinct format strata.
    for i, event in enumerate(events):
        event.update(threadId=f"thread-{i}", runId=f"run-{i}")
    required = [candidate("bad", status="ERROR"), candidate("partial", status="PARTIAL"), candidate("review", review=True)]
    events.extend(required)
    events.extend(required)
    report = review_queue.select_reviews(events)
    assert all(any(item["threadId"] == event["threadId"] for item in report["items"]) for event in required)
    assert report == review_queue.select_reviews(list(reversed(events)))
    assert 50 < report["selectedByFormat"]["pdf"] < 150
    assert report["observedByFormat"] == {"text": 2003, "pdf": 2000}
    log = tmp_path / "events.jsonl"
    log.write_text("\n".join(json.dumps({**event, "messages": "PRIVATE", "objectKey": "PRIVATE"}) for event in required))
    output = tmp_path / "queue.json"
    assert review_queue.main([str(log), "--output", str(output)]) == 0
    assert "PRIVATE" not in output.read_text()
    assert output.with_suffix(".md").is_file()
    assert review_queue.main([str(log), "--output", str(output)]) == 2


def test_event_capture_is_scoped_and_excludes_content_fields(caplog):
    with caplog.at_level("INFO", logger="practiq.events"), telemetry.capture_events() as events:
        telemetry.event("stage", stage="prepare", outcome="success", messages="PRIVATE", image="PRIVATE", exception="PRIVATE", signedUrl="PRIVATE", apiKey="PRIVATE")
    telemetry.event("stage", stage="merge")
    assert len(events) == 1 and events[0]["stage"] == "prepare"
    assert "PRIVATE" not in json.dumps(events) + caplog.text


def test_review_decisions_are_partial_validated_and_content_free(tmp_path):
    log = tmp_path / 'events.jsonl'
    log.write_text('\n'.join(json.dumps(candidate(i, review=True)) for i in range(2)))
    decisions = tmp_path / 'decisions.json'
    decision = {'threadId': 'thread-0', 'runId': 'run-0', 'verdict': 'incorrect', 'errorCategory': 'model_output'}
    decisions.write_text(json.dumps([decision]))
    output = tmp_path / 'reviewed.json'
    args = [str(log), '--decisions', str(decisions), '--output', str(output)]
    assert review_queue.main(args) == 0
    report = json.loads(output.read_text())
    assert report['items'][0]['verdict'] == 'incorrect'
    assert report['items'][1]['verdict'] is None
    assert '待复核' in output.with_suffix('.md').read_text()
    invalid = [
        [decision, decision], [{**decision, 'runId': 'unknown'}],
        [{**decision, 'errorCategory': None}], [{**decision, 'verdict': 'correct'}],
        [{**decision, 'verdict': 'uncertain'}], [{**decision, 'errorCategory': 'other'}],
        [{**decision, 'sourceText': 'PRIVATE'}], {'not': 'a list'},
    ]
    for index, data in enumerate(invalid):
        decisions.write_text(json.dumps(data))
        target = tmp_path / f'invalid-{index}.json'
        assert review_queue.main([*args[:-1], str(target)]) == 2
        assert not target.exists() and not target.with_suffix('.md').exists()
    decisions.write_text(json.dumps([{**decision, 'verdict': verdict, 'errorCategory': None,
                                    'threadId': f'thread-{i}', 'runId': f'run-{i}'}
                                   for i, verdict in enumerate(['correct', 'uncertain'])]))
    assert review_queue.main([*args[:-1], str(tmp_path / 'accepted.json')]) == 0
    assert json.loads(output.read_text()) == report  # Never overwrite the first report.
